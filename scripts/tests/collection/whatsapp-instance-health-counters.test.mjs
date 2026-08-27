// 2026-08-15 — hardening de contadores/health por instância, achados B1/B3
// da investigação de produção:
//   B1: whatsapp_instances.sent_today divergia de envios reais — soma
//       dispatches purpose='internal_test' (nunca deveria contar pro limite
//       real) e reseta de forma PREGUIÇOSA (só no próximo dispatch), então
//       lido direto do banco num dia sem nenhum envio ainda mostra o valor
//       do ÚLTIMO dia que teve envio. Corrigido: daily_limit agora usa
//       contarEnviosReaisHojePorInstancia() (fonte canônica: envios reais
//       persistidos, purpose='collection', hoje BRT), não mais sent_today.
//   B3: atualizarStatusConexao marcava health_status='connected' sempre que
//       a Evolution respondia 'open', mesmo com cooldown_until no futuro —
//       o comentário afirmava que isso era respeitado, o código não checava.
//       Corrigido: health_status só é tocado quando não há cooldown ativo.
// Nenhum WhatsApp real enviado — tudo via fakeEvolution/Postgres local.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste, criarContaDeTeste, limparInstanciasDeTeste } from './_setup.mjs'

async function criarInstancia(supabase, nome, overrides = {}) {
  const { data, error } = await supabase.from('whatsapp_instances').insert({
    name: nome, instance_name: nome, priority: 1, role: 'principal', enabled: true, ...overrides,
  }).select().single()
  if (error) throw error
  return data
}

async function garantirSyncFinanceiroFresco(supabase) {
  await supabase.from('sincronizacoes_financeiro').delete().neq('id', '00000000-0000-0000-0000-000000000000')
  const agora = new Date().toISOString()
  const { error } = await supabase.from('sincronizacoes_financeiro').insert({
    status: 'concluido', dry_run: false, iniciado_em: agora, concluido_em: agora,
    total_lido: 1, total_atualizado: 0, total_sem_alteracao: 0, total_sem_match: 0,
    total_conflito: 0, total_cancelado: 0, total_com_erro: 0,
  })
  if (error) throw error
}

