// 2026-08-15 — 16 cenários do pedido "CORREÇÃO PRIORITÁRIA — DNC/OPT-OUT NO
// CAMINHO REAL DE COBRANÇA". Achado real: collection_do_not_contact só era
// lida pelo shadow (nextBestAction.js) — o caminho real (cron, /disparar,
// /disparar-individual, motor legado E v2) nunca verificava opt-out. Contra
// o CÓDIGO REAL, Postgres local e Fake Evolution — nenhum WhatsApp de
// verdade em nenhum cenário.
import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste, criarContaDeTeste, limparInstanciasDeTeste } from './_setup.mjs'

let supabase, fakeEvolution, enviarCobrancaComRoteamento, executarReguaCobranca, invalidarCacheFlags
let estaEmDoNotContact, carregarContextoNba, decidirProximaAcao, runCollectionShadow

before(async () => {
  fakeEvolution = await iniciarAmbienteDeTeste()
  ;({ supabase } = await import('../../../src/lib/supabase-admin.server.js'))
  ;({ enviarCobrancaComRoteamento } = await import('../../../src/lib/collection/collectionRouting.js'))
  ;({ executarReguaCobranca } = await import('../../../src/jobs/cobranca-whatsapp.js'))
  ;({ invalidarCacheFlags } = await import('../../../src/lib/collection/featureFlags.js'))
  ;({ estaEmDoNotContact } = await import('../../../src/lib/collection/doNotContactGuard.js'))
  ;({ carregarContextoNba, decidirProximaAcao } = await import('../../../src/lib/collection/nextBestAction.js'))
  ;({ runCollectionShadow } = await import('../../../src/jobs/collection-shadow.js'))
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

async function registrarDnc(telefone, motivo = 'teste') {
  const { error } = await supabase.from('collection_do_not_contact').insert({ cliente_telefone: telefone, canal: 'todos', motivo })
  if (error) throw error
}

async function limparDnc() {
  await supabase.from('collection_do_not_contact').delete().neq('id', '00000000-0000-0000-0000-000000000000')
}

// executarReguaCobranca() varre TODA contas_financeiras elegível — sem
// isolamento, os testes 3/4 (que precisam de sync FRESCO pra realmente
// entrar no loop e alcançar o guard de DNC, diferente dos testes de
// financialSyncGuard que retornam antes do loop) rodariam contra qualquer
// resíduo de OUTROS arquivos de teste no mesmo Postgres local — não
// determinístico (depende da ordem/estado da suíte) e lento (45-90s reais de
// intervalo por envio, proposital em produção). Em vez de pular quando há
// resíduo, isola de verdade: tira temporariamente da elegibilidade (status
// 'cancelada') todo título que não seja da própria conta de teste, roda o
// cenário, e RESTAURA o status original de cada um no finally — nunca perde
// nem corrompe dado de outro arquivo, só neutraliza pela duração exata desta
// chamada. Preciso capturar o status ANTES de criar a conta de teste, senão
// ela própria entraria na lista a isolar.
async function comCarteiraIsoladaPara(contaId, fn) {
  const { data: outras, error } = await supabase
    .from('contas_financeiras')
    .select('id, status')
    .eq('tipo', 'receber')
    .in('status', ['aberta', 'vencida', 'pago_parcial'])
    .neq('id', contaId)
  if (error) throw error

  const porStatusOriginal = {}
  for (const o of outras ?? []) (porStatusOriginal[o.status] ??= []).push(o.id)
  const idsIsolados = (outras ?? []).map((o) => o.id)

  if (idsIsolados.length) {
    await supabase.from('contas_financeiras').update({ status: 'cancelada' }).in('id', idsIsolados)
  }
  try {
    return await fn()
  } finally {
    for (const [statusOriginal, ids] of Object.entries(porStatusOriginal)) {
      await supabase.from('contas_financeiras').update({ status: statusOriginal }).in('id', ids)
    }
  }
}

beforeEach(async () => {
  fakeEvolution.resetar()
  await limparInstanciasDeTeste(supabase)
  await limparDnc()
  await garantirSyncFinanceiroFresco()
  await supabase.from('automacoes_config').update({
    multi_whatsapp: false, whatsapp_failover: false, cobranca_whatsapp_ativa: true,
  }).eq('id', 1)
  invalidarCacheFlags()
})

test('1. sem DNC: fluxo continua normalmente (controle — prova que o guard não bloqueia por padrão)', async () => {
  const conta = await criarContaDeTeste(supabase)
  const resultado = await enviarCobrancaComRoteamento({
    contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
    clienteTelefone: conta.telefone_cobranca, valor: 500, mensagem: 'sem DNC', origem: 'cron',
  })
  assert.equal(resultado.status, 'sent')
  assert.equal(fakeEvolution.mensagensEnviadas.some((m) => m.numero === conta.telefone_cobranca), true)
})

test('2. DNC ativo: envio bloqueado (motor legado, multi_whatsapp=false)', async () => {
  const conta = await criarContaDeTeste(supabase)
  await registrarDnc(conta.telefone_cobranca)

  const resultado = await enviarCobrancaComRoteamento({
    contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
    clienteTelefone: conta.telefone_cobranca, valor: 500, mensagem: 'DNC ativo', origem: 'cron',
  })
  assert.equal(resultado.status, 'blocked')
  assert.equal(resultado.reason, 'opt_out')
  assert.equal(fakeEvolution.mensagensEnviadas.length, 0)
})

test('3. DNC ativo + disparo automático (cron/executarReguaCobranca): bloqueado, zero envio', { timeout: 120_000 }, async (t) => {
  const horaBrt = (new Date().getUTCHours() - 3 + 24) % 24
  if (!(horaBrt >= 8 && horaBrt < 17)) { t.skip('fora da janela 08h-17h BRT — dentroDoHorarioPermitido() bloquearia antes, não mede o guard de DNC'); return }

  const conta = await criarContaDeTeste(supabase, { vencimento: new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10) })
  await registrarDnc(conta.telefone_cobranca)

  // Isola a carteira (ver comCarteiraIsoladaPara) — com sync fresco o loop
  // real do cron entra de verdade; sem isolamento ele processaria qualquer
  // resíduo de outro arquivo também, de forma não determinística. Espera
  // real de 45-90s (aguardarIntervaloAleatorio, ANTES até de alcançar o
  // guard) — proposital, por isso o timeout de 120s neste teste.
  await comCarteiraIsoladaPara(conta.id, async () => {
    const resumo = await executarReguaCobranca()
    assert.equal(resumo.enviadas, 0)

    const { data: cobrancas } = await supabase.from('cobrancas_whatsapp').select('id').eq('contas_financeiras_id', conta.id)
    assert.equal(cobrancas.length, 0, 'DNC não pode gerar linha de cobrança enviada')
    assert.equal(fakeEvolution.mensagensEnviadas.some((m) => m.numero === conta.telefone_cobranca), false)
  })
})

test('4. DNC ativo + POST /api/cobrancas/disparar: bloqueado (mesma executarReguaCobranca do cenário 3)', { timeout: 120_000 }, async (t) => {
  const horaBrt = (new Date().getUTCHours() - 3 + 24) % 24
  if (!(horaBrt >= 8 && horaBrt < 17)) { t.skip('fora da janela 08h-17h BRT'); return }

  process.env.API_SECRET_KEY = 'chave-teste-dnc-guard'
  const express = (await import('express')).default
  const { auth, adminOnly } = await import('../../../src/middleware/auth.js')
  const cobrancasRouter = (await import('../../../src/routes/cobrancas.js')).default
  const app = express()
  app.use(express.json())
  app.use('/api/cobrancas', auth, adminOnly, cobrancasRouter)
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  const porta = server.address().port

  const conta = await criarContaDeTeste(supabase, { vencimento: new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10) })
  await registrarDnc(conta.telefone_cobranca)

  try {
    await comCarteiraIsoladaPara(conta.id, async () => {
      const resultado = await new Promise((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1', port: porta, method: 'POST', path: '/api/cobrancas/disparar',
          headers: { authorization: 'Bearer chave-teste-dnc-guard' },
        }, (res) => {
          let chunks = ''
          res.on('data', (c) => { chunks += c })
          res.on('end', () => resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null }))
        })
        req.on('error', reject)
        req.end()
      })

      assert.equal(resultado.status, 200)
      assert.equal(resultado.body.enviadas, 0)
      const { data: cobrancas } = await supabase.from('cobrancas_whatsapp').select('id').eq('contas_financeiras_id', conta.id)
      assert.equal(cobrancas.length, 0)
    })
  } finally {
    server.close()
  }
})

