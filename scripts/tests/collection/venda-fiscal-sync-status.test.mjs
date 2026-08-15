// Status de frescor do sync fiscal (vendaFiscalSyncStatus.js) — decisão pura
// (disponivel/reason), contra o CÓDIGO REAL e Postgres local. Mesmo racional
// de financial-sync-guard.test.mjs, adaptado pro indicador "VENDAS DO MÊS".
import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste } from './_setup.mjs'

let supabase, verificarStatusSyncFiscal

before(async () => {
  await iniciarAmbienteDeTeste()
  ;({ supabase } = await import('../../../src/lib/supabase-admin.server.js'))
  ;({ verificarStatusSyncFiscal } = await import('../../../src/lib/vendaFiscalSyncStatus.js'))
})
after(async () => { await pararAmbienteDeTeste() })

async function limparSincronizacoes() {
  await supabase.from('sincronizacoes_fiscal').delete().eq('dry_run', false)
}

async function inserirSync({ status = 'concluido', minutosAtras = 1, totalComErro = 0, semConcluidoEm = false }) {
  const concluidoEm = new Date(Date.now() - minutosAtras * 60000).toISOString()
  const { error } = await supabase.from('sincronizacoes_fiscal').insert({
    status, dry_run: false, iniciado_em: concluidoEm,
    concluido_em: semConcluidoEm ? null : concluidoEm,
    total_lido: 1, total_criado: 0, total_atualizado: 0, total_com_erro: totalComErro,
  })
  if (error) throw error
}

beforeEach(async () => {
  await limparSincronizacoes()
  delete process.env.VENDAS_FISCAIS_SYNC_MAX_ATRASO_MIN
})

test('1. sync fresco e sem erro -> disponivel', async () => {
  await inserirSync({ minutosAtras: 5 })
  const r = await verificarStatusSyncFiscal()
  assert.equal(r.disponivel, true)
  assert.equal(r.reason, null)
  assert.equal(r.age_minutes, 5)
})

test('2. nunca sincronizou (tabela vazia) -> indisponivel', async () => {
  const r = await verificarStatusSyncFiscal()
  assert.equal(r.disponivel, false)
  assert.equal(r.reason, 'nunca_sincronizou')
})

test('3. sync velho (>1440min default) -> indisponivel (desatualizado)', async () => {
  await inserirSync({ minutosAtras: 1500 })
  const r = await verificarStatusSyncFiscal()
  assert.equal(r.disponivel, false)
  assert.equal(r.reason, 'sync_desatualizado')
  assert.equal(r.age_minutes, 1500)
})

test('4. último ciclo falhou/em andamento/com erros -> indisponivel', async () => {
  await inserirSync({ status: 'falhou', minutosAtras: 2 })
  let r = await verificarStatusSyncFiscal()
  assert.equal(r.disponivel, false)
  assert.equal(r.reason, 'ultimo_sync_falhou')

  await limparSincronizacoes()
  await inserirSync({ status: 'executando', minutosAtras: 0, semConcluidoEm: true })
  r = await verificarStatusSyncFiscal()
  assert.equal(r.disponivel, false)
  assert.equal(r.reason, 'ultimo_sync_em_andamento')

  await limparSincronizacoes()
  await inserirSync({ status: 'concluido_com_erros', minutosAtras: 2, totalComErro: 3 })
  r = await verificarStatusSyncFiscal()
  assert.equal(r.disponivel, false)
  assert.equal(r.reason, 'ultimo_sync_com_erros')
})

test('5. consulta ao banco falha -> indisponivel (client injetado)', async () => {
  const clienteQuebrado = { from: () => ({ select: () => ({ eq: () => ({ order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'conexão recusada' } }) }) }) }) }) }) }
  const r = await verificarStatusSyncFiscal({ clienteSupabase: clienteQuebrado })
  assert.equal(r.disponivel, false)
  assert.equal(r.reason, 'erro_consulta_banco')
})

test('6. VENDAS_FISCAIS_SYNC_MAX_ATRASO_MIN inválido/ausente -> default seguro (1440)', async () => {
  await inserirSync({ minutosAtras: 1450 }) // > 1440 (default) mas seria "fresco" com um limite maior
  for (const valorInvalido of [undefined, '0', '-10', 'abc', '']) {
    if (valorInvalido === undefined) delete process.env.VENDAS_FISCAIS_SYNC_MAX_ATRASO_MIN
    else process.env.VENDAS_FISCAIS_SYNC_MAX_ATRASO_MIN = valorInvalido
    const r = await verificarStatusSyncFiscal()
    assert.equal(r.max_age_minutes, 1440, `valor "${valorInvalido}" deveria cair no default 1440`)
    assert.equal(r.disponivel, false, `1450min > 1440 default deveria marcar indisponível com max_atraso="${valorInvalido}"`)
  }
})

test('7. dry_run nunca conta -> mesmo com registro dry_run fresco, segue nunca_sincronizou', async () => {
  const { error } = await supabase.from('sincronizacoes_fiscal').insert({
    status: 'concluido', dry_run: true, iniciado_em: new Date().toISOString(), concluido_em: new Date().toISOString(),
    total_lido: 10, total_criado: 5, total_atualizado: 0, total_com_erro: 0,
  })
  if (error) throw error
  const r = await verificarStatusSyncFiscal()
  assert.equal(r.disponivel, false)
  assert.equal(r.reason, 'nunca_sincronizou')
})
