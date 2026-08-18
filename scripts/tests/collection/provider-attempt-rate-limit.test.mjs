// 2026-08-18 — 19 cenários do pedido "RATE LIMIT DE TENTATIVAS REAIS AO
// PROVIDER". Gap comprovado na auditoria anterior (correção "telefone
// inválido com múltiplos títulos", PR #48): globalSendLimit.js/
// whatsappInstances.js/cobranca-whatsapp.js só contavam SUCESSO
// (cobrancas_whatsapp/status sent-delivered-read) — uma rajada de falhas
// reais (número inválido, timeout, 429...) nunca consumia nenhum teto,
// mesmo cada uma sendo uma chamada HTTP real contra o provedor.
//
// providerAttemptCounter.js fecha isso pro motor v2 (ativo em produção
// hoje), usando collection_dispatch_attempts como fonte canônica — 1 linha
// por chamada real, inserida ANTES da chamada acontecer. Contra Postgres
// local + Fake Evolution — nenhum WhatsApp real em nenhum cenário.
import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste, criarContaDeTeste, limparInstanciasDeTeste, telefoneDeTeste } from './_setup.mjs'

let supabase, fakeEvolution
let enviarCobrancaComRoteamento, enviarComFailover, invalidarCacheFlags
let verificarLimiteGlobalEnvio, contarEnviosReaisHojePorInstancia, contarTentativasReaisDesde
let estaEmDoNotContact, registrarPromessa, _resetCacheParaTeste

before(async () => {
  fakeEvolution = await iniciarAmbienteDeTeste()
  ;({ supabase } = await import('../../../src/lib/supabase-admin.server.js'))
  ;({ enviarCobrancaComRoteamento } = await import('../../../src/lib/collection/collectionRouting.js'))
  ;({ enviarComFailover } = await import('../../../src/lib/collection/dispatchEngine.js'))
  ;({ invalidarCacheFlags } = await import('../../../src/lib/collection/featureFlags.js'))
  ;({ verificarLimiteGlobalEnvio } = await import('../../../src/lib/collection/globalSendLimit.js'))
  ;({ contarEnviosReaisHojePorInstancia } = await import('../../../src/lib/collection/whatsappInstances.js'))
  ;({ contarTentativasReaisDesde } = await import('../../../src/lib/collection/providerAttemptCounter.js'))
  ;({ estaEmDoNotContact } = await import('../../../src/lib/collection/doNotContactGuard.js'))
  ;({ registrarPromessa } = await import('../../../src/lib/collection/promises.js'))
  ;({ _resetCacheParaTeste } = await import('../../../src/lib/collection/financialSyncGuard.js'))
})
after(async () => { await pararAmbienteDeTeste() })

async function criarInstancia(nome, overrides = {}) {
  const { data, error } = await supabase.from('whatsapp_instances').insert({
    name: nome, instance_name: nome, priority: 1, role: 'principal', enabled: true, ...overrides,
  }).select().single()
  if (error) throw error
  return data
}

async function garantirSyncFinanceiroFresco() {
  await supabase.from('sincronizacoes_financeiro').delete().eq('dry_run', false)
  const agora = new Date().toISOString()
  await supabase.from('sincronizacoes_financeiro').insert({
    status: 'concluido', dry_run: false, iniciado_em: agora, concluido_em: agora,
    total_lido: 1, total_atualizado: 0, total_sem_alteracao: 0, total_sem_match: 0,
    total_conflito: 0, total_cancelado: 0, total_com_erro: 0,
  })
}

function telefoneInvalidoDeTeste() {
  return `${telefoneDeTeste().slice(0, -3)}000`
}

function inicioDoDiaBrtISO() {
  const hojeBrt = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
  return `${hojeBrt}T03:00:00.000Z`
}