test('5. DNC ativo + POST /api/cobrancas/disparar-individual/:pessoaNome: bloqueado', async () => {
  process.env.API_SECRET_KEY = 'chave-teste-dnc-guard-individual'
  const express = (await import('express')).default
  const { auth, adminOnly } = await import('../../../src/middleware/auth.js')
  const cobrancasRouter = (await import('../../../src/routes/cobrancas.js')).default
  const app = express()
  app.use(express.json())
  app.use('/api/cobrancas', auth, adminOnly, cobrancasRouter)
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  const porta = server.address().port

  // Nome único por execução: a rota agrupa por pessoa_nome e pega o primeiro
  // telefone encontrado — um nome reutilizado entre execuções deste arquivo
  // (sem reset de banco entre runs manuais) faria a rota achar um título
  // ANTIGO com outro telefone (fora do DNC desta execução), mascarando o
  // guard real com um falso positivo de sucesso.
  const nomeUnico = `Cliente Teste DNC Individual ${Date.now()}`
  const conta = await criarContaDeTeste(supabase, {
    pessoa_nome: nomeUnico,
    vencimento: new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10),
  })
  await registrarDnc(conta.telefone_cobranca)

  const resultado = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: porta, method: 'POST',
      path: `/api/cobrancas/disparar-individual/${encodeURIComponent(nomeUnico)}`,
      headers: { authorization: 'Bearer chave-teste-dnc-guard-individual', 'content-type': 'application/json' },
    }, (res) => {
      let chunks = ''
      res.on('data', (c) => { chunks += c })
      res.on('end', () => resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null }))
    })
    req.on('error', reject)
    req.end()
  })
  server.close()

  assert.equal(resultado.status, 400, 'bloqueio por DNC deve responder 400, nunca 201')
  assert.match(resultado.body.erro, /opt|DNC/i)
  const { data: cobrancas } = await supabase.from('cobrancas_whatsapp').select('id').eq('contas_financeiras_id', conta.id)
  assert.equal(cobrancas.length, 0)
  assert.equal(fakeEvolution.mensagensEnviadas.length, 0)
})

