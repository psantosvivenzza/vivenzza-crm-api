// Guard de frescor — cenários 8-12 do pedido de 2026-08-14: os 3 caminhos
// reais de cobrança (cron/lote, manual individual) respeitam o guard;
// bloqueio nunca gera envio/dispatch nem altera financeiro. Contra o
// CÓDIGO REAL, Postgres local e Fake Evolution (nenhum WhatsApp de verdade).
//
// executarReguaCobranca() (cron/lote) só roda dentro da janela 08h-17h BRT
// (regra de negócio pré-existente, não redesenhada aqui) — os testes que
// dependem dela pulam com t.skip() fora da janela, em vez de falhar por um
// motivo que não tem nada a ver com o guard de sync sendo testado.
import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste, criarContaDeTeste } from './_setup.mjs'

let supabase, executarReguaCobranca, _resetCacheParaTeste, fakeEvolution

before(async () => {
  fakeEvolution = await iniciarAmbienteDeTeste()
  ;({ supabase } = await import('../../../src/lib/supabase-admin.server.js'))
  ;({ executarReguaCobranca } = await import('../../../src/jobs/cobranca-whatsapp.js'))
  ;({ _resetCacheParaTeste } = await import('../../../src/lib/collection/financialSyncGuard.js'))
})
after(async () => { await pararAmbienteDeTeste() })

function dentroDaJanelaAgoraBrt() {
  const horaBrt = (new Date().getUTCHours() - 3 + 24) % 24
  return horaBrt >= 8 && horaBrt < 17
}

async function limparSincronizacoes() {
  await supabase.from('sincronizacoes_financeiro').delete().eq('dry_run', false)
}
async function inserirSyncStale() {
  const velho = new Date(Date.now() - 999 * 60000).toISOString()
  await supabase.from('sincronizacoes_financeiro').insert({
    status: 'concluido', dry_run: false, iniciado_em: velho, concluido_em: velho,
    total_lido: 1, total_atualizado: 0, total_sem_alteracao: 0, total_sem_match: 0,
    total_conflito: 0, total_cancelado: 0, total_com_erro: 0,
  })
}
async function inserirSyncFresco() {
  const agora = new Date().toISOString()
  await supabase.from('sincronizacoes_financeiro').insert({
    status: 'concluido', dry_run: false, iniciado_em: agora, concluido_em: agora,
    total_lido: 1, total_atualizado: 0, total_sem_alteracao: 0, total_sem_match: 0,
    total_conflito: 0, total_cancelado: 0, total_com_erro: 0,
  })
}
async function ligarCobranca() {
  await supabase.from('automacoes_config').update({ cobranca_whatsapp_ativa: true }).eq('id', 1)
}
async function desligarCobranca() {
  await supabase.from('automacoes_config').update({ cobranca_whatsapp_ativa: false }).eq('id', 1)
}

beforeEach(async () => {
  await limparSincronizacoes()
  _resetCacheParaTeste()
  delete process.env.COBRANCA_EXIGE_SYNC
  delete process.env.COBRANCA_SYNC_MAX_ATRASO_MIN
  fakeEvolution.resetar()
  await ligarCobranca()
})

test('8. cobrança automática (cron) respeita o guard — sync stale bloqueia o lote inteiro', async (t) => {
  if (!dentroDaJanelaAgoraBrt()) { t.skip('fora da janela 08h-17h BRT — dentroDoHorarioPermitido() bloquearia antes do guard de sync ser alcançado, não é o que este teste mede'); return }
  await inserirSyncStale()
  const conta = await criarContaDeTeste(supabase, { vencimento: new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10) })

  const resumo = await executarReguaCobranca()

  assert.equal(resumo.paradoPor, 'sync_stale')
  assert.equal(resumo.enviadas, 0)

  const { data: cobrancas } = await supabase.from('cobrancas_whatsapp').select('id').eq('contas_financeiras_id', conta.id)
  assert.equal(cobrancas.length, 0)
  assert.equal(fakeEvolution.mensagensEnviadas.length, 0)
})

test('9. disparo manual em lote (mesma executarReguaCobranca usada por POST /api/cobrancas/disparar) respeita o guard', async (t) => {
  if (!dentroDaJanelaAgoraBrt()) { t.skip('fora da janela 08h-17h BRT'); return }
  await inserirSyncStale()
  const conta = await criarContaDeTeste(supabase, { vencimento: new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10) })

  // POST /api/cobrancas/disparar chama executarReguaCobranca() diretamente
  // (ver src/routes/cobrancas.js) — mesma função, mesmo gate.
  const resumo = await executarReguaCobranca()
  assert.equal(resumo.paradoPor, 'sync_stale')

  const { data: cobrancas } = await supabase.from('cobrancas_whatsapp').select('id').eq('contas_financeiras_id', conta.id)
  assert.equal(cobrancas.length, 0)
})