beforeEach(async () => {
  fakeEvolution.resetar()
  await limparInstanciasDeTeste(supabase)
  await supabase.from('collection_do_not_contact').delete().neq('id', '00000000-0000-0000-0000-000000000000')
  await supabase.from('cobrancas_whatsapp').delete().neq('id', '00000000-0000-0000-0000-000000000000')
  await garantirSyncFinanceiroFresco()
  await supabase.from('automacoes_config').update({
    multi_whatsapp: true, whatsapp_failover: false, cobranca_whatsapp_ativa: true,
    global_daily_limit: 30, global_hourly_limit: 10,
  }).eq('id', 1)
  invalidarCacheFlags()
  // financialSyncGuard tem seu próprio cache curto (independente do de
  // featureFlags.js) — sem resetar aqui, o teste 10 (que deliberadamente
  // deixa a sync stale) vazaria esse estado "bloqueado" pros testes
  // seguintes que rodam dentro da mesma janela de TTL.
  _resetCacheParaTeste()
})

test('1. sucesso conta 1 tentativa real', async () => {
  await criarInstancia('wa01-t1', { priority: 1 })
  fakeEvolution.controlarInstancia('wa01-t1', { comportamento: 'ok' })
  const antes = await contarTentativasReaisDesde({ desde: inicioDoDiaBrtISO() })

  const conta = await criarContaDeTeste(supabase)
  const resultado = await enviarComFailover({
    contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
    clienteTelefone: conta.telefone_cobranca, valor: 500, mensagem: 'sucesso', origem: 'cron',
  })
  assert.equal(resultado.status, 'sent')

  const depois = await contarTentativasReaisDesde({ desde: inicioDoDiaBrtISO() })
  assert.equal(depois - antes, 1)
})

test('2. número inválido conta 1 tentativa real', async () => {
  await criarInstancia('wa01-t2', { priority: 1 })
  const telefone = telefoneInvalidoDeTeste()
  const antes = await contarTentativasReaisDesde({ desde: inicioDoDiaBrtISO() })

  const conta = await criarContaDeTeste(supabase, { telefone_cobranca: telefone })
  const resultado = await enviarComFailover({
    contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
    clienteTelefone: telefone, valor: 500, mensagem: 'invalido', origem: 'cron',
  })
  assert.equal(resultado.motivo, 'permanent_recipient')

  const depois = await contarTentativasReaisDesde({ desde: inicioDoDiaBrtISO() })
  assert.equal(depois - antes, 1, 'checagem de existência do número É uma chamada real ao provider — conta')
})

test('3. timeout depois de chamar provider conta 1 tentativa real', async () => {
  await criarInstancia('wa01-t3', { priority: 1 })
  fakeEvolution.controlarInstancia('wa01-t3', { comportamento: 'timeout' })
  const antes = await contarTentativasReaisDesde({ desde: inicioDoDiaBrtISO() })

  const conta = await criarContaDeTeste(supabase)
  const resultado = await enviarComFailover({
    contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
    clienteTelefone: conta.telefone_cobranca, valor: 500, mensagem: 'timeout', origem: 'cron',
  })
  assert.equal(resultado.status, 'failed')

  const depois = await contarTentativasReaisDesde({ desde: inicioDoDiaBrtISO() })
  assert.equal(depois - antes, 1)
}, { timeout: 30_000 })

test('4. 5xx depois de chamar provider conta 1 tentativa real', async () => {
  await criarInstancia('wa01-t4', { priority: 1 })
  fakeEvolution.controlarInstancia('wa01-t4', { comportamento: 'unavailable' }) // 500
  const antes = await contarTentativasReaisDesde({ desde: inicioDoDiaBrtISO() })

  const conta = await criarContaDeTeste(supabase)
  const resultado = await enviarComFailover({
    contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
    clienteTelefone: conta.telefone_cobranca, valor: 500, mensagem: '5xx', origem: 'cron',
  })
  assert.equal(resultado.motivo, 'instance_unavailable')

  const depois = await contarTentativasReaisDesde({ desde: inicioDoDiaBrtISO() })
  assert.equal(depois - antes, 1)
})