test('6. DNC ativo + multi_whatsapp=true: nenhuma instância usada, motor v2 nem tenta selecionar', async () => {
  await criarInstancia('wa01-dnc-6', { priority: 1 })
  await criarInstancia('wa02-dnc-6', { priority: 2, role: 'reserva' })
  fakeEvolution.controlarInstancia('wa01-dnc-6', { comportamento: 'ok' })
  fakeEvolution.controlarInstancia('wa02-dnc-6', { comportamento: 'ok' })
  await supabase.from('automacoes_config').update({ multi_whatsapp: true }).eq('id', 1)
  invalidarCacheFlags()

  const conta = await criarContaDeTeste(supabase)
  await registrarDnc(conta.telefone_cobranca)

  const resultado = await enviarCobrancaComRoteamento({
    contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
    clienteTelefone: conta.telefone_cobranca, valor: 500, mensagem: 'DNC multi', origem: 'cron',
  })
  assert.equal(resultado.status, 'blocked')
  assert.equal(resultado.reason, 'opt_out')
  assert.equal(fakeEvolution.mensagensEnviadas.length, 0)

  const { data: dispatches } = await supabase.from('collection_dispatches').select('id').eq('contas_financeiras_id', conta.id)
  assert.equal(dispatches?.length ?? 0, 0, 'nenhum dispatch (nem tentativa de escolher instância) deveria ter sido criado')
})

test('7. DNC ativo + whatsapp_failover=true (failover hipotético): não tenta nem a 1ª nem a 2ª instância', async () => {
  await criarInstancia('wa01-dnc-7', { priority: 1 })
  await criarInstancia('wa02-dnc-7', { priority: 2, role: 'reserva' })
  fakeEvolution.controlarInstancia('wa01-dnc-7', { comportamento: 'fail_explicit' }) // se o guard não bloqueasse, isso forçaria tentar a 2ª
  fakeEvolution.controlarInstancia('wa02-dnc-7', { comportamento: 'ok' })
  await supabase.from('automacoes_config').update({ multi_whatsapp: true, whatsapp_failover: true }).eq('id', 1)
  invalidarCacheFlags()

  const conta = await criarContaDeTeste(supabase)
  await registrarDnc(conta.telefone_cobranca)

  const resultado = await enviarCobrancaComRoteamento({
    contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
    clienteTelefone: conta.telefone_cobranca, valor: 500, mensagem: 'DNC failover', origem: 'cron',
  })
  assert.equal(resultado.status, 'blocked')
  assert.equal(fakeEvolution.mensagensEnviadas.length, 0, 'nem wa01 nem wa02 (failover) deveriam ter recebido nada')
})