test('WhatsApp: contadores canônicos + cooldown respeitado pelo healthcheck', async (t) => {
  const fakeEvolution = await iniciarAmbienteDeTeste()
  const { supabase } = await import('../../../src/lib/supabase-admin.server.js')
  const { contarEnviosReaisHojePorInstancia, selecionarProximaInstancia, atualizarStatusConexao, registrarFalhaEnvio } = await import('../../../src/lib/collection/whatsappInstances.js')
  const { enviarCobrancaComRoteamento } = await import('../../../src/lib/collection/collectionRouting.js')
  const { enviarTesteInterno } = await import('../../../src/lib/collection/dispatchEngine.js')
  const { invalidarCacheFlags } = await import('../../../src/lib/collection/featureFlags.js')

  async function resetar() {
    fakeEvolution.resetar()
    await limparInstanciasDeTeste(supabase)
    // O teto global (globalSendLimit.js, PR #31) conta cobrancas_whatsapp
    // SEM filtro por teste — precisa começar zerado, senão o seed sintético
    // do banco local (ou testes anteriores no mesmo processo) vaza contagem.
    await supabase.from('cobrancas_whatsapp').delete().neq('id', '00000000-0000-0000-0000-000000000000')
    await supabase.from('automacoes_config').update({ multi_whatsapp: true, whatsapp_failover: false, global_daily_limit: 30, global_hourly_limit: 10 }).eq('id', 1)
    await garantirSyncFinanceiroFresco(supabase)
    invalidarCacheFlags()
    // COLLECTION_TEST_MODE=true bloqueia QUALQUER envio pra número fora da
    // allowlist (proteção deliberada, ver evolutionAdapter.js) — inclusive
    // cobrança real pro telefone aleatório que criarContaDeTeste gera. Fica
    // desligado por padrão; só o teste 1 (que usa enviarTesteInterno) liga
    // isso, e desfaz antes do resto do teste continuar.
    delete process.env.COLLECTION_TEST_MODE
    delete process.env.COLLECTION_TEST_PHONE_ALLOWLIST
  }

  await t.test('1. sent_today (internal_test) NÃO conta na fonte canônica — só envios reais (purpose=collection)', async () => {
    await resetar()
    const instancia = await criarInstancia(supabase, 'wa01-b1')
    fakeEvolution.controlarInstancia('wa01-b1', { comportamento: 'ok' })

    // COLLECTION_TEST_MODE só ligado durante o dispatch técnico em si —
    // bloquearia a cobrança real logo abaixo (telefone aleatório, fora da
    // allowlist) se continuasse ligado.
    process.env.COLLECTION_TEST_MODE = 'true'
    process.env.COLLECTION_TEST_PHONE_ALLOWLIST = '5551900000001'
    await enviarTesteInterno({ testKey: `teste-${Date.now()}`, telefone: '5551900000001', mensagem: 'homologação' })
    delete process.env.COLLECTION_TEST_MODE
    delete process.env.COLLECTION_TEST_PHONE_ALLOWLIST

    const contagemApenasTest = await contarEnviosReaisHojePorInstancia()
    assert.equal(contagemApenasTest.get(instancia.id) ?? 0, 0, 'dispatch internal_test não deveria contar como envio real de cobrança')

    const conta = await criarContaDeTeste(supabase)
    await enviarCobrancaComRoteamento({ contasFinanceirasId: conta.id, etapa: 1, clienteNome: conta.pessoa_nome, clienteTelefone: conta.telefone_cobranca, valor: conta.valor, mensagem: 'cobrança real', origem: 'cron' })
    const contagemComReal = await contarEnviosReaisHojePorInstancia()
    assert.equal(contagemComReal.get(instancia.id), 1, 'só a cobrança real (purpose=collection) deveria contar')
  })

  await t.test('2. só conta envios de HOJE (BRT) — tentativa de ontem não entra na contagem de hoje', async () => {
    await resetar()
    const instancia = await criarInstancia(supabase, 'wa01-b2')
    const conta = await criarContaDeTeste(supabase)
    const { data: dispatch } = await supabase.from('collection_dispatches').insert({
      contas_financeiras_id: conta.id, etapa: 1, canal: 'whatsapp', idempotency_key: `k-${Date.now()}`,
      status: 'sent', origem: 'cron', mensagem: 'x', cliente_nome: conta.pessoa_nome, cliente_telefone: conta.telefone_cobranca, valor: 100,
      criado_em: new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString(),
    }).select().single()
    // 2026-08-18 — criado_em (não só enviado_em) precisa ser backdatado: a
    // fonte canônica agora filtra por criado_em (sempre populado no INSERT
    // real, diferente de enviado_em/falhou_em que ficam NULL até o
    // desfecho) — sem isso, o INSERT abaixo assumiria criado_em=agora
    // (default now()) e o teste pararia de provar o que se propõe a provar.
    await supabase.from('collection_dispatch_attempts').insert({
      dispatch_id: dispatch.id, attempt_number: 1, whatsapp_instance_id: instancia.id, status: 'sent',
      enviado_em: new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString(),
      criado_em: new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString(),
    })
    const contagem = await contarEnviosReaisHojePorInstancia()
    assert.equal(contagem.get(instancia.id) ?? 0, 0, 'envio de mais de 26h atrás (ontem) não deveria contar como "hoje"')
  })

  await t.test('3. retry (mesma tentativa técnica repetida dentro do mesmo dispatch) não duplica contagem', async () => {
    await resetar()
    const instancia = await criarInstancia(supabase, 'wa01-b3')
    fakeEvolution.controlarInstancia('wa01-b3', { comportamento: 'ok' })
    const conta = await criarContaDeTeste(supabase)
    await enviarCobrancaComRoteamento({ contasFinanceirasId: conta.id, etapa: 2, clienteNome: conta.pessoa_nome, clienteTelefone: conta.telefone_cobranca, valor: conta.valor, mensagem: 'x', origem: 'cron' })
    // 2ª chamada lógica idêntica (idempotência) — não deveria gerar 2º envio real.
    await enviarCobrancaComRoteamento({ contasFinanceirasId: conta.id, etapa: 2, clienteNome: conta.pessoa_nome, clienteTelefone: conta.telefone_cobranca, valor: conta.valor, mensagem: 'x', origem: 'manual' })
    const contagem = await contarEnviosReaisHojePorInstancia()
    assert.equal(contagem.get(instancia.id), 1, 'idempotência: mesma cobrança lógica não deveria contar 2x')
    assert.equal(fakeEvolution.mensagensEnviadas.length, 1)
  })

  await t.test('4. failover entre instâncias — cada instância conta cada tentativa REAL que ela recebeu (sucesso ou falha), sem duplicar', async () => {
    await resetar()
    const principal = await criarInstancia(supabase, 'wa01-b4', { priority: 1, role: 'principal' })
    const reserva = await criarInstancia(supabase, 'wa02-b4', { priority: 2, role: 'reserva' })
    fakeEvolution.controlarInstancia('wa01-b4', { comportamento: 'unavailable' })
    fakeEvolution.controlarInstancia('wa02-b4', { comportamento: 'ok' })
    await supabase.from('automacoes_config').update({ whatsapp_failover: true }).eq('id', 1)
    invalidarCacheFlags()

    const conta = await criarContaDeTeste(supabase)
    const resultado = await enviarCobrancaComRoteamento({ contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome, clienteTelefone: conta.telefone_cobranca, valor: conta.valor, mensagem: 'x', origem: 'cron' })
    assert.equal(resultado.status, 'sent')

    // CORREÇÃO 2026-08-18 (gap de rate limit): a PRINCIPAL recebeu 1 chamada
    // HTTP real (que falhou) — isso agora conta pra proteção anti-ban dela,
    // exatamente o risco que o daily_limit por instância existe pra conter.
    // Antes desta correção, uma falha real nunca consumia nada (gap
    // comprovado na auditoria de 2026-08-18) — não é mais "só o que ELA
    // enviou com sucesso", é "toda tentativa real que ela recebeu".
    const contagem = await contarEnviosReaisHojePorInstancia()
    assert.equal(contagem.get(principal.id), 1, 'principal recebeu 1 tentativa real (que falhou) — agora conta, não fica invisível pro anti-ban')
    assert.equal(contagem.get(reserva.id), 1, 'reserva recebeu 1 tentativa real (que teve sucesso) — conta 1 pra ela, não 2x')
  })

  await t.test('5. cooldown ativo + healthcheck respondendo "open" → continua bloqueado (não fura o circuit breaker)', async () => {
    await resetar()
    const instancia = await criarInstancia(supabase, 'wa01-b5', {
      health_status: 'cooldown', cooldown_until: new Date(Date.now() + 10 * 60 * 1000).toISOString(), // 10min no futuro
    })
    await atualizarStatusConexao('wa01-b5', 'open') // Evolution responde conectado
    const { data: depois } = await supabase.from('whatsapp_instances').select('health_status, connection_status, cooldown_until').eq('id', instancia.id).single()
    assert.equal(depois.health_status, 'cooldown', 'cooldown ativo não deveria ser furado só porque a Evolution respondeu "open"')
    assert.equal(depois.connection_status, 'open', 'conectividade física continua sendo registrada normalmente, separada do circuit breaker')
    assert.ok(new Date(depois.cooldown_until).getTime() > Date.now(), 'cooldown_until preservado, não zerado')
  })

  await t.test('6. cooldown expirado (cooldown_until no passado) + healthcheck "open" → recupera normalmente', async () => {
    await resetar()
    const instancia = await criarInstancia(supabase, 'wa01-b6', {
      health_status: 'cooldown', cooldown_until: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5min no passado
    })
    await atualizarStatusConexao('wa01-b6', 'open')
    const { data: depois } = await supabase.from('whatsapp_instances').select('health_status').eq('id', instancia.id).single()
    assert.equal(depois.health_status, 'connected', 'cooldown já expirado — healthcheck confirmando conexão deveria recuperar a instância')
  })

  await t.test('7. instância saudável sem cooldown → healthcheck mantém disponível normalmente (sem regressão)', async () => {
    await resetar()
    const instancia = await criarInstancia(supabase, 'wa01-b7', { health_status: 'unknown' })
    await atualizarStatusConexao('wa01-b7', 'open')
    const { data: depois } = await supabase.from('whatsapp_instances').select('health_status').eq('id', instancia.id).single()
    assert.equal(depois.health_status, 'connected')
  })

  await t.test('9. limite por instância (daily_limit) continua funcionando, agora com a contagem real em vez de sent_today', async () => {
    await resetar()
    const instancia = await criarInstancia(supabase, 'wa01-b9', { daily_limit: 1 })
    fakeEvolution.controlarInstancia('wa01-b9', { comportamento: 'ok' })
    const conta1 = await criarContaDeTeste(supabase)
    const r1 = await enviarCobrancaComRoteamento({ contasFinanceirasId: conta1.id, etapa: 1, clienteNome: conta1.pessoa_nome, clienteTelefone: conta1.telefone_cobranca, valor: conta1.valor, mensagem: 'x', origem: 'cron' })
    assert.equal(r1.status, 'sent')

    const conta2 = await criarContaDeTeste(supabase)
    const r2 = await enviarCobrancaComRoteamento({ contasFinanceirasId: conta2.id, etapa: 1, clienteNome: conta2.pessoa_nome, clienteTelefone: conta2.telefone_cobranca, valor: conta2.valor, mensagem: 'x', origem: 'cron' })
    assert.equal(r2.status, 'failed', 'daily_limit=1 já atingido pelo envio real anterior — 2º envio deveria ser bloqueado (sem instância apta)')
    assert.equal(r2.motivo, 'sem_instancia_saudavel')
    assert.equal(fakeEvolution.mensagensEnviadas.length, 1, 'só 1 envio real deveria ter acontecido')
  })

  await t.test('8. teto global continua funcionando normalmente (sem regressão da mudança de fonte de contagem por instância)', async () => {
    await resetar()
    await criarInstancia(supabase, 'wa01-b8', { priority: 1 })
    fakeEvolution.controlarInstancia('wa01-b8', { comportamento: 'ok' })
    await supabase.from('automacoes_config').update({ global_daily_limit: 1 }).eq('id', 1)
    invalidarCacheFlags()

    const conta1 = await criarContaDeTeste(supabase)
    const r1 = await enviarCobrancaComRoteamento({ contasFinanceirasId: conta1.id, etapa: 1, clienteNome: conta1.pessoa_nome, clienteTelefone: conta1.telefone_cobranca, valor: conta1.valor, mensagem: 'x', origem: 'cron' })
    assert.equal(r1.status, 'sent')
    // enviarCobrancaComRoteamento não escreve em cobrancas_whatsapp — isso é
    // responsabilidade do CALLER (cobranca-whatsapp.js/cobrancas.js), nunca
    // do motor de roteamento. Simula esse passo pra exercitar o teto global
    // (globalSendLimit.js conta cobrancas_whatsapp, não collection_dispatches).
    await supabase.from('cobrancas_whatsapp').insert({
      cliente_nome: conta1.pessoa_nome, cliente_telefone: conta1.telefone_cobranca, valor: conta1.valor,
      etapa: 1, status: 'enviada', origem: 'cron', data_envio: new Date().toISOString(),
    })

    const conta2 = await criarContaDeTeste(supabase)
    const r2 = await enviarCobrancaComRoteamento({ contasFinanceirasId: conta2.id, etapa: 1, clienteNome: conta2.pessoa_nome, clienteTelefone: conta2.telefone_cobranca, valor: conta2.valor, mensagem: 'x', origem: 'cron' })
    assert.equal(r2.status, 'blocked')
    assert.equal(r2.reason, 'limite_global_diario', 'teto global (PR #31) continua funcionando junto com a contagem real por instância')

    fakeEvolution.mensagensEnviadas.length = 0
  })

  await t.test('10. idempotência preservada (fora do cenário de teto global já atingido — o teto é checado ANTES da idempotência interna do dispatchEngine, então testado isoladamente)', async () => {
    await resetar()
    await criarInstancia(supabase, 'wa01-b10', { priority: 1 })
    fakeEvolution.controlarInstancia('wa01-b10', { comportamento: 'ok' })

    const conta = await criarContaDeTeste(supabase)
    const args = { contasFinanceirasId: conta.id, etapa: 4, clienteNome: conta.pessoa_nome, clienteTelefone: conta.telefone_cobranca, valor: conta.valor, mensagem: 'x' }
    const r1 = await enviarCobrancaComRoteamento({ ...args, origem: 'cron' })
    const r2 = await enviarCobrancaComRoteamento({ ...args, origem: 'manual' })
    assert.equal(r1.status, 'sent')
    assert.equal(r2.motivo, 'idempotencia_existente', 'mesma cobrança lógica reconhecida, não reenviada nem recontada — sem regressão da mudança de fonte de contagem')
    assert.equal(fakeEvolution.mensagensEnviadas.length, 1)
  })

  // 2026-08-27 — preparação da 3ª instância financeira (reserva-02): prova
  // concreta de que o pool já é N-instância por desenho (listarInstancias/
  // selecionarProximaInstancia nunca hardcodam "2") — nenhuma mudança de
  // código foi necessária, só cadastro. Testado localmente com 3 linhas
  // reais em whatsapp_instances, nunca contra WhatsApp de verdade.
  await t.test('11. pool com 3 instâncias — seleciona por prioridade, cai pra 3ª quando as 2 primeiras estão indisponíveis', async () => {
    await resetar()
    const principal = await criarInstancia(supabase, 'wa01-b11', { priority: 1, role: 'principal' })
    const reserva01 = await criarInstancia(supabase, 'wa02-b11', { priority: 2, role: 'reserva' })
    const reserva02 = await criarInstancia(supabase, 'wa03-b11', { priority: 3, role: 'reserva' })

    // todas saudaveis -> sempre escolhe a de maior prioridade (menor numero)
    let escolhida = await selecionarProximaInstancia({})
    assert.equal(escolhida.id, principal.id, 'com as 3 saudaveis, principal (priority=1) deveria ser escolhida')

    // principal em cooldown -> cai pra reserva-01
    await supabase.from('whatsapp_instances').update({
      health_status: 'cooldown', cooldown_until: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    }).eq('id', principal.id)
    escolhida = await selecionarProximaInstancia({})
    assert.equal(escolhida.id, reserva01.id, 'com a principal em cooldown, reserva-01 (priority=2) deveria ser a proxima escolhida')

    // principal E reserva-01 em cooldown -> cai pra reserva-02 (a 3a instancia)
    await supabase.from('whatsapp_instances').update({
      health_status: 'cooldown', cooldown_until: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    }).eq('id', reserva01.id)
    escolhida = await selecionarProximaInstancia({})
    assert.equal(escolhida.id, reserva02.id, 'com as 2 primeiras em cooldown, a 3a instancia deveria ser a candidata restante')

    // as 3 em cooldown -> nenhuma candidata (nunca inventa uma 4a nem ignora o circuit breaker)
    await supabase.from('whatsapp_instances').update({
      health_status: 'cooldown', cooldown_until: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    }).eq('id', reserva02.id)
    escolhida = await selecionarProximaInstancia({})
    assert.equal(escolhida, null, 'com as 3 em cooldown, nao deveria sobrar nenhuma candidata')
  })

  await t.test('12. 3ª instância nunca recebe 2ª tentativa da MESMA cobrança (idempotência global preservada com N=3)', async () => {
    await resetar()
    await criarInstancia(supabase, 'wa01-b12', { priority: 1, role: 'principal' })
    await criarInstancia(supabase, 'wa02-b12', { priority: 2, role: 'reserva' })
    await criarInstancia(supabase, 'wa03-b12', { priority: 3, role: 'reserva' })
    fakeEvolution.controlarInstancia('wa01-b12', { comportamento: 'ok' })

    const conta = await criarContaDeTeste(supabase)
    const args = { contasFinanceirasId: conta.id, etapa: 1, clienteNome: conta.pessoa_nome, clienteTelefone: conta.telefone_cobranca, valor: conta.valor, mensagem: 'x' }
    const r1 = await enviarCobrancaComRoteamento({ ...args, origem: 'cron' })
    const r2 = await enviarCobrancaComRoteamento({ ...args, origem: 'manual' })
    assert.equal(r1.status, 'sent')
    assert.equal(r2.motivo, 'idempotencia_existente', 'com 3 instancias cadastradas, a mesma cobranca logica continua sendo reconhecida uma unica vez')
    assert.equal(fakeEvolution.mensagensEnviadas.length, 1, 'no maximo 1 envio real, independente de quantas instancias existem no pool')
  })

  await t.test('13. instância comercial nunca é selecionada, mesmo com 3 instâncias financeiras reais cadastradas', async () => {
    await resetar()
    await criarInstancia(supabase, 'wa01-b13', { priority: 1, role: 'principal' })
    await criarInstancia(supabase, 'wa02-b13', { priority: 2, role: 'reserva' })
    await criarInstancia(supabase, 'wa03-b13', { priority: 3, role: 'reserva' })
    // Mesmo que alguem cadastre por engano uma instancia comercial com prioridade mais alta
    // (numero menor) que todas as financeiras, ela nunca deveria ser escolhida.
    await criarInstancia(supabase, 'vivenzza', { priority: 0, role: 'reserva' })

    const escolhida = await selecionarProximaInstancia({})
    assert.notEqual(escolhida?.instance_name, 'vivenzza', 'instancia comercial (denylist INSTANCIAS_COMERCIAIS_PROIBIDAS) nunca deveria ser selecionavel, mesmo com prioridade mais alta')
    assert.equal(escolhida?.instance_name, 'wa01-b13', 'a melhor candidata financeira real deveria ser escolhida, pulando a comercial')
  })

  await pararAmbienteDeTeste()
})