test('5. 429 depois de chamar provider conta 1 e preserva o cooldown/circuit breaker existente', async () => {
  const instancia = await criarInstancia('wa01-t5', { priority: 1 })
  fakeEvolution.controlarInstancia('wa01-t5', { comportamento: 'rate_limited' })
  const antes = await contarTentativasReaisDesde({ desde: inicioDoDiaBrtISO() })

  const conta = await criarContaDeTeste(supabase)
  const resultado = await enviarComFailover({
    contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
    clienteTelefone: conta.telefone_cobranca, valor: 500, mensagem: '429', origem: 'cron',
  })
  assert.equal(resultado.motivo, 'rate_limit')

  const depois = await contarTentativasReaisDesde({ desde: inicioDoDiaBrtISO() })
  assert.equal(depois - antes, 1)

  const { data: instanciaDepois } = await supabase.from('whatsapp_instances').select('consecutive_failures').eq('id', instancia.id).single()
  assert.equal(instanciaDepois.consecutive_failures, 1, 'registrarFalhaEnvio (circuit breaker) continua rodando normalmente — não alterado por esta correção')
})

test('6. 401/403 depois de chamar provider conta 1 e NÃO faz fallback (mesmo com whatsapp_failover=true)', async () => {
  await criarInstancia('wa01-t6', { priority: 1, role: 'principal' })
  await criarInstancia('wa02-t6', { priority: 2, role: 'reserva' })
  fakeEvolution.controlarInstancia('wa01-t6', { comportamento: 'unauthorized' })
  fakeEvolution.controlarInstancia('wa02-t6', { comportamento: 'ok' })
  await supabase.from('automacoes_config').update({ whatsapp_failover: true }).eq('id', 1)
  invalidarCacheFlags()
  const antes = await contarTentativasReaisDesde({ desde: inicioDoDiaBrtISO() })

  const conta = await criarContaDeTeste(supabase)
  const resultado = await enviarComFailover({
    contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
    clienteTelefone: conta.telefone_cobranca, valor: 500, mensagem: '401', origem: 'cron',
  })
  assert.equal(resultado.motivo, 'auth')
  assert.equal(fakeEvolution.mensagensEnviadas.length, 0, 'wa02 nunca deveria ter sido tentada — AUTH nunca é failover-eligible')

  const depois = await contarTentativasReaisDesde({ desde: inicioDoDiaBrtISO() })
  assert.equal(depois - antes, 1, 'só 1 tentativa real (wa01) — sem fallback pra wa02')
})

test('7. bloqueio DNC antes do provider conta 0', async () => {
  await criarInstancia('wa01-t7', { priority: 1 })
  const telefone = telefoneDeTeste()
  await supabase.from('collection_do_not_contact').insert({ cliente_telefone: telefone, canal: 'todos', motivo: 'teste' })
  const antes = await contarTentativasReaisDesde({ desde: inicioDoDiaBrtISO() })

  const conta = await criarContaDeTeste(supabase, { telefone_cobranca: telefone })
  const resultado = await enviarCobrancaComRoteamento({
    contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
    clienteTelefone: telefone, valor: 500, mensagem: 'dnc', origem: 'cron',
  })
  assert.equal(resultado.status, 'blocked')
  assert.equal(resultado.reason, 'opt_out')

  const depois = await contarTentativasReaisDesde({ desde: inicioDoDiaBrtISO() })
  assert.equal(depois - antes, 0)
  assert.equal(fakeEvolution.mensagensEnviadas.length, 0)
})

test('8. paymentGuard (título quitado) antes do provider conta 0', async () => {
  await criarInstancia('wa01-t8', { priority: 1 })
  const antes = await contarTentativasReaisDesde({ desde: inicioDoDiaBrtISO() })

  const conta = await criarContaDeTeste(supabase, { valor: 500, valor_pago: 500 }) // saldo 0 = quitado
  const resultado = await enviarComFailover({
    contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
    clienteTelefone: conta.telefone_cobranca, valor: 500, mensagem: 'quitado', origem: 'cron',
  })
  assert.equal(resultado.status, 'skipped')
  assert.equal(resultado.motivo, 'quitado')

  const depois = await contarTentativasReaisDesde({ desde: inicioDoDiaBrtISO() })
  assert.equal(depois - antes, 0)
  assert.equal(fakeEvolution.mensagensEnviadas.length, 0)
})

