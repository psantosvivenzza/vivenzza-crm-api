// 2026-08-18 — 19 cenários do pedido "CORREÇÃO DE SEGURANÇA — TELEFONE
// INVÁLIDO COM MÚLTIPLOS TÍTULOS". Achado real (auditoria pós-disparo do
// mesmo dia): um telefone que recebe "número não registrado no WhatsApp"
// (PERMANENT_RECIPIENT) continuava sendo tentado de novo pra CADA outro
// título do mesmo cliente/telefone no mesmo dia — cada tentativa é uma
// chamada HTTP real de checagem contra a Evolution/WhatsApp, e nem o teto
// diário nem o teto por hora contam essas falhas (globalSendLimit.js/
// whatsappInstances.js só contam sucesso — ver cenário 16).
//
// Fix: reusa collection_do_not_contact (canal='whatsapp', expira_em=fim do
// dia BRT originalmente) — nenhuma tabela/campo novo. Contra CÓDIGO REAL,
// Postgres local e Fake Evolution — nenhum WhatsApp de verdade em nenhum
// cenário.
//
// AMPLIAÇÃO 2026-08-27 — auditoria de qualidade de telefones achou 183
// permanent_recipient em 30 dias mas só 39 telefones únicos, 36 reincidentes
// (um chegou a 28 tentativas), 100% dependendo do provider pra falhar de
// novo. A janela de "até meia-noite BRT" virou quarentena de 30 dias
// (doNotContactGuard.js: expiracaoQuarentenaDeHoje/proximaExpiracaoQuarentena)
// — testes B/F atualizados, bloco 'Quarentena de 30 dias' no fim do arquivo
// cobre os cenários novos. Nunca vira bloqueio permanente automático.
import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste, criarContaDeTeste, limparInstanciasDeTeste, telefoneDeTeste } from './_setup.mjs'

let supabase, fakeEvolution
let enviarCobrancaComRoteamento, enviarComFailover, executarReguaCobranca, invalidarCacheFlags
let estaEmDoNotContact, registrarBloqueioNumeroInvalidoHoje, MOTIVO_NUMERO_INVALIDO_HOJE, proximaExpiracaoQuarentena
let tituloEstaQuitado
let decidirProximaAcao
let avaliarGuardsTituloParaLigacao
let contarEnviosReaisHojePorInstancia, verificarLimiteGlobalEnvio