test('8. DNC ativo: zero provider attempts (collection_dispatch_attempts)', async () => {
  await criarInstancia('wa01-dnc-8', { priority: 1 })
  await supabase.from('automacoes_config').update({ multi_whatsapp: true }).eq('id', 1)
  invalidarCacheFlags()
  const conta = await criarContaDeTeste(supabase)
  await registrarDnc(conta.telefone_cobranca)

  await enviarCobrancaComRoteamento({
    contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
    clienteTelefone: conta.telefone_cobranca, valor: 500, mensagem: 'DNC attempts', origem: 'cron',
  })

  const { data: dispatches } = await supabase.from('collection_dispatches').select('id').eq('contas_financeiras_id', conta.id)
  assert.equal(dispatches?.length ?? 0, 0)
})

test('9. DNC ativo: zero mensagem real (Fake Evolution nunca recebe requisição)', async () => {
  const conta = await criarContaDeTeste(supabase)
  await registrarDnc(conta.telefone_cobranca)
  await enviarCobrancaComRoteamento({
    contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
    clienteTelefone: conta.telefone_cobranca, valor: 500, mensagem: 'DNC zero msg', origem: 'cron',
  })
  assert.equal(fakeEvolution.mensagensEnviadas.length, 0)
})

test('10. DNC não conta como falha técnica de instância (health/circuit breaker intocado)', async () => {
  const instancia = await criarInstancia('wa01-dnc-10', { priority: 1 })
  await supabase.from('automacoes_config').update({ multi_whatsapp: true }).eq('id', 1)
  invalidarCacheFlags()
  const conta = await criarContaDeTeste(supabase)
  await registrarDnc(conta.telefone_cobranca)

  await enviarCobrancaComRoteamento({
    contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
    clienteTelefone: conta.telefone_cobranca, valor: 500, mensagem: 'DNC health', origem: 'cron',
  })

  const { data: depois } = await supabase.from('whatsapp_instances').select('consecutive_failures, health_status').eq('id', instancia.id).single()
  assert.equal(depois.consecutive_failures, 0, 'DNC nunca deveria incrementar falha técnica da instância — ela nem chega a ser selecionada')
  assert.equal(depois.health_status, instancia.health_status, 'health_status não pode ter sido tocado — mesmo valor de quando a instância foi criada')
})

test('11. DNC não incrementa contador de envio (cobrancas_whatsapp / collection_dispatches seguem em 0)', async () => {
  const conta = await criarContaDeTeste(supabase)
  await registrarDnc(conta.telefone_cobranca)
  await enviarCobrancaComRoteamento({
    contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
    clienteTelefone: conta.telefone_cobranca, valor: 500, mensagem: 'DNC contador', origem: 'cron',
  })
  const { data: cobrancas } = await supabase.from('cobrancas_whatsapp').select('id').eq('contas_financeiras_id', conta.id)
  const { data: dispatches } = await supabase.from('collection_dispatches').select('id').eq('contas_financeiras_id', conta.id)
  assert.equal(cobrancas?.length ?? 0, 0)
  assert.equal(dispatches?.length ?? 0, 0)
})

test('12. DNC não deixa resíduo que burle idempotência — removendo o DNC, o envio normal volta a funcionar e cria exatamente 1 dispatch', async () => {
  await criarInstancia('wa01-dnc-12', { priority: 1 })
  await supabase.from('automacoes_config').update({ multi_whatsapp: true }).eq('id', 1)
  invalidarCacheFlags()
  fakeEvolution.controlarInstancia('wa01-dnc-12', { comportamento: 'ok' })
  const conta = await criarContaDeTeste(supabase)
  await registrarDnc(conta.telefone_cobranca)

  const bloqueado = await enviarCobrancaComRoteamento({
    contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
    clienteTelefone: conta.telefone_cobranca, valor: 500, mensagem: 'msg', origem: 'cron',
  })
  assert.equal(bloqueado.status, 'blocked')

  await limparDnc()
  const permitido = await enviarCobrancaComRoteamento({
    contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
    clienteTelefone: conta.telefone_cobranca, valor: 500, mensagem: 'msg', origem: 'cron',
  })
  assert.equal(permitido.status, 'sent')

  const { data: dispatches } = await supabase.from('collection_dispatches').select('id').eq('contas_financeiras_id', conta.id)
  assert.equal(dispatches?.length, 1, 'DNC bloqueado não criou dispatch nenhum — depois de removido, exatamente 1 dispatch novo, sem duplicidade')
})

