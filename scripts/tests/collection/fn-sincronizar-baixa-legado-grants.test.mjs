// Cobertura de segurança de fn_sincronizar_baixa_legado (GRANT/REVOKE),
// separada de fn-sincronizar-baixa-legado.test.mjs (comportamento funcional
// — corpo fiel, sem tocar privilégios). Achado real (2026-09-11, confirmado
// via painel do Supabase): a function tinha EXECUTE concedido a PUBLIC,
// anon, authenticated, postgres e service_role — qualquer JWT válido (ou
// até sem login, com a chave anon) podia chamá-la direto via PostgREST,
// contornando o gate adminOuFinanceiro do Express. Corrigido em
// 20260101000056_fn_sincronizar_baixa_legado_revoga_execute_publico.sql.
//
// O client admin local (pgCompatClient, via src/lib/supabase-admin.server.js)
// sempre conecta como PG_USER=postgres (superuser) — superuser ignora ACL,
// então os testes funcionais em fn-sincronizar-baixa-legado.test.mjs
// continuam passando mesmo depois do REVOKE, sem provar nada sobre
// privilégio. Este arquivo usa `pg` direto (Client próprio) + `SET ROLE`
// dentro de uma transação (postgres pode assumir qualquer role sem senha)
// pra rodar a chamada de fato SOB o papel anon/authenticated/service_role e
// confirmar o erro/sucesso real de permissão.
//
// CLUSTER EXCLUSIVO OBRIGATÓRIO — mesma guarda de
// fn-sincronizar-baixa-legado.test.mjs (ver scripts/tests/unit/README.md):
// recusa rodar contra porta 5432/5433 ou banco vivenzza_dev/postgres.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { PG_USER, PG_PASSWORD, PG_PORT, PG_DATABASE } from '../../localdb-config.mjs'
process.env.NODE_ENV = 'test'
process.env.LOCAL_PG_URL = `postgres://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${PG_DATABASE}`

const PORTAS_COMPARTILHADAS_PROIBIDAS = new Set(['5432', '5433'])
const BANCOS_COMPARTILHADOS_PROIBIDOS = new Set(['vivenzza_dev', 'postgres'])
if (PORTAS_COMPARTILHADAS_PROIBIDAS.has(String(PG_PORT)) || BANCOS_COMPARTILHADOS_PROIBIDOS.has(PG_DATABASE)) {
  throw new Error(
    `fn-sincronizar-baixa-legado-grants.test.mjs recusa rodar contra o cluster Postgres padrão/compartilhado ` +
    `(porta=${PG_PORT}, banco=${PG_DATABASE}). Exporte LOCAL_PG_PORT/LOCAL_PG_DATABASE (e LOCAL_PG_DATA/LOCAL_PG_LOG) ` +
    `com valores exclusivos antes de rodar db:local:start/db:local:reset e este teste — ver scripts/tests/unit/README.md.`
  )
}

const { supabase } = await import('../../../src/lib/supabase-admin.server.js')
const { criarContaDeTeste, telefoneDeTeste } = await import('./_setup.mjs')

const contasCriadas = []

async function criarConta996(overrides = {}) {
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

async function chamarComoRole(role, params) {
  await clientRaw.query('BEGIN')
  try {
    await clientRaw.query(`SET ROLE ${role}`)
    const res = await clientRaw.query(
      `SELECT public.fn_sincronizar_baixa_legado(
         p_conta_id := $1, p_valor_pago_legado := $2, p_data_pagamento := $3,
         p_referencia := $4, p_cancelado_no_legado := $5, p_encerrado_no_legado := $6
       ) AS resultado`,
      [params.conta_id, params.valor_pago_legado, params.data_pagamento, params.referencia ?? null, params.cancelado ?? false, params.encerrado ?? false]
    )
    return { ok: true, resultado: res.rows[0]?.resultado, erro: null }
  } catch (err) {
    return { ok: false, resultado: null, erro: err }
  } finally {
    // ROLLBACK também desfaz o SET ROLE da transação — nunca deixa a sessão
    // presa num papel sem privilégio pra rodar o cleanup depois.
    await clientRaw.query('ROLLBACK')
  }
}

after(async () => {
  await clientRaw.end()
  if (!contasCriadas.length) return
  const { error: erroBaixas } = await supabase.from('baixas_financeiras').delete().in('conta_financeira_id', contasCriadas)
  if (erroBaixas) throw new Error(`cleanup falhou ao apagar baixas_financeiras de teste: ${erroBaixas.message}`)
  const { error: erroContas } = await supabase.from('contas_financeiras').delete().in('id', contasCriadas)
  if (erroContas) throw new Error(`cleanup falhou ao apagar contas_financeiras de teste: ${erroContas.message}`)
})

test('fn_sincronizar_baixa_legado — GRANT/REVOKE', async (t) => {
  await t.test('1. anon não tem EXECUTE — chamada direta via PostgREST (simulada por SET ROLE) é recusada (42501)', async () => {
    const conta = await criarConta996({ valor: 500, valor_pago: 0, status: 'aberta', vencimento: '2026-12-01' })
    const r = await chamarComoRole('anon', { conta_id: conta.id, valor_pago_legado: 500, data_pagamento: '2026-09-01' })
    assert.equal(r.ok, false, 'anon NUNCA pode conseguir chamar esta RPC direto')
    assert.equal(r.erro?.code, '42501', `esperava insufficient_privilege (42501); recebeu: ${r.erro?.code} — ${r.erro?.message}`)
  })

  await t.test('2. authenticated não tem EXECUTE — mesma recusa (42501)', async () => {
    const conta = await criarConta996({ valor: 500, valor_pago: 0, status: 'aberta', vencimento: '2026-12-01' })
    const r = await chamarComoRole('authenticated', { conta_id: conta.id, valor_pago_legado: 500, data_pagamento: '2026-09-01' })
    assert.equal(r.ok, false, 'authenticated (qualquer usuário logado no Supabase) NUNCA pode conseguir chamar esta RPC direto')
    assert.equal(r.erro?.code, '42501', `esperava insufficient_privilege (42501); recebeu: ${r.erro?.code} — ${r.erro?.message}`)
  })

  await t.test('3. service_role tem EXECUTE — chamada completa com sucesso (é o papel real usado por supabase-admin.server.js)', async () => {
    const conta = await criarConta996({ valor: 500, valor_pago: 0, status: 'aberta', vencimento: '2026-12-01' })
    const r = await chamarComoRole('service_role', { conta_id: conta.id, valor_pago_legado: 500, data_pagamento: '2026-09-01' })
    assert.equal(r.ok, true, `service_role precisa continuar funcionando — erro: ${r.erro?.code} ${r.erro?.message}`)
    assert.equal(r.resultado?.acao, 'criada')
    assert.equal(r.resultado?.status, 'paga')

    // A chamada acima rodou dentro de uma transação com ROLLBACK (para nunca
    // deixar a sessão raw presa num papel) — ou seja, não persistiu de
    // verdade. Prova isso explicitamente (e não só documenta): refaz a MESMA
    // chamada via o client admin real (postgres, sem SET ROLE/ROLLBACK) pra
    // confirmar que service_role de fato teria permissão numa chamada real,
    // sem depender de um side effect do helper de teste.
    const { data, error } = await supabase.rpc('fn_sincronizar_baixa_legado', {
      p_conta_id: conta.id, p_valor_pago_legado: 500, p_data_pagamento: '2026-09-01',
      p_referencia: null, p_cancelado_no_legado: false, p_encerrado_no_legado: false,
    })
    assert.equal(error, null, JSON.stringify(error))
    assert.equal(data.acao, 'criada')
  })
})