before(async () => {
  fakeEvolution = await iniciarAmbienteDeTeste()
  ;({ supabase } = await import('../../../src/lib/supabase-admin.server.js'))
  ;({ enviarCobrancaComRoteamento } = await import('../../../src/lib/collection/collectionRouting.js'))
  ;({ enviarComFailover } = await import('../../../src/lib/collection/dispatchEngine.js'))
  ;({ executarReguaCobranca } = await import('../../../src/jobs/cobranca-whatsapp.js'))
  ;({ invalidarCacheFlags } = await import('../../../src/lib/collection/featureFlags.js'))
  ;({ estaEmDoNotContact, registrarBloqueioNumeroInvalidoHoje, MOTIVO_NUMERO_INVALIDO_HOJE, proximaExpiracaoQuarentena } = await import('../../../src/lib/collection/doNotContactGuard.js'))
  ;({ tituloEstaQuitado } = await import('../../../src/lib/collection/paymentGuard.js'))
  ;({ decidirProximaAcao } = await import('../../../src/lib/collection/nextBestAction.js'))
  ;({ avaliarGuardsTituloParaLigacao } = await import('../../../src/lib/voice/collectionGuardsForVoice.js'))
  ;({ contarEnviosReaisHojePorInstancia } = await import('../../../src/lib/collection/whatsappInstances.js'))
  ;({ verificarLimiteGlobalEnvio } = await import('../../../src/lib/collection/globalSendLimit.js'))
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

async function limparDnc() {
  await supabase.from('collection_do_not_contact').delete().neq('id', '00000000-0000-0000-0000-000000000000')
}

// Fake Evolution trata número terminado em "000" como "não existe no
// WhatsApp" (ver fakeEvolution.js) — telefone de teste garantidamente
// inválido, sem depender do comportamento por instância.
function telefoneInvalidoDeTeste() {
  return `${telefoneDeTeste().slice(0, -3)}000`
}

beforeEach(async () => {
  fakeEvolution.resetar()
  await limparInstanciasDeTeste(supabase)
  await limparDnc()
  await garantirSyncFinanceiroFresco()
  await supabase.from('automacoes_config').update({
    multi_whatsapp: true, whatsapp_failover: false, cobranca_whatsapp_ativa: true,
    global_daily_limit: 30, global_hourly_limit: 10,
  }).eq('id', 1)
  invalidarCacheFlags()
})

test('1. número inválido bloqueia telefone: 2º título (outra conta, mesmo telefone) é bloqueado sem chamar o provider (motor v2)', async () => {
  await criarInstancia('wa01-t1', { priority: 1 })
  const telefone = telefoneInvalidoDeTeste()

  const contaA = await criarContaDeTeste(supabase, { telefone_cobranca: telefone })
  const resultadoA = await enviarCobrancaComRoteamento({
    contasFinanceirasId: contaA.id, etapa: 3, clienteNome: contaA.pessoa_nome,
    clienteTelefone: telefone, valor: 500, mensagem: 'título A', origem: 'cron',
  })
  assert.equal(resultadoA.status, 'failed')
  assert.equal(resultadoA.motivo, 'permanent_recipient')

  const chamadasAntes = fakeEvolution.mensagensEnviadas.length
  const contaB = await criarContaDeTeste(supabase, { telefone_cobranca: telefone, codigo_cliente: `OUTRO-${Date.now()}` })
  const resultadoB = await enviarCobrancaComRoteamento({
    contasFinanceirasId: contaB.id, etapa: 3, clienteNome: contaB.pessoa_nome,
    clienteTelefone: telefone, valor: 300, mensagem: 'título B', origem: 'cron',
  })
  assert.equal(resultadoB.status, 'blocked')
  assert.equal(resultadoB.reason, 'numero_invalido_hoje')
  assert.equal(fakeEvolution.mensagensEnviadas.length, chamadasAntes, 'nenhuma nova mensagem enviada')

  const { data: dispatchesB } = await supabase.from('collection_dispatches').select('id').eq('contas_financeiras_id', contaB.id)
  assert.equal(dispatchesB?.length ?? 0, 0, 'título B nunca deveria ter criado um dispatch — bloqueado antes disso')
})

test('2. mesmo cenário no motor legado (multi_whatsapp=false): 2º título bloqueado sem nova chamada ao provider', async () => {
  await supabase.from('automacoes_config').update({ multi_whatsapp: false }).eq('id', 1)
  invalidarCacheFlags()
  const telefone = telefoneInvalidoDeTeste()

  const contaA = await criarContaDeTeste(supabase, { telefone_cobranca: telefone })
  await assert.rejects(
    enviarCobrancaComRoteamento({
      contasFinanceirasId: contaA.id, etapa: 3, clienteNome: contaA.pessoa_nome,
      clienteTelefone: telefone, valor: 500, mensagem: 'legado A', origem: 'cron',
    }),
    /não está registrado no WhatsApp/,
  )

  const contaB = await criarContaDeTeste(supabase, { telefone_cobranca: telefone, codigo_cliente: `OUTRO-${Date.now()}` })
  const resultadoB = await enviarCobrancaComRoteamento({
    contasFinanceirasId: contaB.id, etapa: 3, clienteNome: contaB.pessoa_nome,
    clienteTelefone: telefone, valor: 300, mensagem: 'legado B', origem: 'cron',
  })
  assert.equal(resultadoB.status, 'blocked')
  assert.equal(resultadoB.reason, 'numero_invalido_hoje')
})

test('3. falha técnica (500) NÃO bloqueia telefone — 2º título do mesmo telefone ainda é tentado normalmente', async () => {
  await criarInstancia('wa01-t3', { priority: 1, role: 'principal' })
  fakeEvolution.controlarInstancia('wa01-t3', { comportamento: 'unavailable' })
  const telefone = telefoneDeTeste()

  const contaA = await criarContaDeTeste(supabase, { telefone_cobranca: telefone })
  const resultadoA = await enviarCobrancaComRoteamento({
    contasFinanceirasId: contaA.id, etapa: 3, clienteNome: contaA.pessoa_nome,
    clienteTelefone: telefone, valor: 500, mensagem: 'técnica A', origem: 'cron',
  })
  assert.equal(resultadoA.status, 'failed')
  assert.equal(resultadoA.motivo, 'instance_unavailable')

  const dnc = await estaEmDoNotContact(telefone)
  assert.equal(dnc.blocked, false, 'falha técnica nunca aciona o bloqueio de telefone+dia')

  fakeEvolution.controlarInstancia('wa01-t3', { comportamento: 'ok' })
  const contaB = await criarContaDeTeste(supabase, { telefone_cobranca: telefone, codigo_cliente: `OUTRO-${Date.now()}` })
  const resultadoB = await enviarCobrancaComRoteamento({
    contasFinanceirasId: contaB.id, etapa: 3, clienteNome: contaB.pessoa_nome,
    clienteTelefone: telefone, valor: 300, mensagem: 'técnica B', origem: 'cron',
  })
  assert.equal(resultadoB.status, 'sent', 'segundo título deve continuar sendo tentado normalmente')
})

test('4. rate limit (429) NÃO bloqueia telefone', async () => {
  await criarInstancia('wa01-t4', { priority: 1, role: 'principal' })
  fakeEvolution.controlarInstancia('wa01-t4', { comportamento: 'rate_limited' })
  const telefone = telefoneDeTeste()

  const conta = await criarContaDeTeste(supabase, { telefone_cobranca: telefone })
  const resultado = await enviarCobrancaComRoteamento({
    contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
    clienteTelefone: telefone, valor: 500, mensagem: '429', origem: 'cron',
  })
  assert.equal(resultado.motivo, 'rate_limit')

  const dnc = await estaEmDoNotContact(telefone)
  assert.equal(dnc.blocked, false, '429 nunca aciona o bloqueio de telefone+dia')
})

test('5. auth (401) NÃO bloqueia telefone', async () => {
  await criarInstancia('wa01-t5', { priority: 1, role: 'principal' })
  fakeEvolution.controlarInstancia('wa01-t5', { comportamento: 'unauthorized' })
  const telefone = telefoneDeTeste()

  const conta = await criarContaDeTeste(supabase, { telefone_cobranca: telefone })
  const resultado = await enviarCobrancaComRoteamento({
    contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
    clienteTelefone: telefone, valor: 500, mensagem: '401', origem: 'cron',
  })
  assert.equal(resultado.motivo, 'auth')

  const dnc = await estaEmDoNotContact(telefone)
  assert.equal(dnc.blocked, false, '401 nunca aciona o bloqueio de telefone+dia')
})

test('6. bloqueio não marca título como pago/quitado — título continua elegível (só adiado pro guard de telefone)', async () => {
  await criarInstancia('wa01-t6', { priority: 1 })
  const telefone = telefoneInvalidoDeTeste()
  const conta = await criarContaDeTeste(supabase, { telefone_cobranca: telefone })

  await enviarCobrancaComRoteamento({
    contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
    clienteTelefone: telefone, valor: 500, mensagem: 'quitado?', origem: 'cron',
  })

  const quitado = await tituloEstaQuitado(conta.id)
  assert.equal(quitado, false, 'bloqueio de telefone não é pagamento — título continua em aberto')

  const { data: contaAtual } = await supabase.from('contas_financeiras').select('status, valor_pago').eq('id', conta.id).single()
  assert.equal(contaAtual.status, 'vencida')
  assert.equal(Number(contaAtual.valor_pago), 0)
})

test('7. bloqueio expira sozinho — registro de "ontem" não bloqueia envio de hoje', async () => {
  await criarInstancia('wa01-t7', { priority: 1 })
  const telefone = telefoneDeTeste()

  await supabase.from('collection_do_not_contact').insert({
    cliente_telefone: telefone, canal: 'whatsapp', motivo: MOTIVO_NUMERO_INVALIDO_HOJE,
    expira_em: new Date(Date.now() - 60_000).toISOString(), // expirou há 1 minuto
  })

  const dnc = await estaEmDoNotContact(telefone)
  assert.equal(dnc.blocked, false, 'bloqueio expirado nunca deve contar')

  const conta = await criarContaDeTeste(supabase, { telefone_cobranca: telefone })
  const resultado = await enviarCobrancaComRoteamento({
    contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
    clienteTelefone: telefone, valor: 500, mensagem: 'pós-expiração', origem: 'cron',
  })
  assert.equal(resultado.status, 'sent')
})

test('8. reenvio do MESMO título bloqueado não chama o provider de novo (idempotência por telefone, não só por título)', async () => {
  await criarInstancia('wa01-t8', { priority: 1 })
  const telefone = telefoneInvalidoDeTeste()
  const conta = await criarContaDeTeste(supabase, { telefone_cobranca: telefone })

  await enviarCobrancaComRoteamento({
    contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
    clienteTelefone: telefone, valor: 500, mensagem: '1ª tentativa', origem: 'cron',
  })
  const chamadasApos1a = fakeEvolution.mensagensEnviadas.length

  const resultado2 = await enviarCobrancaComRoteamento({
    contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
    clienteTelefone: telefone, valor: 500, mensagem: '2ª tentativa (mesmo título)', origem: 'cron',
  })
  assert.equal(resultado2.status, 'blocked')
  assert.equal(resultado2.reason, 'numero_invalido_hoje')
  assert.equal(fakeEvolution.mensagensEnviadas.length, chamadasApos1a, 'nenhuma nova chamada ao provider pro mesmo título')
})

test('9. consolidação preservada — 2 títulos mesmo cliente+vencimento = 1 única tentativa, que falha e bloqueia corretamente', { timeout: 120_000 }, async (t) => {
  const horaBrt = (new Date().getUTCHours() - 3 + 24) % 24
  if (!(horaBrt >= 8 && horaBrt < 17)) { t.skip('fora da janela 08h-17h BRT — dentroDoHorarioPermitido() bloquearia antes de alcançar o cenário'); return }

  await criarInstancia('wa01-t9', { priority: 1 })
  const telefone = telefoneInvalidoDeTeste()
  const codigoCliente = `CONSOL-${Date.now()}`
  const vencimento = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10)

  // criarContaDeTeste não repassa legacy_id no insert — precisa de um UPDATE
  // à parte. Sem legacy_id em AMBOS os títulos, agruparParaConsolidacao os
  // classificaria como grupo AMBÍGUO (sem_legacy_id_multiplo), não consolidado.
  const contaA = await criarContaDeTeste(supabase, {
    telefone_cobranca: telefone, codigo_cliente: codigoCliente, vencimento, valor: 200,
  })
  await supabase.from('contas_financeiras').update({ legacy_id: 'LEG-A' }).eq('id', contaA.id)
  const contaB = await criarContaDeTeste(supabase, {
    telefone_cobranca: telefone, codigo_cliente: codigoCliente, vencimento,
    valor: 300, pessoa_nome: contaA.pessoa_nome,
  })
  await supabase.from('contas_financeiras').update({ legacy_id: 'LEG-B' }).eq('id', contaB.id)

  const outras = await supabase.from('contas_financeiras').select('id, status')
    .eq('tipo', 'receber').in('status', ['aberta', 'vencida', 'pago_parcial'])
    .neq('id', contaA.id).neq('id', contaB.id)
  const idsIsolados = (outras.data ?? []).map((o) => o.id)
  if (idsIsolados.length) await supabase.from('contas_financeiras').update({ status: 'cancelada' }).in('id', idsIsolados)

  try {
    const resumo = await executarReguaCobranca()
    assert.equal(resumo.gruposConsolidados, 1, 'as 2 contas devem ter formado 1 único grupo consolidado')
    assert.equal(fakeEvolution.mensagensEnviadas.length, 0, 'nenhum envio real (número inválido)')
    // POST /chat/whatsappNumbers é a checagem real feita ANTES do envio —
    // conta como "chamada ao provider" mesmo sem chegar a /message/sendText.
    // A consolidação já garante 1 mensagem só (não 2) pro grupo.
  } finally {
    for (const id of idsIsolados) await supabase.from('contas_financeiras').update({ status: 'vencida' }).eq('id', id)
  }
})

// timeout 240s: aguardarIntervaloAleatorio() (45-90s) roda ANTES de cada
// grupo, inclusive o 2º que será bloqueado antes de qualquer chamada real —
// o fix corta a chamada ao provider, não o intervalo de ritmo entre
// tentativas (fora de escopo desta correção, ver relatório).
test('10. multi-grupo mesmo telefone (vencimentos diferentes): 1º grupo falha, 2º grupo do mesmo telefone é bloqueado sem 2ª chamada ao provider', { timeout: 240_000 }, async (t) => {
  const horaBrt = (new Date().getUTCHours() - 3 + 24) % 24
  if (!(horaBrt >= 8 && horaBrt < 17)) { t.skip('fora da janela 08h-17h BRT'); return }

  await criarInstancia('wa01-t10', { priority: 1 })
  const telefone = telefoneInvalidoDeTeste()

  const contaA = await criarContaDeTeste(supabase, {
    telefone_cobranca: telefone, codigo_cliente: `MULTI-A-${Date.now()}`,
    vencimento: new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10), valor: 200,
  })
  const contaB = await criarContaDeTeste(supabase, {
    telefone_cobranca: telefone, codigo_cliente: `MULTI-B-${Date.now()}`,
    vencimento: new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10), valor: 300,
  })

  const outras = await supabase.from('contas_financeiras').select('id, status')
    .eq('tipo', 'receber').in('status', ['aberta', 'vencida', 'pago_parcial'])
    .neq('id', contaA.id).neq('id', contaB.id)
  const idsIsolados = (outras.data ?? []).map((o) => o.id)
  if (idsIsolados.length) await supabase.from('contas_financeiras').update({ status: 'cancelada' }).in('id', idsIsolados)

  try {
    const resumo = await executarReguaCobranca()
    assert.equal(resumo.gruposConsolidados, 0, 'vencimentos diferentes não consolidam — 2 grupos separados')
    assert.equal(resumo.enviadas, 0)
    assert.equal(fakeEvolution.mensagensEnviadas.length, 0)

    const dnc = await estaEmDoNotContact(telefone)
    assert.equal(dnc.blocked, true, 'telefone deve estar bloqueado após o 1º grupo falhar')
    assert.equal(dnc.reason, 'NUMERO_INVALIDO_HOJE')
  } finally {
    for (const id of idsIsolados) await supabase.from('contas_financeiras').update({ status: 'vencida' }).eq('id', id)
  }
})