test('9. promessa ativa antes do provider conta 0', async () => {
  await criarInstancia('wa01-t9', { priority: 1 })
  const conta = await criarContaDeTeste(supabase)
  await registrarPromessa({
    contasFinanceirasId: conta.id, clienteNome: conta.pessoa_nome, clienteTelefone: conta.telefone_cobranca,
    valor: 500, promisedDate: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10), origem: 'HUMAN',
  })
  const antes = await contarTentativasReaisDesde({ desde: inicioDoDiaBrtISO() })

  const resultado = await enviarComFailover({
    contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
    clienteTelefone: conta.telefone_cobranca, valor: 500, mensagem: 'promessa', origem: 'cron',
  })
  assert.equal(resultado.status, 'skipped')
  assert.equal(resultado.motivo, 'promessa_ativa')

  const depois = await contarTentativasReaisDesde({ desde: inicioDoDiaBrtISO() })
  assert.equal(depois - antes, 0)
  assert.equal(fakeEvolution.mensagensEnviadas.length, 0)
})

test('10. sync stale antes do provider conta 0', async () => {
  await criarInstancia('wa01-t10', { priority: 1 })
  await supabase.from('sincronizacoes_financeiro').delete().eq('dry_run', false) // nenhuma sync real -> nunca_sincronizou
  _resetCacheParaTeste() // financialSyncGuard tem cache curto — o beforeEach já tinha cacheado "fresco"
  const antes = await contarTentativasReaisDesde({ desde: inicioDoDiaBrtISO() })

  const conta = await criarContaDeTeste(supabase)
  const resultado = await enviarCobrancaComRoteamento({
    contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
    clienteTelefone: conta.telefone_cobranca, valor: 500, mensagem: 'sync stale', origem: 'cron',
  })
  assert.equal(resultado.status, 'blocked')
  assert.equal(resultado.guard?.reason ?? resultado.reason, 'nunca_sincronizou')

  const depois = await contarTentativasReaisDesde({ desde: inicioDoDiaBrtISO() })
  assert.equal(depois - antes, 0)
  assert.equal(fakeEvolution.mensagensEnviadas.length, 0)
})

test('11. telefone bloqueado no mesmo dia (PR #48): chamadas seguintes contam 0', async () => {
  await criarInstancia('wa01-t11', { priority: 1 })
  const telefone = telefoneInvalidoDeTeste()

  const contaA = await criarContaDeTeste(supabase, { telefone_cobranca: telefone })
  await enviarCobrancaComRoteamento({
    contasFinanceirasId: contaA.id, etapa: 3, clienteNome: contaA.pessoa_nome,
    clienteTelefone: telefone, valor: 500, mensagem: 'gatilho', origem: 'cron',
  })
  const dnc = await estaEmDoNotContact(telefone)
  assert.equal(dnc.blocked, true, 'pré-condição: telefone deveria estar bloqueado pelo PR #48 após a 1ª falha definitiva')

  const antes = await contarTentativasReaisDesde({ desde: inicioDoDiaBrtISO() })
  const contaB = await criarContaDeTeste(supabase, { telefone_cobranca: telefone, codigo_cliente: `OUTRO-${Date.now()}` })
  const resultado = await enviarCobrancaComRoteamento({
    contasFinanceirasId: contaB.id, etapa: 3, clienteNome: contaB.pessoa_nome,
    clienteTelefone: telefone, valor: 300, mensagem: 'bloqueado', origem: 'cron',
  })
  assert.equal(resultado.status, 'blocked')
  assert.equal(resultado.reason, 'numero_invalido_hoje')
  const depois = await contarTentativasReaisDesde({ desde: inicioDoDiaBrtISO() })
  assert.equal(depois - antes, 0, 'título B nunca deveria ter gerado uma tentativa real — bloqueado antes do provider')
})