test('13. schema de collection_do_not_contact não tem conceito de ativo/expires_at — presença de linha é opt-out permanente (confirmado por auditoria de produção, ver PR)', async () => {
  // Produção (information_schema, checado manualmente): id, cliente_telefone,
  // motivo, canal, solicitado_em, registrado_por — sem coluna "ativo" nem
  // "expires_at". Insere só os campos documentados e confirma que a mera
  // existência da linha já bloqueia, sem precisar de nenhum estado adicional.
  const conta = await criarContaDeTeste(supabase)
  await registrarDnc(conta.telefone_cobranca)
  const resultado = await estaEmDoNotContact(conta.telefone_cobranca)
  assert.equal(resultado.blocked, true, 'a mera existência da linha já bloqueia — não existe um estado "inativo" a ser respeitado')
})

test('14. erro ao consultar DNC (banco indisponível/erro inesperado) => fail-closed, sem envio', async () => {
  const originalFrom = supabase.from
  const resultadoErro = { data: null, error: { message: 'falha simulada de conexão' } }
  const chainable = { select: () => chainable, eq: () => chainable, in: () => chainable, limit: () => chainable, then: (resolve) => resolve(resultadoErro) }
  supabase.from = (tabela) => (tabela === 'collection_do_not_contact' ? chainable : originalFrom(tabela))

  try {
    const conta = await criarContaDeTeste(supabase)
    const guard = await estaEmDoNotContact(conta.telefone_cobranca)
    assert.equal(guard.blocked, true)
    assert.equal(guard.reason, 'DNC_GUARD_ERROR')

    const resultado = await enviarCobrancaComRoteamento({
      contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
      clienteTelefone: conta.telefone_cobranca, valor: 500, mensagem: 'erro guard', origem: 'cron',
    })
    assert.equal(resultado.status, 'blocked', 'erro do guard nunca pode virar "pode enviar"')
    assert.match(resultado.motivo, /DNC_GUARD_ERROR/)
    assert.equal(fakeEvolution.mensagensEnviadas.length, 0)
  } finally {
    supabase.from = originalFrom
  }
})

test('15. comportamento do nextBestAction (carregarContextoNba/decidirProximaAcao) continua igual após extrair a leitura pro helper compartilhado', async () => {
  const conta = await criarContaDeTeste(supabase)
  await registrarDnc(conta.telefone_cobranca)

  const contexto = await carregarContextoNba(conta.id)
  assert.ok(contexto.encerrado)
  assert.equal(contexto.encerrado.acao, 'NO_ACTION')
  assert.deepEqual(contexto.encerrado.reason_codes, ['OPT_OUT'])

  const nba = await decidirProximaAcao(conta.id)
  assert.equal(nba.acao, 'NO_ACTION')
  assert.deepEqual(nba.reason_codes, ['OPT_OUT'])
})

test('16. effective_legacy_action (shadow) continua reconhecendo OPT_OUT após a extração do helper', async () => {
  const conta = await criarContaDeTeste(supabase)
  await registrarDnc(conta.telefone_cobranca)

  await supabase.from('automacoes_config').update({ nba_shadow_mode: true, score_shadow_mode: false, shadow_max_customers: 1000 }).eq('id', 1)
  invalidarCacheFlags()
  await runCollectionShadow()
  const { data: log } = await supabase.from('nba_shadow_log').select('*').eq('contas_financeiras_id', conta.id).order('criado_em', { ascending: false }).limit(1).maybeSingle()
  await supabase.from('automacoes_config').update({ nba_shadow_mode: false, shadow_max_customers: 50 }).eq('id', 1)
  invalidarCacheFlags()

  assert.ok(log)
  assert.equal(log.legacy_action, 'WHATSAPP')
  assert.equal(log.effective_legacy_action, 'NO_ACTION')
  assert.equal(log.blocked_reason, 'OPT_OUT')
})