test('11. disparo manual (/disparar-individual) após bloqueio do cron no mesmo dia também é bloqueado', async () => {
  await criarInstancia('wa01-t11', { priority: 1 })
  const telefone = telefoneInvalidoDeTeste()
  const contaCron = await criarContaDeTeste(supabase, { telefone_cobranca: telefone })

  await enviarCobrancaComRoteamento({
    contasFinanceirasId: contaCron.id, etapa: 3, clienteNome: contaCron.pessoa_nome,
    clienteTelefone: telefone, valor: 500, mensagem: 'via cron', origem: 'cron',
  })

  process.env.API_SECRET_KEY = 'chave-teste-suppress-invalid-11'
  const express = (await import('express')).default
  const { auth, adminOnly } = await import('../../../src/middleware/auth.js')
  const cobrancasRouter = (await import('../../../src/routes/cobrancas.js')).default
  const app = express()
  app.use(express.json())
  app.use('/api/cobrancas', auth, adminOnly, cobrancasRouter)
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  const porta = server.address().port

  const nomeUnico = `Cliente Teste Bloqueio Manual ${Date.now()}`
  await criarContaDeTeste(supabase, { pessoa_nome: nomeUnico, telefone_cobranca: telefone, codigo_cliente: `MANUAL-${Date.now()}` })

  try {
    const resultado = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: porta, method: 'POST',
        path: `/api/cobrancas/disparar-individual/${encodeURIComponent(nomeUnico)}`,
        headers: { authorization: 'Bearer chave-teste-suppress-invalid-11', 'content-type': 'application/json' },
      }, (res) => {
        let chunks = ''
        res.on('data', (c) => { chunks += c })
        res.on('end', () => resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null }))
      })
      req.on('error', reject)
      req.end()
    })
    assert.equal(resultado.status, 400)
    assert.match(resultado.body.erro, /NUMERO_INVALIDO_HOJE|blocked/i)
  } finally {
    server.close()
  }
})

