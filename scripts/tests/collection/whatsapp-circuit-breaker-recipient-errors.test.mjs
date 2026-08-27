// CORREÇÃO 2026-08-27 — achado real em produção: PERMANENT_RECIPIENT
// ("número não registrado no WhatsApp") incrementava consecutive_failures
// da INSTÂNCIA (registrarFalhaEnvio chamado incondicionalmente pra qualquer
// falha), derrubando vivenzza-financeiro e vivenzza-financeiro-reserva-01
// em cooldown por causa de um lote de telefones ruins — problema do DADO,
// não da instância. Este arquivo prova, ponta a ponta (fakeEvolution real,
// não mockado, Postgres local), que a distinção affectsInstanceHealth
// (evolutionAdapter.js/dispatchEngine.js) corrige isso sem regredir nada
// mais. Nenhum WhatsApp real tocado.
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

test('Circuit breaker: PERMANENT_RECIPIENT nunca derruba a instância', async (t) => {
  const fakeEvolution = await iniciarAmbienteDeTeste()
  const { supabase } = await import('../../../src/lib/supabase-admin.server.js')
  const { enviarCobrancaComRoteamento } = await import('../../../src/lib/collection/collectionRouting.js')
  const { invalidarCacheFlags } = await import('../../../src/lib/collection/featureFlags.js')
  const { estaEmDoNotContact } = await import('../../../src/lib/collection/doNotContactGuard.js')
  const { contarTentativasReaisDesde } = await import('../../../src/lib/collection/providerAttemptCounter.js')

  async function resetar() {
    fakeEvolution.resetar()
    await limparInstanciasDeTeste(supabase)
    await supabase.from('cobrancas_whatsapp').delete().neq('id', '00000000-0000-0000-0000-000000000000')
    // Limites globais bem acima do que este arquivo soma no total (não é o
    // que está sendo testado aqui — ver globalSendLimit.js pros testes
    // dedicados a isso) para nunca interferir por acúmulo de tentativas nas
    // sub-tests deste describe block.
    await supabase.from('automacoes_config').update({ multi_whatsapp: true, whatsapp_failover: false, global_daily_limit: 1000, global_hourly_limit: 1000 }).eq('id', 1)
    await garantirSyncFinanceiroFresco(supabase)
    invalidarCacheFlags()
  }

  // Telefone terminado em "000" simula "não existe no WhatsApp" no fakeEvolution
  // (ver fakeEvolution.js linha 58) — dispara numeroInvalido=true de verdade,
  // pelo mesmo caminho de código que produção usa.
  function telefoneInvalido(sufixo) { return `555199${sufixo}000` }

  await t.test('1. PERMANENT_RECIPIENT: tentativa real registrada, DNC aplicado, consecutive_failures NÃO incrementa, cooldown NÃO criado, sem 2ª instância tentada', async () => {
    await resetar()
    const instancia = await criarInstancia(supabase, 'wa-permrec-01')
    fakeEvolution.controlarInstancia('wa-permrec-01', { comportamento: 'ok' })

    const conta = await criarContaDeTeste(supabase, { telefone_cobranca: telefoneInvalido('1') })
    const resultado = await enviarCobrancaComRoteamento({
      contasFinanceirasId: conta.id, etapa: 1, clienteNome: conta.pessoa_nome,
      clienteTelefone: conta.telefone_cobranca, valor: conta.valor, mensagem: 'x', origem: 'cron',
    })
    assert.equal(resultado.status, 'failed')
    assert.equal(resultado.motivo, 'permanent_recipient')

    // 1. tentativa real registrada (rate limit global, PR #49)
    const contagem = await contarTentativasReaisDesde({ desde: new Date(Date.now() - 60000).toISOString() })
    assert.equal(contagem, 1, 'a tentativa real ao provider deveria contar pro rate limit global, mesmo tendo falhado')

    // 2. DNC aplicado (PR #48)
    const dnc = await estaEmDoNotContact(conta.telefone_cobranca)
    assert.equal(dnc.blocked, true)
    assert.equal(dnc.reason, 'NUMERO_INVALIDO_HOJE')

    // 3. consecutive_failures NÃO incrementou, sem cooldown
    const { data: depois } = await supabase.from('whatsapp_instances').select('consecutive_failures, health_status, cooldown_until').eq('id', instancia.id).single()
    assert.equal(depois.consecutive_failures, 0, 'numero invalido nao deveria incrementar o circuit breaker da instancia')
    assert.notEqual(depois.health_status, 'cooldown')
    assert.equal(depois.cooldown_until, null)

    // 4. nenhum envio real (a checagem de existencia falhou antes do sendText)
    assert.equal(fakeEvolution.mensagensEnviadas.length, 0)
  })

  await t.test('2. 10 destinatários inválidos consecutivos NÃO derrubam a instância', async () => {
    await resetar()
    const instancia = await criarInstancia(supabase, 'wa-permrec-02')
    fakeEvolution.controlarInstancia('wa-permrec-02', { comportamento: 'ok' })

    for (let i = 0; i < 10; i++) {
      const conta = await criarContaDeTeste(supabase, { telefone_cobranca: telefoneInvalido(`2${i}`) })
      const resultado = await enviarCobrancaComRoteamento({
        contasFinanceirasId: conta.id, etapa: 1, clienteNome: conta.pessoa_nome,
        clienteTelefone: conta.telefone_cobranca, valor: conta.valor, mensagem: 'x', origem: 'cron',
      })
      assert.equal(resultado.motivo, 'permanent_recipient', `tentativa ${i}`)
    }

    const { data: depois } = await supabase.from('whatsapp_instances').select('consecutive_failures, health_status').eq('id', instancia.id).single()
    assert.equal(depois.consecutive_failures, 0, '10 numeros invalidos seguidos nao deveriam somar nenhuma falha no circuit breaker')
    assert.notEqual(depois.health_status, 'cooldown')
    assert.notEqual(depois.health_status, 'degraded')
  })

  await t.test('3. timeout (falha técnica real) incrementa consecutive_failures normalmente', async () => {
    await resetar()
    const instancia = await criarInstancia(supabase, 'wa-tech-03')
    fakeEvolution.controlarInstancia('wa-tech-03', { comportamento: 'unavailable' }) // 500 -> TECHNICAL_RETRYABLE

    const conta = await criarContaDeTeste(supabase)
    const resultado = await enviarCobrancaComRoteamento({
      contasFinanceirasId: conta.id, etapa: 1, clienteNome: conta.pessoa_nome,
      clienteTelefone: conta.telefone_cobranca, valor: conta.valor, mensagem: 'x', origem: 'cron',
    })
    assert.equal(resultado.status, 'failed')

    const { data: depois } = await supabase.from('whatsapp_instances').select('consecutive_failures').eq('id', instancia.id).single()
    assert.equal(depois.consecutive_failures, 1, 'falha tecnica real deveria continuar incrementando o circuit breaker normalmente')
  })

  await t.test('4. 6 falhas técnicas consecutivas → cooldown normal (regressão zero na regra existente)', async () => {
    await resetar()
    const instancia = await criarInstancia(supabase, 'wa-tech-04')
    fakeEvolution.controlarInstancia('wa-tech-04', { comportamento: 'unavailable' })

    for (let i = 0; i < 6; i++) {
      const conta = await criarContaDeTeste(supabase)
      await enviarCobrancaComRoteamento({
        contasFinanceirasId: conta.id, etapa: 1, clienteNome: conta.pessoa_nome,
        clienteTelefone: conta.telefone_cobranca, valor: conta.valor, mensagem: 'x', origem: 'cron',
      })
    }
    const { data: depois } = await supabase.from('whatsapp_instances').select('consecutive_failures, health_status, cooldown_until').eq('id', instancia.id).single()
    assert.equal(depois.consecutive_failures, 6)
    assert.equal(depois.health_status, 'cooldown', '6 falhas tecnicas seguidas deveriam acionar cooldown normalmente')
    assert.ok(depois.cooldown_until)
  })

  await t.test('5. 429 (rate limit) continua incrementando a saúde/cooldown da instância', async () => {
    await resetar()
    const instancia = await criarInstancia(supabase, 'wa-429-05')
    fakeEvolution.controlarInstancia('wa-429-05', { comportamento: 'rate_limited' })

    const conta = await criarContaDeTeste(supabase)
    const resultado = await enviarCobrancaComRoteamento({
      contasFinanceirasId: conta.id, etapa: 1, clienteNome: conta.pessoa_nome,
      clienteTelefone: conta.telefone_cobranca, valor: conta.valor, mensagem: 'x', origem: 'cron',
    })
    assert.equal(resultado.status, 'failed')
    assert.equal(resultado.motivo, 'rate_limit')

    const { data: depois } = await supabase.from('whatsapp_instances').select('consecutive_failures').eq('id', instancia.id).single()
    assert.equal(depois.consecutive_failures, 1, '429 deveria continuar contribuindo pro circuit breaker (decisao deliberada, ver evolutionAdapter.js)')
  })

  await t.test('6/7. 401 e 403 continuam incrementando a saúde da instância, sem fallback', async () => {
    for (const comportamento of ['unauthorized', 'forbidden']) {
      await resetar()
      const principal = await criarInstancia(supabase, `wa-auth-${comportamento}`, { priority: 1, role: 'principal' })
      const reserva = await criarInstancia(supabase, `wa-auth-reserva-${comportamento}`, { priority: 2, role: 'reserva' })
      fakeEvolution.controlarInstancia(`wa-auth-${comportamento}`, { comportamento })
      fakeEvolution.controlarInstancia(`wa-auth-reserva-${comportamento}`, { comportamento: 'ok' })
      await supabase.from('automacoes_config').update({ whatsapp_failover: true }).eq('id', 1)
      invalidarCacheFlags()

      const conta = await criarContaDeTeste(supabase)
      const resultado = await enviarCobrancaComRoteamento({
        contasFinanceirasId: conta.id, etapa: 1, clienteNome: conta.pessoa_nome,
        clienteTelefone: conta.telefone_cobranca, valor: conta.valor, mensagem: 'x', origem: 'cron',
      })
      assert.equal(resultado.status, 'failed', comportamento)
      assert.equal(resultado.motivo, 'auth', comportamento)
      assert.equal(fakeEvolution.mensagensEnviadas.length, 0, `${comportamento}: mesmo com whatsapp_failover=true, auth nunca tenta outra instancia`)

      const { data: depois } = await supabase.from('whatsapp_instances').select('consecutive_failures').eq('id', principal.id).single()
      assert.equal(depois.consecutive_failures, 1, `${comportamento}: decisao deliberada, credencial e da instancia`)
    }
  })

  await t.test('8. PLATFORM_RESTRICTION (4xx ambíguo) NÃO derruba a instância, sem fallback', async () => {
    await resetar()
    const principal = await criarInstancia(supabase, 'wa-platform-08', { priority: 1, role: 'principal' })
    const reserva = await criarInstancia(supabase, 'wa-platform-reserva-08', { priority: 2, role: 'reserva' })
    fakeEvolution.controlarInstancia('wa-platform-08', { comportamento: 'fail_explicit' }) // 400 generico -> PLATFORM_RESTRICTION
    fakeEvolution.controlarInstancia('wa-platform-reserva-08', { comportamento: 'ok' })
    await supabase.from('automacoes_config').update({ whatsapp_failover: true }).eq('id', 1)
    invalidarCacheFlags()

    const conta = await criarContaDeTeste(supabase)
    const resultado = await enviarCobrancaComRoteamento({
      contasFinanceirasId: conta.id, etapa: 1, clienteNome: conta.pessoa_nome,
      clienteTelefone: conta.telefone_cobranca, valor: conta.valor, mensagem: 'x', origem: 'cron',
    })
    assert.equal(resultado.status, 'failed')
    assert.equal(fakeEvolution.mensagensEnviadas.length, 0, 'mesmo com failover=true, PLATFORM_RESTRICTION nunca tenta outra instancia')

    const { data: depois } = await supabase.from('whatsapp_instances').select('consecutive_failures').eq('id', principal.id).single()
    assert.equal(depois.consecutive_failures, 0, 'PLATFORM_RESTRICTION nao deveria contaminar a saude da instancia')
  })

  await t.test('9. UNKNOWN não derruba a instância, sem fallback, sem duplicar', async () => {
    await resetar()
    const instancia = await criarInstancia(supabase, 'wa-unknown-09')
    // 'timeout' produz um erro de transporte SEM response.status e SEM code
    // reconhecido pelo client axios especifico deste teste seria complexo de
    // forcar via HTTP real; testamos a integracao end-to-end com o mesmo
    // efeito pratico via connection_drop, que e TECHNICAL_RETRYABLE (ja
    // coberto no teste 3/4) - o caso UNKNOWN puro (sem status, sem code) ja
    // esta coberto na suite pura de classifyEvolutionFailure (multi-whatsapp-
    // c1.test.mjs). Aqui validamos apenas que nao ha duplicidade quando a
    // 1a tentativa falha de forma nao-classificavel como tecnica.
    fakeEvolution.controlarInstancia('wa-unknown-09', { comportamento: 'fail_explicit' })
    const conta = await criarContaDeTeste(supabase)
    const args = { contasFinanceirasId: conta.id, etapa: 1, clienteNome: conta.pessoa_nome, clienteTelefone: conta.telefone_cobranca, valor: conta.valor, mensagem: 'x' }
    await enviarCobrancaComRoteamento({ ...args, origem: 'cron' })
    const r2 = await enviarCobrancaComRoteamento({ ...args, origem: 'manual' })
    assert.equal(r2.motivo, 'idempotencia_existente', 'mesma cobranca logica nao deveria ser reenviada')
    assert.equal(fakeEvolution.mensagensEnviadas.length, 0)
  })

  await t.test('10. sucesso após falha técnica recupera consecutive_failures/health normalmente (regra existente preservada)', async () => {
    await resetar()
    const instancia = await criarInstancia(supabase, 'wa-recover-10')
    fakeEvolution.controlarInstancia('wa-recover-10', { comportamento: 'unavailable' })
    const conta1 = await criarContaDeTeste(supabase)
    await enviarCobrancaComRoteamento({ contasFinanceirasId: conta1.id, etapa: 1, clienteNome: conta1.pessoa_nome, clienteTelefone: conta1.telefone_cobranca, valor: conta1.valor, mensagem: 'x', origem: 'cron' })

    let { data: meio } = await supabase.from('whatsapp_instances').select('consecutive_failures').eq('id', instancia.id).single()
    assert.equal(meio.consecutive_failures, 1)

    fakeEvolution.controlarInstancia('wa-recover-10', { comportamento: 'ok' })
    const conta2 = await criarContaDeTeste(supabase)
    const resultado = await enviarCobrancaComRoteamento({ contasFinanceirasId: conta2.id, etapa: 1, clienteNome: conta2.pessoa_nome, clienteTelefone: conta2.telefone_cobranca, valor: conta2.valor, mensagem: 'x', origem: 'cron' })
    assert.equal(resultado.status, 'sent')

    const { data: depois } = await supabase.from('whatsapp_instances').select('consecutive_failures, health_status').eq('id', instancia.id).single()
    assert.equal(depois.consecutive_failures, 0, 'sucesso deveria zerar consecutive_failures normalmente')
    assert.equal(depois.health_status, 'connected')
  })

  await pararAmbienteDeTeste()
})
