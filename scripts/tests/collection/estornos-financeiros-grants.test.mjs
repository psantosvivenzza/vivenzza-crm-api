// Cobertura de segurança de fn_baixar_titulo/fn_estornar_baixa/
// fn_aprovar_estorno/fn_rejeitar_estorno (GRANT/REVOKE), separada de
// financeiro-controle-acesso.test.mjs (comportamento funcional/gate de
// papel Express — não toca privilégio de banco). Mesmo achado da PR #77 pra
// fn_sincronizar_baixa_legado: Supabase concede EXECUTE em toda function nova
// de public a PUBLIC por padrão, e PostgREST expõe isso pra anon/authenticated
// salvo REVOKE explícito. Corrigido em
// 20260101000062_estornos_financeiros_rpcs_revoga_execute_publico.sql.
//
// O client admin local (pgCompatClient, via src/lib/supabase-admin.server.js)
// sempre conecta como PG_USER=postgres (superuser) — superuser ignora ACL,
// então os testes funcionais em financeiro-controle-acesso.test.mjs continuam
// passando mesmo depois do REVOKE, sem provar nada sobre privilégio. Este
// arquivo usa `pg` direto (Client próprio) + `SET ROLE` dentro de uma
// transação (postgres pode assumir qualquer role sem senha) pra rodar a
// chamada de fato SOB o papel anon/authenticated/service_role e confirmar o
// erro/sucesso real de permissão.
//
// CLUSTER EXCLUSIVO OBRIGATÓRIO — mesma guarda de
// fn-sincronizar-baixa-legado-grants.test.mjs (ver scripts/tests/unit/README.md):
// recusa rodar contra porta 5432/5433 ou banco vivenzza_dev/postgres.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { PG_USER, PG_PASSWORD, PG_PORT, PG_DATABASE } from '../../localdb-config.mjs'
process.env.NODE_ENV = 'test'
process.env.LOCAL_PG_URL = `postgres://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${PG_DATABASE}`

const PORTAS_COMPARTILHADAS_PROIBIDAS = new Set(['5432', '5433'])
const BANCOS_COMPARTILHADOS_PROIBIDOS = new Set(['vivenzza_dev', 'postgres'])
if (PORTAS_COMPARTILHADAS_PROIBIDAS.has(String(PG_PORT)) || BANCOS_COMPARTILHADOS_PROIBIDOS.has(PG_DATABASE)) {
  throw new Error(
    `estornos-financeiros-grants.test.mjs recusa rodar contra o cluster Postgres padrão/compartilhado ` +
    `(porta=${PG_PORT}, banco=${PG_DATABASE}). Exporte LOCAL_PG_PORT/LOCAL_PG_DATABASE (e LOCAL_PG_DATA/LOCAL_PG_LOG) ` +
    `com valores exclusivos antes de rodar db:local:start/db:local:reset e este teste — ver scripts/tests/unit/README.md.`
  )
}

const { supabase } = await import('../../../src/lib/supabase-admin.server.js')
const { criarContaDeTeste, telefoneDeTeste } = await import('./_setup.mjs')

let idSolicitante, idAprovador
const contasCriadas = []

async function criarConta(overrides = {}) {
  const conta = await criarContaDeTeste(supabase, {
    codigo_cliente: null,
    telefone_cobranca: telefoneDeTeste(),
    ...overrides,
  })
  contasCriadas.push(conta.id)
  return conta
}

// Client dedicado (fora do pgCompatClient) só pra este teste — sempre
// autentica como PG_USER (postgres/superuser); o SET ROLE dentro de cada
// transação é que efetivamente troca o papel sob teste.
const clientRaw = new pg.Client({
  host: '127.0.0.1', port: Number(PG_PORT), database: PG_DATABASE, user: PG_USER, password: PG_PASSWORD,
})
await clientRaw.connect()