test('12. mesmo envio registrado em cobrancas_whatsapp E collection_dispatch_attempts conta apenas 1', async () => {
  await criarInstancia('wa01-t12', { priority: 1 })
  fakeEvolution.controlarInstancia('wa01-t12', { comportamento: 'ok' })
  const antes = await contarTentativasReaisDesde({ desde: inicioDoDiaBrtISO() })

  const conta = await criarContaDeTeste(supabase)
  const resultado = await enviarComFailover({
    contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
    clienteTelefone: conta.telefone_cobranca, valor: 500, mensagem: 'dupla contagem', origem: 'cron',
  })
  assert.equal(resultado.status, 'sent')

  // Simula o que cobranca-whatsapp.js faz DEPOIS de um envio bem-sucedido —
  // grava também em cobrancas_whatsapp (mesmo evento lógico, 2ª tabela).
  await supabase.from('cobrancas_whatsapp').insert({
    contas_financeiras_id: conta.id, cliente_nome: conta.pessoa_nome, cliente_telefone: conta.telefone_cobranca,
    valor: 500, etapa: 3, status: 'enviada', origem: 'cron', data_envio: new Date().toISOString(),
  })

  const depois = await contarTentativasReaisDesde({ desde: inicioDoDiaBrtISO() })
  assert.equal(depois - antes, 1, 'mesmo evento em 2 tabelas — conta 1 única vez, nunca 2')
})

test('13. limite 10/hora bloqueia a 11ª tentativa real (falhas contam)', async () => {
  const instancia = await criarInstancia('wa01-t13', { priority: 1 })
  fakeEvolution.controlarInstancia('wa01-t13', { comportamento: 'unavailable' }) // toda tentativa falha (técnica)
  await supabase.from('automacoes_config').update({ global_hourly_limit: 10, global_daily_limit: 100 }).eq('id', 1)
  invalidarCacheFlags()

  for (let i = 0; i < 10; i++) {
    // Reseta o circuit breaker da instância a cada volta — o teste é sobre o
    // TETO GLOBAL de tentativas reais, não sobre o cooldown por instância
    // (já coberto à parte, teste 5 deste arquivo e whatsapp-instance-
    // health-counters.test.mjs). Sem isto, a própria instância entraria em
    // cooldown depois de 6 falhas consecutivas (COOLDOWN_AFTER_FAILURES em
    // whatsappInstances.js) e pararia de gerar tentativas reais bem antes
    // da 10ª — mascarando o comportamento que este teste quer provar.
    await supabase.from('whatsapp_instances').update({ consecutive_failures: 0, health_status: 'connected', cooldown_until: null }).eq('id', instancia.id)
    const conta = await criarContaDeTeste(supabase)
    const resultado = await enviarCobrancaComRoteamento({
      contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
      clienteTelefone: conta.telefone_cobranca, valor: 500, mensagem: `t13-${i}`, origem: 'cron',
    })
    assert.notEqual(resultado.status, 'blocked', `tentativa ${i + 1}/10 não deveria estar bloqueada ainda`)
  }

  const conta11 = await criarContaDeTeste(supabase)
  const resultado11 = await enviarCobrancaComRoteamento({
    contasFinanceirasId: conta11.id, etapa: 3, clienteNome: conta11.pessoa_nome,
    clienteTelefone: conta11.telefone_cobranca, valor: 500, mensagem: 't13-11a', origem: 'cron',
  })
  assert.equal(resultado11.status, 'blocked')
  assert.equal(resultado11.reason, 'limite_global_horario')
})