test('10. disparo individual (POST /api/cobrancas/disparar-individual/:pessoaNome) respeita o guard', async () => {
  await inserirSyncStale()
  process.env.API_SECRET_KEY = 'chave-teste-sync-guard'
  const express = (await import('express')).default
  const { auth, adminOnly } = await import('../../../src/middleware/auth.js')
  const cobrancasRouter = (await import('../../../src/routes/cobrancas.js')).default

  const app = express()
  app.use(express.json())
  app.use('/api/cobrancas', auth, adminOnly, cobrancasRouter)
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  const porta = server.address().port

  const conta = await criarContaDeTeste(supabase, {
    pessoa_nome: 'Cliente Teste Guard Individual',
    vencimento: new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10),
  })

  const resultado = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: porta, method: 'POST',
      path: `/api/cobrancas/disparar-individual/${encodeURIComponent('Cliente Teste Guard Individual')}`,
      headers: { authorization: 'Bearer chave-teste-sync-guard', 'content-type': 'application/json' },
    }, (res) => {
      let chunks = ''
      res.on('data', (c) => { chunks += c })
      res.on('end', () => resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null }))
    })
    req.on('error', reject)
    req.end()
  })
  server.close()

  assert.equal(resultado.status, 400, 'bloqueio por sync stale deve responder 400, nunca 201')
  assert.match(resultado.body.erro, /Sincroniza|sync/i)

  const { data: cobrancas } = await supabase.from('cobrancas_whatsapp').select('id').eq('contas_financeiras_id', conta.id)
  assert.equal(cobrancas.length, 0)
  assert.equal(fakeEvolution.mensagensEnviadas.length, 0)
})

test('11. bloqueio nunca gera dispatch/envio real (Fake Evolution não recebe nenhuma requisição)', async (t) => {
  if (!dentroDaJanelaAgoraBrt()) { t.skip('fora da janela 08h-17h BRT'); return }
  await inserirSyncStale()
  await criarContaDeTeste(supabase, { vencimento: new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10) })

  await executarReguaCobranca()

  assert.equal(fakeEvolution.mensagensEnviadas.length, 0, 'Fake Evolution não deveria ter recebido nenhum envio')
})

test('12. bloqueio nunca altera dados financeiros da conta', async (t) => {
  if (!dentroDaJanelaAgoraBrt()) { t.skip('fora da janela 08h-17h BRT'); return }
  await inserirSyncStale()
  const conta = await criarContaDeTeste(supabase, {
    valor: 500, valor_pago: 0, status: 'vencida',
    vencimento: new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10),
  })

  await executarReguaCobranca()

  const { data: depois } = await supabase.from('contas_financeiras').select('valor, valor_pago, status, em_revisao_financeira').eq('id', conta.id).single()
  assert.equal(Number(depois.valor), 500)
  assert.equal(Number(depois.valor_pago), 0)
  assert.equal(depois.status, 'vencida')
  assert.equal(depois.em_revisao_financeira, false)
})

test('controle: com sync fresco, o ponto central de envio (enviarCobrancaComRoteamento) ENVIA normalmente — prova que o guard não está sempre bloqueando', async () => {
  // Testa enviarCobrancaComRoteamento() diretamente (o ponto único
  // compartilhado por cron/lote/individual — ver collectionRouting.js) em
  // vez de rodar executarReguaCobranca() inteira: a régua varre TODA
  // contas_financeiras, incluindo contas sintéticas de seed.sql usadas por
  // outros testes (promessas etc.) — rodá-la aqui enviaria pra várias
  // contas alheias e ficaria lento (45-90s de intervalo por envio, real,
  // proposital). O ponto de decisão do guard é o mesmo nos dois casos.
  await inserirSyncFresco()
  const { enviarCobrancaComRoteamento } = await import('../../../src/lib/collection/collectionRouting.js')
  const conta = await criarContaDeTeste(supabase, { vencimento: new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10) })

  const resultado = await enviarCobrancaComRoteamento({
    contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
    clienteTelefone: conta.telefone_cobranca, valor: 500, mensagem: 'mensagem de teste — guard fresco', origem: 'cron',
  })

  assert.equal(resultado.status, 'sent')
  assert.equal(fakeEvolution.mensagensEnviadas.some((m) => m.numero === conta.telefone_cobranca), true)

  await desligarCobranca()
})