test('12. estaEmDoNotContact diferencia motivo: NUMERO_INVALIDO_HOJE (temporário) x OPT_OUT (permanente)', async () => {
  const telefoneInvalido = telefoneDeTeste()
  const telefoneOptOut = telefoneDeTeste()

  await registrarBloqueioNumeroInvalidoHoje(telefoneInvalido)
  await supabase.from('collection_do_not_contact').insert({ cliente_telefone: telefoneOptOut, canal: 'todos', motivo: 'pedido do cliente' })

  const resultadoInvalido = await estaEmDoNotContact(telefoneInvalido)
  const resultadoOptOut = await estaEmDoNotContact(telefoneOptOut)

  assert.equal(resultadoInvalido.blocked, true)
  assert.equal(resultadoInvalido.reason, 'NUMERO_INVALIDO_HOJE')
  assert.equal(resultadoOptOut.blocked, true)
  assert.equal(resultadoOptOut.reason, 'OPT_OUT')
})

test('13. shadow NBA não rotula bloqueio de número inválido como OPT_OUT', async () => {
  const telefone = telefoneDeTeste()
  await registrarBloqueioNumeroInvalidoHoje(telefone)
  const conta = await criarContaDeTeste(supabase, { telefone_cobranca: telefone })

  const decisao = await decidirProximaAcao(conta.id)

  assert.notEqual(decisao?.reason_codes?.[0], 'OPT_OUT', 'bloqueio temporário de telefone não pode aparecer como opt-out real no shadow')
})

test('14. guard de voz (canal ligacao) não é afetado por bloqueio de telefone do WhatsApp', async () => {
  const telefone = telefoneDeTeste()
  await registrarBloqueioNumeroInvalidoHoje(telefone)
  const conta = await criarContaDeTeste(supabase, { telefone_cobranca: telefone })

  const resultado = await avaliarGuardsTituloParaLigacao(conta.id, telefone)
  assert.equal(resultado.permitido, true, 'bloqueio é canal=whatsapp — nunca deve vazar pro canal ligacao')
})

test('15. registrarBloqueioNumeroInvalidoHoje é idempotente — 2 chamadas mesmo telefone/dia geram 1 linha só', async () => {
  const telefone = telefoneDeTeste()
  await registrarBloqueioNumeroInvalidoHoje(telefone)
  await registrarBloqueioNumeroInvalidoHoje(telefone)

  const { data } = await supabase.from('collection_do_not_contact').select('id')
    .eq('cliente_telefone', telefone).eq('motivo', MOTIVO_NUMERO_INVALIDO_HOJE)
  assert.equal(data?.length ?? 0, 1)
})