test('14. limite 30/dia bloqueia a 31ª tentativa real (falhas contam)', async () => {
  const instancia = await criarInstancia('wa01-t14', { priority: 1 })
  fakeEvolution.controlarInstancia('wa01-t14', { comportamento: 'unavailable' })
  await supabase.from('automacoes_config').update({ global_hourly_limit: 1000, global_daily_limit: 30 }).eq('id', 1)
  invalidarCacheFlags()

  for (let i = 0; i < 30; i++) {
    // Ver comentário equivalente no teste 13 — isola do cooldown/circuit
    // breaker por instância, que não é o que este teste quer provar.
    await supabase.from('whatsapp_instances').update({ consecutive_failures: 0, health_status: 'connected', cooldown_until: null }).eq('id', instancia.id)
    const conta = await criarContaDeTeste(supabase)
    const resultado = await enviarCobrancaComRoteamento({
      contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
      clienteTelefone: conta.telefone_cobranca, valor: 500, mensagem: `t14-${i}`, origem: 'cron',
    })
    assert.notEqual(resultado.status, 'blocked', `tentativa ${i + 1}/30 não deveria estar bloqueada ainda`)
  }

  const conta31 = await criarContaDeTeste(supabase)
  const resultado31 = await enviarCobrancaComRoteamento({
    contasFinanceirasId: conta31.id, etapa: 3, clienteNome: conta31.pessoa_nome,
    clienteTelefone: conta31.telefone_cobranca, valor: 500, mensagem: 't14-31', origem: 'cron',
  })
  assert.equal(resultado31.status, 'blocked')
  assert.equal(resultado31.reason, 'limite_global_diario')
}, { timeout: 60_000 })

test('15. contagem global correta — soma de todas as instâncias, todas as origens', async () => {
  await criarInstancia('wa01-t15', { priority: 1 })
  await criarInstancia('wa02-t15', { priority: 2, role: 'reserva' })
  fakeEvolution.controlarInstancia('wa01-t15', { comportamento: 'ok' })
  fakeEvolution.controlarInstancia('wa02-t15', { comportamento: 'unavailable' })

  const contaCron = await criarContaDeTeste(supabase)
  await enviarComFailover({
    contasFinanceirasId: contaCron.id, etapa: 3, clienteNome: contaCron.pessoa_nome,
    clienteTelefone: contaCron.telefone_cobranca, valor: 500, mensagem: 'cron', origem: 'cron',
  })
  const contaManual = await criarContaDeTeste(supabase)
  await enviarComFailover({
    contasFinanceirasId: contaManual.id, etapa: 3, clienteNome: contaManual.pessoa_nome,
    clienteTelefone: contaManual.telefone_cobranca, valor: 500, mensagem: 'manual', origem: 'manual',
  })

  const r = await verificarLimiteGlobalEnvio()
  assert.equal(r.contagem_dia, 2, 'global soma cron + manual, qualquer instância')
})

test('16. contagem por instância correta — cada instância só reflete o que ELA recebeu', async () => {
  const wa01 = await criarInstancia('wa01-t16', { priority: 1, role: 'principal' })
  const wa02 = await criarInstancia('wa02-t16', { priority: 2, role: 'reserva' })
  fakeEvolution.controlarInstancia('wa01-t16', { comportamento: 'unavailable' })
  fakeEvolution.controlarInstancia('wa02-t16', { comportamento: 'ok' })
  await supabase.from('automacoes_config').update({ whatsapp_failover: true }).eq('id', 1)
  invalidarCacheFlags()

  const conta = await criarContaDeTeste(supabase)
  const resultado = await enviarComFailover({
    contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
    clienteTelefone: conta.telefone_cobranca, valor: 500, mensagem: 'x', origem: 'cron',
  })
  assert.equal(resultado.status, 'sent')

  const contagem = await contarEnviosReaisHojePorInstancia()
  assert.equal(contagem.get(wa01.id), 1, 'wa01 recebeu 1 tentativa real (falhou)')
  assert.equal(contagem.get(wa02.id), 1, 'wa02 recebeu 1 tentativa real (sucesso)')
})