async function chamarComoRole(role, fn, { placeholders, valores }) {
  await clientRaw.query('BEGIN')
  try {
    await clientRaw.query(`SET ROLE ${role}`)
    const res = await clientRaw.query(`SELECT public.${fn}(${placeholders}) AS resultado`, valores)
    return { ok: true, resultado: res.rows[0]?.resultado, erro: null }
  } catch (err) {
    return { ok: false, resultado: null, erro: err }
  } finally {
    // ROLLBACK também desfaz o SET ROLE da transação — nunca deixa a sessão
    // presa num papel sem privilégio pra rodar o cleanup depois.
    await clientRaw.query('ROLLBACK')
  }
}

before(async () => {
  const sufixo = Date.now()
  async function criarUsuario(rotulo) {
    const { data, error } = await supabase.from('usuarios')
      .insert({ nome: `${rotulo} (teste efg)`, email: `${rotulo}-${sufixo}@teste-efg.local`, role: 'financeiro', ativo: true })
      .select('id').single()
    if (error) throw error
    return data.id
  }
  idSolicitante = await criarUsuario('solicitante')
  idAprovador = await criarUsuario('aprovador')
})

after(async () => {
  await clientRaw.end()
  if (contasCriadas.length) {
    await supabase.from('estornos_financeiros').delete().in('conta_financeira_id', contasCriadas)
    await supabase.from('baixas_financeiras').delete().in('conta_financeira_id', contasCriadas)
    const { error } = await supabase.from('contas_financeiras').delete().in('id', contasCriadas)
    if (error) throw new Error(`cleanup falhou ao apagar contas_financeiras de teste: ${error.message}`)
  }
  await supabase.from('usuarios').delete().in('id', [idSolicitante, idAprovador])
})

test('fn_baixar_titulo — GRANT/REVOKE', async (t) => {
  await t.test('anon e authenticated não têm EXECUTE — chamada direta via PostgREST (simulada por SET ROLE) é recusada (42501)', async () => {
    const conta = await criarConta({ valor: 500, valor_pago: 0, status: 'aberta', vencimento: '2026-12-01' })
    for (const role of ['anon', 'authenticated']) {
      const r = await chamarComoRole(role, 'fn_baixar_titulo', {
        placeholders: '$1, $2, $3, $4, $5, $6',
        valores: [conta.id, 100, '2026-09-01', 'pix', 'teste grants', idSolicitante],
      })
      assert.equal(r.ok, false, `${role} NUNCA pode conseguir chamar fn_baixar_titulo direto`)
      assert.equal(r.erro?.code, '42501', `esperava insufficient_privilege (42501); recebeu: ${r.erro?.code} — ${r.erro?.message}`)
    }
  })

  await t.test('service_role tem EXECUTE — chamada completa com sucesso', async () => {
    const conta = await criarConta({ valor: 500, valor_pago: 0, status: 'aberta', vencimento: '2026-12-01' })
    const r = await chamarComoRole('service_role', 'fn_baixar_titulo', {
      placeholders: '$1, $2, $3, $4, $5, $6',
      valores: [conta.id, 100, '2026-09-01', 'pix', 'teste grants', idSolicitante],
    })
    assert.equal(r.ok, true, `service_role precisa continuar funcionando — erro: ${r.erro?.code} ${r.erro?.message}`)
    assert.equal(r.resultado?.status, 'pago_parcial')

    // Confirma via o client admin real (postgres, sem SET ROLE/ROLLBACK) que
    // service_role teria permissão numa chamada real persistida — a chamada
    // acima rodou dentro de transação com ROLLBACK, não persistiu de verdade.
    const { data, error } = await supabase.rpc('fn_baixar_titulo', {
      p_conta_id: conta.id, p_valor: 100, p_data_pagamento: '2026-09-01',
      p_forma_pagamento: 'pix', p_observacao: 'teste grants real', p_usuario_id: idSolicitante,
    })
    assert.equal(error, null, JSON.stringify(error))
    assert.equal(data.status, 'pago_parcial')
  })
})

