// Cobertura de segurança de fn_criar_nota_entrada (GRANT/REVOKE), separada de
// notas-entrada-controle-acesso.test.mjs (comportamento funcional/gate de
// papel Express — não toca privilégio de banco). Mesmo achado das PRs #77
// (fn_sincronizar_baixa_legado) e #79 (fn_baixar_titulo e RPCs de estorno):
// Supabase concede EXECUTE em toda function nova de public a PUBLIC por
// padrão, e PostgREST expõe isso pra anon/authenticated salvo REVOKE
// explícito. Corrigido em
// 20260101000066_notas_entrada_fn_criar_revoga_execute_publico.sql.
//
// O client admin local (pgCompatClient, via src/lib/supabase-admin.server.js)
// sempre conecta como PG_USER=postgres (superuser) — superuser ignora ACL,
// então testes funcionais continuam passando mesmo depois do REVOKE, sem
// provar nada sobre privilégio. Este arquivo usa `pg` direto (Client próprio)
// + `SET ROLE` dentro de uma transação (postgres pode assumir qualquer role
// sem senha) pra rodar a chamada de fato SOB o papel anon/authenticated/
// service_role e confirmar o erro/sucesso real de permissão.
//
// CLUSTER EXCLUSIVO OBRIGATÓRIO — mesma guarda de
// estornos-financeiros-grants.test.mjs (ver scripts/tests/unit/README.md):
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
    `notas-entrada-fn-criar-grants.test.mjs recusa rodar contra o cluster Postgres padrão/compartilhado ` +
    `(porta=${PG_PORT}, banco=${PG_DATABASE}). Exporte LOCAL_PG_PORT/LOCAL_PG_DATABASE (e LOCAL_PG_DATA/LOCAL_PG_LOG) ` +
    `com valores exclusivos antes de rodar db:local:start/db:local:reset e este teste — ver scripts/tests/unit/README.md.`
  )
}

const { supabase } = await import('../../../src/lib/supabase-admin.server.js')

let idUsuario
const produtosCriados = []
const notasCriadas = []

async function criarProduto(nome) {
  const { data, error } = await supabase.from('produtos').insert({ nome, preco_custo: 10 }).select('id').single()
  if (error) throw error
  produtosCriados.push(data.id)
  return data.id
}

function payloadNota(numeroNota, produtoId) {
  return {
    numero_nota: numeroNota,
    fornecedor_nome: 'Fornecedor Teste Grants NEA',
    data_emissao: '2026-09-01',
    valor_total: 10,
    gerar_conta_pagar: false,
    itens: [{ produto_id: produtoId, quantidade: 1, valor_unitario: 10, atualizar_custo: false }],
  }
}

// Client dedicado (fora do pgCompatClient) só pra este teste — sempre
// autentica como PG_USER (postgres/superuser); o SET ROLE dentro de cada
// transação é que efetivamente troca o papel sob teste.
const clientRaw = new pg.Client({
  host: '127.0.0.1', port: Number(PG_PORT), database: PG_DATABASE, user: PG_USER, password: PG_PASSWORD,
})
await clientRaw.connect()

async function chamarComoRole(role, payload) {
  await clientRaw.query('BEGIN')
  try {
    await clientRaw.query(`SET ROLE ${role}`)
    const res = await clientRaw.query('SELECT public.fn_criar_nota_entrada($1::jsonb) AS resultado', [JSON.stringify(payload)])
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
  const { data, error } = await supabase.from('usuarios')
    .insert({ nome: 'usuario (teste nefg)', email: `nefg-${sufixo}@teste-nefg.local`, role: 'admin', ativo: true })
    .select('id').single()
  if (error) throw error
  idUsuario = data.id
})

after(async () => {
  await clientRaw.end()
  if (notasCriadas.length) {
    await supabase.from('movimentacoes_estoque').delete().in('documento_ref', notasCriadas)
    await supabase.from('notas_entrada_itens').delete().in('nota_entrada_id',
      (await supabase.from('notas_entrada').select('id').in('numero_nota', notasCriadas)).data?.map((n) => n.id) || [])
    await supabase.from('notas_entrada').delete().in('numero_nota', notasCriadas)
  }
  if (produtosCriados.length) await supabase.from('produtos').delete().in('id', produtosCriados)
  await supabase.from('usuarios').delete().eq('id', idUsuario)
})

test('fn_criar_nota_entrada — GRANT/REVOKE', async (t) => {
  await t.test('anon e authenticated não têm EXECUTE — chamada direta via PostgREST (simulada por SET ROLE) é recusada (42501)', async () => {
    const produtoId = await criarProduto('TESTE GRANTS NEA - Produto A')
    for (const role of ['anon', 'authenticated']) {
      const r = await chamarComoRole(role, payloadNota(`NEFG-${role}-${Date.now()}`, produtoId))
      assert.equal(r.ok, false, `${role} NUNCA pode conseguir chamar fn_criar_nota_entrada direto`)
      assert.equal(r.erro?.code, '42501', `esperava insufficient_privilege (42501); recebeu: ${r.erro?.code} — ${r.erro?.message}`)
    }
  })

  await t.test('service_role tem EXECUTE — chamada completa com sucesso', async () => {
    const produtoId = await criarProduto('TESTE GRANTS NEA - Produto B')
    const numeroNota = `NEFG-SERVICE-ROLE-${Date.now()}`
    const r = await chamarComoRole('service_role', payloadNota(numeroNota, produtoId))
    assert.equal(r.ok, true, `service_role precisa continuar funcionando — erro: ${r.erro?.code} ${r.erro?.message}`)
    assert.ok(r.resultado?.id, 'resultado precisa conter o id da nota criada')

    // A chamada acima rodou dentro de transação com ROLLBACK, não persistiu
    // de verdade — refaz via client admin real (postgres, sem SET ROLE) pra
    // confirmar que service_role teria permissão numa chamada real.
    const payload = payloadNota(numeroNota, produtoId)
    payload.usuario_id = idUsuario
    const { data, error } = await supabase.rpc('fn_criar_nota_entrada', { p_payload: payload })
    assert.equal(error, null, JSON.stringify(error))
    assert.ok(data?.id)
    notasCriadas.push(numeroNota)
  })
})