test('17. multi-instância: falha AUTH/RATE_LIMIT nunca aciona failover indevido (whatsapp_failover preservado)', async () => {
  await criarInstancia('wa01-t17', { priority: 1, role: 'principal' })
  await criarInstancia('wa02-t17', { priority: 2, role: 'reserva' })
  fakeEvolution.controlarInstancia('wa01-t17', { comportamento: 'rate_limited' })
  fakeEvolution.controlarInstancia('wa02-t17', { comportamento: 'ok' })
  await supabase.from('automacoes_config').update({ whatsapp_failover: true }).eq('id', 1) // mesmo com failover ligado
  invalidarCacheFlags()

  const conta = await criarContaDeTeste(supabase)
  const resultado = await enviarComFailover({
    contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
    clienteTelefone: conta.telefone_cobranca, valor: 500, mensagem: 'x', origem: 'cron',
  })
  assert.equal(resultado.status, 'failed')
  assert.equal(resultado.categoria, 'RATE_LIMIT')
  assert.equal(fakeEvolution.mensagensEnviadas.length, 0, 'wa02 nunca deveria ter sido tentada — RATE_LIMIT nunca é failover-eligible, mesmo com whatsapp_failover=true')
})

test('18. consolidação de parcelas (PR #44) continua intacta: 1 grupo consolidado = 1 tentativa real, não 1 por título', async () => {
  await criarInstancia('wa01-t18', { priority: 1 })
  fakeEvolution.controlarInstancia('wa01-t18', { comportamento: 'ok' })
  const { agruparParaConsolidacao } = await import('../../../src/lib/collection/consolidacaoParcelas.js')

  const telefone = telefoneDeTeste()
  const codigoCliente = `CONSOL-T18-${Date.now()}`
  const vencimento = new Date().toISOString().slice(0, 10)
  const titulos = [
    { id: 'a', codigo_cliente: codigoCliente, vencimento, telefone_cobranca: telefone, valor: 200, valor_pago: 0, status: 'vencida', legacy_id: 'leg-a', pessoa_nome: 'Cliente T18' },
    { id: 'b', codigo_cliente: codigoCliente, vencimento, telefone_cobranca: telefone, valor: 300, valor_pago: 0, status: 'vencida', legacy_id: 'leg-b', pessoa_nome: 'Cliente T18' },
  ]
  const grupos = agruparParaConsolidacao(titulos)
  assert.equal(grupos.length, 1, 'os 2 títulos deveriam formar 1 único grupo (mesmo cliente+vencimento)')
  assert.equal(grupos[0].quantidadeTitulos, 2)
  assert.equal(grupos[0].valorTotal, 500)

  // A consolidação é lógica (cobranca-whatsapp.js) — o motor de envio em si
  // (enviarComFailover) recebe 1 chamada só pro grupo, exatamente como
  // receberia pra um título único. Rate limit conta 1 tentativa real.
  const antes = await contarTentativasReaisDesde({ desde: inicioDoDiaBrtISO() })
  const contaRepresentante = await criarContaDeTeste(supabase, {
    telefone_cobranca: telefone, valor: grupos[0].valorTotal, pessoa_nome: grupos[0].nome,
  })
  await enviarComFailover({
    contasFinanceirasId: contaRepresentante.id, etapa: 3, clienteNome: grupos[0].nome,
    clienteTelefone: telefone, valor: grupos[0].valorTotal, mensagem: 'consolidado', origem: 'cron',
  })
  const depois = await contarTentativasReaisDesde({ desde: inicioDoDiaBrtISO() })
  assert.equal(depois - antes, 1, '1 grupo consolidado = 1 tentativa real, nunca 1 por título dentro do grupo')
})

test('19. prova estática — todos os cenários usam Fake Evolution local, nenhum WhatsApp real', () => {
  assert.match(process.env.EVOLUTION_API_URL, /^http:\/\/127\.0\.0\.1:\d+$/, 'EVOLUTION_API_URL precisa apontar pro Fake Evolution local, nunca pra Evolution real')
  assert.equal(process.env.NODE_ENV, 'test')
})