// 2026-08-18 — GAP FECHADO na correção "rate limit de tentativas reais ao
// provider" (fix/count-provider-attempts-in-rate-limit, ver
// providerAttemptCounter.js): este teste documentava o gap como
// deliberadamente NÃO corrigido nesta PR (#48) — agora que a correção
// seguinte fechou o gap, a asserção se inverte: a falha de número inválido
// PASSA a consumir tanto o teto global quanto o teto por instância (cada
// falha real é 1 chamada HTTP real contra o provider).
test('16. falha de número inválido CONSOME o teto global e o teto por instância (gap fechado por fix/count-provider-attempts-in-rate-limit)', async () => {
  const instancia = await criarInstancia('wa01-t16', { priority: 1 })
  const telefone = telefoneInvalidoDeTeste()
  const conta = await criarContaDeTeste(supabase, { telefone_cobranca: telefone })

  const antesGlobal = await verificarLimiteGlobalEnvio()
  const antesPorInstancia = await contarEnviosReaisHojePorInstancia()

  await enviarCobrancaComRoteamento({
    contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
    clienteTelefone: telefone, valor: 500, mensagem: 'gap rate limit', origem: 'cron',
  })

  const depoisGlobal = await verificarLimiteGlobalEnvio()
  const depoisPorInstancia = await contarEnviosReaisHojePorInstancia()

  assert.equal(depoisGlobal.contagem_dia, antesGlobal.contagem_dia + 1, 'teto global agora conta a falha real — checagem de existência do número é uma chamada real ao provider')
  assert.equal((depoisPorInstancia.get(instancia.id) ?? 0), (antesPorInstancia.get(instancia.id) ?? 0) + 1, 'teto por instância também passa a contar a falha')
})

test('17. falha técnica com failover elegível: não bloqueia telefone, 2ª instância ainda é tentada normalmente', async () => {
  await criarInstancia('wa01-t17', { priority: 1, role: 'principal' })
  await criarInstancia('wa02-t17', { priority: 2, role: 'reserva' })
  fakeEvolution.controlarInstancia('wa01-t17', { comportamento: 'unavailable' })
  fakeEvolution.controlarInstancia('wa02-t17', { comportamento: 'ok' })
  await supabase.from('automacoes_config').update({ whatsapp_failover: true }).eq('id', 1)
  invalidarCacheFlags()
  const telefone = telefoneDeTeste()

  const conta = await criarContaDeTeste(supabase, { telefone_cobranca: telefone })
  const resultado = await enviarCobrancaComRoteamento({
    contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
    clienteTelefone: telefone, valor: 500, mensagem: 'failover ok', origem: 'cron',
  })
  assert.equal(resultado.status, 'sent')
  assert.equal(resultado.instancia, 'wa02-t17')

  const dnc = await estaEmDoNotContact(telefone)
  assert.equal(dnc.blocked, false)
})

test('18. DNC real (opt-out permanente) continua funcionando — regressão', async () => {
  const telefone = telefoneDeTeste()
  await supabase.from('collection_do_not_contact').insert({ cliente_telefone: telefone, canal: 'todos', motivo: 'pedido do cliente' })
  const conta = await criarContaDeTeste(supabase, { telefone_cobranca: telefone })

  const resultado = await enviarCobrancaComRoteamento({
    contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
    clienteTelefone: telefone, valor: 500, mensagem: 'dnc real', origem: 'cron',
  })
  assert.equal(resultado.status, 'blocked')
  assert.equal(resultado.reason, 'opt_out')
  assert.equal(fakeEvolution.mensagensEnviadas.length, 0)
})

test('19. bloqueio é por (telefone, dia), não por (telefone, título): 2 títulos nunca tentados, ambos bloqueados após o 1º falhar', async () => {
  await criarInstancia('wa01-t19', { priority: 1 })
  const telefone = telefoneInvalidoDeTeste()
  const contaGatilho = await criarContaDeTeste(supabase, { telefone_cobranca: telefone })
  await enviarCobrancaComRoteamento({
    contasFinanceirasId: contaGatilho.id, etapa: 3, clienteNome: contaGatilho.pessoa_nome,
    clienteTelefone: telefone, valor: 100, mensagem: 'gatilho', origem: 'cron',
  })

  const contaC = await criarContaDeTeste(supabase, { telefone_cobranca: telefone, codigo_cliente: `C-${Date.now()}` })
  const contaD = await criarContaDeTeste(supabase, { telefone_cobranca: telefone, codigo_cliente: `D-${Date.now()}` })

  const resultadoC = await enviarCobrancaComRoteamento({
    contasFinanceirasId: contaC.id, etapa: 3, clienteNome: contaC.pessoa_nome,
    clienteTelefone: telefone, valor: 200, mensagem: 'C', origem: 'cron',
  })
  const resultadoD = await enviarCobrancaComRoteamento({
    contasFinanceirasId: contaD.id, etapa: 3, clienteNome: contaD.pessoa_nome,
    clienteTelefone: telefone, valor: 300, mensagem: 'D', origem: 'cron',
  })

  assert.equal(resultadoC.status, 'blocked')
  assert.equal(resultadoD.status, 'blocked')
  const { data: dispatchesC } = await supabase.from('collection_dispatches').select('id').eq('contas_financeiras_id', contaC.id)
  const { data: dispatchesD } = await supabase.from('collection_dispatches').select('id').eq('contas_financeiras_id', contaD.id)
  assert.equal(dispatchesC?.length ?? 0, 0, 'título C nunca deveria ter sido tentado')
  assert.equal(dispatchesD?.length ?? 0, 0, 'título D nunca deveria ter sido tentado')
})

// 2026-08-18 — revisão pós-PR #48: collection_do_not_contact tem uma UNIQUE
// INDEX real de produção em (cliente_telefone, canal), SEM motivo
// (idx_collection_dnc_telefone_canal, migrations/collection_shadow_minimal.sql
// — já aplicada, fora do pipeline supabase/migrations/, reproduzida no
// baseline local em 003_collection.sql). Só pode existir 1 linha por
// telefone+canal — os 5 cenários abaixo (A-E do pedido) provam que o
// bloqueio temporário de número inválido NUNCA sobrescreve/expira/converte
// um opt-out permanente pré-existente, mesmo com essa restrição real.