test('fn_estornar_baixa / fn_aprovar_estorno / fn_rejeitar_estorno — GRANT/REVOKE', async (t) => {
  await t.test('anon e authenticated não têm EXECUTE em nenhuma das 3 (42501)', async () => {
    const conta = await criarConta({ valor: 200, valor_pago: 0, status: 'aberta', vencimento: '2026-12-01' })
    const { data: baixa, error } = await supabase.rpc('fn_baixar_titulo', {
      p_conta_id: conta.id, p_valor: 200, p_data_pagamento: '2026-09-01',
      p_forma_pagamento: 'pix', p_observacao: 'setup grants estorno', p_usuario_id: idSolicitante,
    })
    assert.equal(error, null, JSON.stringify(error))
    const baixaId = baixa.baixa_id

    for (const role of ['anon', 'authenticated']) {
      const rEstornar = await chamarComoRole(role, 'fn_estornar_baixa', {
        placeholders: '$1, $2, $3, $4, $5',
        valores: [baixaId, idSolicitante, 'valor_incorreto', 'teste grants', 50],
      })
      assert.equal(rEstornar.ok, false, `${role} não pode chamar fn_estornar_baixa direto`)
      assert.equal(rEstornar.erro?.code, '42501')

      const idInexistente = '00000000-0000-0000-0000-000000000000'
      const rAprovar = await chamarComoRole(role, 'fn_aprovar_estorno', { placeholders: '$1, $2', valores: [idInexistente, idAprovador] })
      assert.equal(rAprovar.ok, false, `${role} não pode chamar fn_aprovar_estorno direto`)
      assert.equal(rAprovar.erro?.code, '42501')

      const rRejeitar = await chamarComoRole(role, 'fn_rejeitar_estorno', { placeholders: '$1, $2, $3', valores: [idInexistente, idAprovador, 'motivo'] })
      assert.equal(rRejeitar.ok, false, `${role} não pode chamar fn_rejeitar_estorno direto`)
      assert.equal(rRejeitar.erro?.code, '42501')
    }
  })

  await t.test('service_role tem EXECUTE nas 3 — fluxo completo solicitar → aprovar', async () => {
    const conta = await criarConta({ valor: 300, valor_pago: 0, status: 'aberta', vencimento: '2026-12-01' })
    const { data: baixa, error: erroBaixa } = await supabase.rpc('fn_baixar_titulo', {
      p_conta_id: conta.id, p_valor: 300, p_data_pagamento: '2026-09-01',
      p_forma_pagamento: 'pix', p_observacao: 'setup grants estorno 2', p_usuario_id: idSolicitante,
    })
    assert.equal(erroBaixa, null, JSON.stringify(erroBaixa))

    const rSolicitar = await chamarComoRole('service_role', 'fn_estornar_baixa', {
      placeholders: '$1, $2, $3, $4, $5',
      valores: [baixa.baixa_id, idSolicitante, 'valor_incorreto', 'teste grants service_role', 50],
    })
    assert.equal(rSolicitar.ok, true, `service_role precisa continuar funcionando — erro: ${rSolicitar.erro?.code} ${rSolicitar.erro?.message}`)
    assert.equal(rSolicitar.resultado?.status, 'pendente_aprovacao', '300 > limite 50 usado no teste')

    // A chamada acima rodou com ROLLBACK — refaz via client admin real
    // (persiste de verdade) pra poder encadear aprovar/rejeitar de verdade.
    const { data: estorno, error: erroEstorno } = await supabase.rpc('fn_estornar_baixa', {
      p_baixa_id: baixa.baixa_id, p_usuario_id: idSolicitante, p_motivo_categoria: 'valor_incorreto',
      p_motivo_detalhado: 'teste grants persistido', p_limite_sem_aprovacao: 50,
    })
    assert.equal(erroEstorno, null, JSON.stringify(erroEstorno))
    assert.equal(estorno.status, 'pendente_aprovacao')

    const rAprovar = await chamarComoRole('service_role', 'fn_aprovar_estorno', {
      placeholders: '$1, $2', valores: [estorno.estorno_id, idAprovador], // aprovador != solicitante — exigido pela RPC
    })
    assert.equal(rAprovar.ok, true, `service_role precisa continuar funcionando — erro: ${rAprovar.erro?.code} ${rAprovar.erro?.message}`)
    assert.equal(rAprovar.resultado?.status, 'concluido')
  })
})