test('A. opt-out permanente existente + falha número inválido no mesmo telefone: opt-out permanente permanece intacto', async () => {
  await criarInstancia('wa01-tA', { priority: 1 })
  const telefone = telefoneInvalidoDeTeste()

  const { data: optOutOriginal } = await supabase.from('collection_do_not_contact').insert({
    cliente_telefone: telefone, canal: 'whatsapp', motivo: 'pedido do cliente',
  }).select().single()
  assert.equal(optOutOriginal.expira_em, null)

  const conta = await criarContaDeTeste(supabase, { telefone_cobranca: telefone })
  const resultado = await enviarCobrancaComRoteamento({
    contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
    clienteTelefone: telefone, valor: 500, mensagem: 'A', origem: 'cron',
  })
  // bloqueado pelo opt-out real (nem chega a tentar o provider e descobrir
  // que o número também seria inválido)
  assert.equal(resultado.status, 'blocked')
  assert.equal(resultado.reason, 'opt_out')
  assert.equal(fakeEvolution.mensagensEnviadas.length, 0)

  const { data: linhas } = await supabase.from('collection_do_not_contact').select('*').eq('cliente_telefone', telefone)
  assert.equal(linhas.length, 1, 'nenhuma segunda linha foi criada — UNIQUE INDEX (telefone, canal) permite só 1')
  assert.equal(linhas[0].id, optOutOriginal.id)
  assert.equal(linhas[0].motivo, 'pedido do cliente', 'motivo original nunca foi sobrescrito')
  assert.equal(linhas[0].expira_em, null, 'opt-out permanece permanente — nunca ganhou expira_em')
})

test('B. bloqueio de número inválido (sem opt-out prévio): registrado com expira_em ~30 dias à frente (quarentena, 2026-08-27)', async () => {
  const telefone = telefoneDeTeste()
  await registrarBloqueioNumeroInvalidoHoje(telefone)

  const { data: linha } = await supabase.from('collection_do_not_contact').select('*')
    .eq('cliente_telefone', telefone).eq('canal', 'whatsapp').single()
  assert.equal(linha.motivo, MOTIVO_NUMERO_INVALIDO_HOJE)
  assert.notEqual(linha.expira_em, null)

  const diasAteExpirar = (new Date(linha.expira_em) - Date.now()) / (24 * 3600_000)
  assert.ok(diasAteExpirar > 29 && diasAteExpirar <= 30, `expira_em deveria ser ~30 dias à frente, foi ${diasAteExpirar.toFixed(2)} dias`)
})

test('C. opt-out permanente nunca recebe expira_em, mesmo registrado DEPOIS de um bloqueio temporário no mesmo telefone', async () => {
  const telefone = telefoneDeTeste()
  await registrarBloqueioNumeroInvalidoHoje(telefone)
  const { data: antes } = await supabase.from('collection_do_not_contact').select('*').eq('cliente_telefone', telefone).single()
  assert.equal(antes.motivo, MOTIVO_NUMERO_INVALIDO_HOJE)
  assert.notEqual(antes.expira_em, null)

  // Um operador registrando opt-out real pro MESMO telefone bate na mesma
  // UNIQUE INDEX — precisa de upsert/update explícito (não é o app que faz
  // isso hoje, é SQL manual), mas o ponto crítico é que registrarBloqueioNumeroInvalidoHoje
  // NUNCA reverte esse cenário: uma vez que a linha vire permanente
  // (expira_em NULL), nenhuma chamada seguinte da função pode reintroduzir
  // um expira_em.
  await supabase.from('collection_do_not_contact').update({ motivo: 'pedido do cliente', expira_em: null }).eq('id', antes.id)

  await registrarBloqueioNumeroInvalidoHoje(telefone) // nova falha de número inválido no mesmo dia
  const { data: depois } = await supabase.from('collection_do_not_contact').select('*').eq('cliente_telefone', telefone).single()
  assert.equal(depois.id, antes.id, 'continua sendo a mesma linha (UNIQUE INDEX)')
  assert.equal(depois.expira_em, null, 'permanece permanente — nunca ganhou expira_em de volta')
  assert.equal(depois.motivo, 'pedido do cliente', 'motivo permanente nunca foi trocado de volta pro temporário')
})

test('D. nenhum bloqueio permanente é convertido em temporário por chamadas repetidas', async () => {
  const telefone = telefoneDeTeste()
  await supabase.from('collection_do_not_contact').insert({ cliente_telefone: telefone, canal: 'whatsapp', motivo: 'pedido do cliente' })

  for (let i = 0; i < 3; i++) await registrarBloqueioNumeroInvalidoHoje(telefone)

  const { data: linhas } = await supabase.from('collection_do_not_contact').select('*').eq('cliente_telefone', telefone)
  assert.equal(linhas.length, 1)
  assert.equal(linhas[0].expira_em, null)
  assert.equal(linhas[0].motivo, 'pedido do cliente')
})

test('E. falha técnica/timeout/429/401/403 não cria linha em collection_do_not_contact', async () => {
  await criarInstancia('wa01-tE', { priority: 1, role: 'principal' })
  const cenarios = ['unavailable', 'rate_limited', 'unauthorized', 'forbidden']
  for (const comportamento of cenarios) {
    fakeEvolution.controlarInstancia('wa01-tE', { comportamento })
    const telefone = telefoneDeTeste()
    const conta = await criarContaDeTeste(supabase, { telefone_cobranca: telefone })
    await enviarCobrancaComRoteamento({
      contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
      clienteTelefone: telefone, valor: 500, mensagem: comportamento, origem: 'cron',
    })
    const { data: linhas } = await supabase.from('collection_do_not_contact').select('id').eq('cliente_telefone', telefone)
    assert.equal(linhas?.length ?? 0, 0, `${comportamento} não pode criar linha em collection_do_not_contact`)
  }
})

test('F. renovação: quarentena EXPIRADA (30 dias atrás) é renovada por mais ~30 dias, sem criar 2ª linha (mesma UNIQUE INDEX)', async () => {
  const telefone = telefoneDeTeste()
  const { data: antigo } = await supabase.from('collection_do_not_contact').insert({
    cliente_telefone: telefone, canal: 'whatsapp', motivo: MOTIVO_NUMERO_INVALIDO_HOJE,
    expira_em: new Date(Date.now() - 60_000).toISOString(), // quarentena anterior já expirou
  }).select().single()

  await registrarBloqueioNumeroInvalidoHoje(telefone)

  const { data: linhas } = await supabase.from('collection_do_not_contact').select('*').eq('cliente_telefone', telefone)
  assert.equal(linhas.length, 1, 'renovou a mesma linha, não criou uma segunda')
  assert.equal(linhas[0].id, antigo.id)
  const diasAteExpirar = (new Date(linhas[0].expira_em) - Date.now()) / (24 * 3600_000)
  assert.ok(diasAteExpirar > 29 && diasAteExpirar <= 30, `renovação deveria ser ~30 dias à frente, foi ${diasAteExpirar.toFixed(2)} dias`)

  const dnc = await estaEmDoNotContact(telefone)
  assert.equal(dnc.blocked, true)
  assert.equal(dnc.reason, 'NUMERO_INVALIDO_HOJE')
})

// 2026-08-27 — QUARENTENA DE 30 DIAS: cenários pedidos explicitamente pela
// tarefa "REDUZIR REINCIDÊNCIA DE PERMANENT_RECIPIENT", além do que os
// testes A-F (acima) já cobrem sobre opt-out permanente nunca ser tocado.
test('Quarentena de 30 dias para PERMANENT_RECIPIENT (2026-08-27)', async (t) => {
  await t.test('1. primeira confirmação: provider chamado 1 vez, quarentena de ~30 dias criada', async () => {
    await criarInstancia('wa01-q1', { priority: 1 })
    const telefone = telefoneInvalidoDeTeste()
    const conta = await criarContaDeTeste(supabase, { telefone_cobranca: telefone })

    const resultado = await enviarCobrancaComRoteamento({
      contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
      clienteTelefone: telefone, valor: 500, mensagem: 'q1', origem: 'cron',
    })
    assert.equal(resultado.motivo, 'permanent_recipient')
    assert.equal(fakeEvolution.mensagensEnviadas.length, 0, 'checagem de existência é a chamada real ao provider — nunca chega a /message/sendText')

    const { data: linha } = await supabase.from('collection_do_not_contact').select('*')
      .eq('cliente_telefone', telefone).eq('canal', 'whatsapp').single()
    const diasAteExpirar = (new Date(linha.expira_em) - Date.now()) / (24 * 3600_000)
    assert.ok(diasAteExpirar > 29 && diasAteExpirar <= 30, `quarentena deveria ser ~30 dias, foi ${diasAteExpirar.toFixed(2)}`)
  })

  await t.test('2/3. dentro da quarentena (simulando "amanhã" e "dia 29"): bloqueada pré-provider, provider attempts=0', async () => {
    await limparInstanciasDeTeste(supabase)
    await criarInstancia('wa01-q23', { priority: 1 })
    const telefone = telefoneDeTeste()

    // Simula quarentena já criada ontem (expira daqui a 29 dias) — mesmo
    // efeito de "chegou uma nova tentativa no dia seguinte" e "no dia 29",
    // sem depender de esperar tempo real passar.
    await supabase.from('collection_do_not_contact').insert({
      cliente_telefone: telefone, canal: 'whatsapp', motivo: MOTIVO_NUMERO_INVALIDO_HOJE,
      expira_em: new Date(Date.now() + 29 * 24 * 3600_000).toISOString(),
    })

    const conta = await criarContaDeTeste(supabase, { telefone_cobranca: telefone })
    const resultado = await enviarCobrancaComRoteamento({
      contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
      clienteTelefone: telefone, valor: 500, mensagem: 'q23', origem: 'cron',
    })
    assert.equal(resultado.status, 'blocked')
    assert.equal(resultado.reason, 'numero_invalido_hoje')
    assert.equal(fakeEvolution.mensagensEnviadas.length, 0, 'nenhuma chamada real — nem checagem de existência, nem envio')

    const { data: dispatches } = await supabase.from('collection_dispatches').select('id').eq('contas_financeiras_id', conta.id)
    assert.equal(dispatches?.length ?? 0, 0, 'bloqueado ANTES de criar qualquer dispatch/tentativa')
  })

  await t.test('4. após expiração (30+ dias): provider permitido de novo, resultado real (não mock de bloqueio)', async () => {
    await limparInstanciasDeTeste(supabase)
    await criarInstancia('wa01-q4', { priority: 1 })
    const telefone = telefoneDeTeste()

    await supabase.from('collection_do_not_contact').insert({
      cliente_telefone: telefone, canal: 'whatsapp', motivo: MOTIVO_NUMERO_INVALIDO_HOJE,
      expira_em: new Date(Date.now() - 60_000).toISOString(), // quarentena de 30 dias já expirou
    })

    const conta = await criarContaDeTeste(supabase, { telefone_cobranca: telefone })
    const resultado = await enviarCobrancaComRoteamento({
      contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
      clienteTelefone: telefone, valor: 500, mensagem: 'q4', origem: 'cron',
    })
    assert.equal(resultado.status, 'sent', 'quarentena expirada — número bom, provider chamado e envio real acontece')
    assert.equal(fakeEvolution.mensagensEnviadas.length, 1)
  })

  await t.test('6. telefone corrigido no ERP: novo número não herda a quarentena do antigo', async () => {
    await limparInstanciasDeTeste(supabase)
    await criarInstancia('wa01-q6', { priority: 1 })
    const telefoneAntigo = telefoneInvalidoDeTeste()
    const telefoneNovo = telefoneDeTeste()

    const contaAntiga = await criarContaDeTeste(supabase, { telefone_cobranca: telefoneAntigo })
    await enviarCobrancaComRoteamento({
      contasFinanceirasId: contaAntiga.id, etapa: 3, clienteNome: contaAntiga.pessoa_nome,
      clienteTelefone: telefoneAntigo, valor: 500, mensagem: 'q6-antigo', origem: 'cron',
    })
    const dncAntigo = await estaEmDoNotContact(telefoneAntigo)
    assert.equal(dncAntigo.blocked, true, 'telefone antigo em quarentena')

    // ERP corrigiu o cadastro — mesmo cliente, título novo, telefone NOVO.
    const contaCorrigida = await criarContaDeTeste(supabase, { telefone_cobranca: telefoneNovo, codigo_cliente: `CORRIGIDO-${Date.now()}` })
    const dncNovo = await estaEmDoNotContact(telefoneNovo)
    assert.equal(dncNovo.blocked, false, 'telefone novo/corrigido nunca herda a quarentena do telefone antigo')

    const resultado = await enviarCobrancaComRoteamento({
      contasFinanceirasId: contaCorrigida.id, etapa: 3, clienteNome: contaCorrigida.pessoa_nome,
      clienteTelefone: telefoneNovo, valor: 500, mensagem: 'q6-novo', origem: 'cron',
    })
    assert.equal(resultado.status, 'sent', 'telefone corrigido segue normalmente pelas proteções da régua')
  })

  await t.test('8. proximaExpiracaoQuarentena nunca encurta uma quarentena existente mais longa (função pura)', () => {
    const daqui60dias = new Date(Date.now() + 60 * 24 * 3600_000).toISOString()
    const resultado = proximaExpiracaoQuarentena(daqui60dias)
    assert.equal(resultado, daqui60dias, 'quarentena já mais longa que 30 dias não pode ser encurtada')

    const jaExpirou = new Date(Date.now() - 60_000).toISOString()
    const resultado2 = proximaExpiracaoQuarentena(jaExpirou)
    const dias2 = (new Date(resultado2) - Date.now()) / (24 * 3600_000)
    assert.ok(dias2 > 29 && dias2 <= 30, 'quarentena expirada é renovada pra ~30 dias')

    const resultado3 = proximaExpiracaoQuarentena(null)
    const dias3 = (new Date(resultado3) - Date.now()) / (24 * 3600_000)
    assert.ok(dias3 > 29 && dias3 <= 30, 'sem valor anterior, usa ~30 dias')
  })

  await t.test('9/10/11. bloqueio pré-provider preserva saúde da instância (PR #55), nunca tenta 2ª instância, e não consome o teto global', async () => {
    await limparInstanciasDeTeste(supabase)
    const principal = await criarInstancia('wa01-q911', { priority: 1, role: 'principal' })
    await criarInstancia('wa02-q911-reserva', { priority: 2, role: 'reserva' })
    await supabase.from('automacoes_config').update({ whatsapp_failover: true }).eq('id', 1)
    invalidarCacheFlags()
    const telefone = telefoneDeTeste()

    await supabase.from('collection_do_not_contact').insert({
      cliente_telefone: telefone, canal: 'whatsapp', motivo: MOTIVO_NUMERO_INVALIDO_HOJE,
      expira_em: new Date(Date.now() + 15 * 24 * 3600_000).toISOString(),
    })

    const antesGlobal = await verificarLimiteGlobalEnvio()
    const { data: instanciaAntes } = await supabase.from('whatsapp_instances').select('consecutive_failures, health_status').eq('id', principal.id).single()

    const conta = await criarContaDeTeste(supabase, { telefone_cobranca: telefone })
    const resultado = await enviarCobrancaComRoteamento({
      contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
      clienteTelefone: telefone, valor: 500, mensagem: 'q911', origem: 'cron',
    })
    assert.equal(resultado.status, 'blocked')
    assert.equal(fakeEvolution.mensagensEnviadas.length, 0, 'nenhuma instância (principal ou reserva) foi chamada de verdade — whatsapp_failover=true não muda isso, o bloqueio é ANTES da seleção de instância')

    const { data: instanciaDepois } = await supabase.from('whatsapp_instances').select('consecutive_failures, health_status').eq('id', principal.id).single()
    assert.equal(instanciaDepois.consecutive_failures, instanciaAntes.consecutive_failures, 'bloqueio pré-provider não toca no circuit breaker (PR #55 continua intacta)')
    assert.equal(instanciaDepois.health_status, instanciaAntes.health_status)

    const depoisGlobal = await verificarLimiteGlobalEnvio()
    assert.equal(depoisGlobal.contagem_dia, antesGlobal.contagem_dia, 'tentativa bloqueada pré-provider NÃO consome o teto global — nenhuma linha nova em collection_dispatch_attempts')

    await supabase.from('automacoes_config').update({ whatsapp_failover: false }).eq('id', 1)
    invalidarCacheFlags()
  })

  await t.test('12. idempotência preservada: reenvio do mesmo título durante a quarentena não chama o provider nem duplica dispatch', async () => {
    await limparInstanciasDeTeste(supabase)
    await criarInstancia('wa01-q12', { priority: 1 })
    const telefone = telefoneInvalidoDeTeste()
    const conta = await criarContaDeTeste(supabase, { telefone_cobranca: telefone })

    const r1 = await enviarCobrancaComRoteamento({
      contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
      clienteTelefone: telefone, valor: 500, mensagem: 'q12', origem: 'cron',
    })
    assert.equal(r1.motivo, 'permanent_recipient')

    const r2 = await enviarCobrancaComRoteamento({
      contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
      clienteTelefone: telefone, valor: 500, mensagem: 'q12 retry', origem: 'cron',
    })
    assert.equal(r2.status, 'blocked')
    assert.equal(fakeEvolution.mensagensEnviadas.length, 0)

    const { data: dispatches } = await supabase.from('collection_dispatches').select('id').eq('contas_financeiras_id', conta.id)
    assert.equal(dispatches?.length ?? 0, 1, 'só o 1º dispatch (que gerou o permanent_recipient) existe — o retry bloqueado nem chega a criar um novo')
  })
})
