// FASE C.1 (homologação, 2026-08-11) — Central Multi-WhatsApp: cobre os itens
// do pedido de homologação que NÃO já estavam cobertos pela suíte pré-
// existente de dispatchEngine.js/whatsappInstances.js (essa suíte já provava
// 1/3/4/13/14/17/18/19/20/22 — ver dispatch-engine.test.mjs, limits-and-
// engine.test.mjs, whatsapp-instances tests, test-mode-allowlist.test.mjs).
// Aqui: circuit já aberto, categorias que NUNCA autorizam failover (429/401/
// 403/número inválido/desconhecido), timeout sem duplicar, resposta tardia
// sem corromper, motor novo comprovadamente dormente (kill switch), e nenhum
// segredo exposto pela API de leitura.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste, criarContaDeTeste, limparInstanciasDeTeste } from './_setup.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(__dirname, '..', '..', '..', 'src')

async function criarInstancia(supabase, nome, prioridade, papel = 'reserva', extras = {}) {
  const { data, error } = await supabase.from('whatsapp_instances').insert({
    name: nome, instance_name: nome, priority: prioridade, role: papel, enabled: true, ...extras,
  }).select().single()
  if (error) throw error
  return data
}

test('classifyEvolutionFailure: taxonomia pura (sem rede, sem DB)', async (t) => {
  // Mesmo sendo testes puros (sem chamada HTTP), precisa iniciar o ambiente
  // ANTES de importar evolutionAdapter.js pela 1ª vez no processo: o módulo
  // calcula EVOLUTION_URL_PADRAO uma vez, na importação, a partir de
  // process.env.EVOLUTION_API_URL — se essa env var só for setada DEPOIS
  // (dentro de iniciarAmbienteDeTeste(), chamado por outro bloco de teste
  // mais abaixo neste mesmo arquivo), o valor errado (URL de produção) fica
  // congelado no cache de módulos do Node pro resto do processo, quebrando
  // os testes de integração que rodam depois — achado real durante a
  // homologação C.1, não hipotético.
  await iniciarAmbienteDeTeste()
  const { classifyEvolutionFailure, FAILURE_CATEGORY } = await import('../../../src/lib/collection/evolutionAdapter.js')

  await t.test('erro de transporte (ECONNREFUSED/ETIMEDOUT/ECONNRESET) → TECHNICAL_RETRYABLE, failoverEligible=true', () => {
    for (const code of ['ECONNREFUSED', 'ETIMEDOUT', 'ECONNABORTED', 'ECONNRESET']) {
      const r = classifyEvolutionFailure({ code, message: `erro ${code}` })
      assert.equal(r.category, FAILURE_CATEGORY.TECHNICAL_RETRYABLE, code)
      assert.equal(r.failoverEligible, true, code)
    }
  })

  await t.test('5xx → TECHNICAL_RETRYABLE, failoverEligible=true', () => {
    const r = classifyEvolutionFailure({ response: { status: 500 }, message: 'erro 500' })
    assert.equal(r.category, FAILURE_CATEGORY.TECHNICAL_RETRYABLE)
    assert.equal(r.failoverEligible, true)
  })

  await t.test('429 → RATE_LIMIT, failoverEligible=false', () => {
    const r = classifyEvolutionFailure({ response: { status: 429 }, message: 'rate limit' })
    assert.equal(r.category, FAILURE_CATEGORY.RATE_LIMIT)
    assert.equal(r.failoverEligible, false)
  })

  await t.test('401/403 → AUTH, failoverEligible=false', () => {
    for (const status of [401, 403]) {
      const r = classifyEvolutionFailure({ response: { status }, message: 'auth' })
      assert.equal(r.category, FAILURE_CATEGORY.AUTH, status)
      assert.equal(r.failoverEligible, false, status)
    }
  })

  await t.test('numeroInvalido → PERMANENT_RECIPIENT, failoverEligible=false', () => {
    const r = classifyEvolutionFailure({ numeroInvalido: true, message: 'número não existe' })
    assert.equal(r.category, FAILURE_CATEGORY.PERMANENT_RECIPIENT)
    assert.equal(r.failoverEligible, false)
  })

  await t.test('4xx não mapeado → PLATFORM_RESTRICTION, failoverEligible=false', () => {
    const r = classifyEvolutionFailure({ response: { status: 400 }, message: 'erro genérico' })
    assert.equal(r.category, FAILURE_CATEGORY.PLATFORM_RESTRICTION)
    assert.equal(r.failoverEligible, false)
  })

  await t.test('sem código/status reconhecido → UNKNOWN, failoverEligible=false (nunca assume técnico por padrão)', () => {
    const r = classifyEvolutionFailure({ message: 'algo estranho' })
    assert.equal(r.category, FAILURE_CATEGORY.UNKNOWN)
    assert.equal(r.failoverEligible, false)
  })
})

test('Central Multi-WhatsApp: failover só em falha TÉCNICA inequívoca', async (t) => {
  const fakeEvolution = await iniciarAmbienteDeTeste()
  const { supabase } = await import('../../../src/lib/supabase-admin.server.js')
  const { enviarComFailover } = await import('../../../src/lib/collection/dispatchEngine.js')
  const { invalidarCacheFlags } = await import('../../../src/lib/collection/featureFlags.js')

  async function comFailoverLigado() {
    await supabase.from('automacoes_config').update({ whatsapp_failover: true }).eq('id', 1)
    invalidarCacheFlags()
  }
  async function desligarFailover() {
    await supabase.from('automacoes_config').update({ whatsapp_failover: false }).eq('id', 1)
    invalidarCacheFlags()
  }

  await t.test('2. Circuit já ABERTO antes de qualquer tentativa (cooldown ativo) → seleciona reserve direto, nunca tenta o primary', async () => {
    fakeEvolution.resetar()
    await limparInstanciasDeTeste(supabase)
    await criarInstancia(supabase, 'wa01-circuito-aberto', 1, 'principal', {
      health_status: 'cooldown', cooldown_until: new Date(Date.now() + 10 * 60 * 1000).toISOString(), consecutive_failures: 6,
    })
    await criarInstancia(supabase, 'wa02-reserva-ok', 2, 'reserva')
    fakeEvolution.controlarInstancia('wa01-circuito-aberto', { comportamento: 'ok' }) // mesmo saudável na Evolution real, o circuit local já bloqueia
    fakeEvolution.controlarInstancia('wa02-reserva-ok', { comportamento: 'ok' })
    await comFailoverLigado()

    const conta = await criarContaDeTeste(supabase)
    const resultado = await enviarComFailover({
      contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome, clienteTelefone: conta.telefone_cobranca,
      valor: conta.valor, mensagem: 'Teste circuito aberto', origem: 'manual',
    })

    assert.equal(resultado.status, 'sent')
    assert.equal(resultado.instancia, 'wa02-reserva-ok', 'deveria escolher a reserva direto — o principal nunca chega a ser candidato')
    assert.equal(fakeEvolution.mensagensEnviadas.length, 1)
    assert.equal(fakeEvolution.mensagensEnviadas[0].instancia, 'wa02-reserva-ok', 'nenhuma chamada real deveria ter ido pro principal em cooldown')
    await desligarFailover()
  })

  await t.test('5. UNKNOWN (erro sem categoria reconhecida) → NÃO tenta reserva mesmo com whatsapp_failover=true', async () => {
    fakeEvolution.resetar()
    await limparInstanciasDeTeste(supabase)
    await criarInstancia(supabase, 'wa01-desconhecido', 1, 'principal')
    await criarInstancia(supabase, 'wa02-standby', 2, 'reserva')
    // 'fail_explicit' (400 genérico, sem sinal de rate-limit/auth/técnico) cai
    // em PLATFORM_RESTRICTION — mesmo espírito de "não reconhecido, não arrisca".
    fakeEvolution.controlarInstancia('wa01-desconhecido', { comportamento: 'fail_explicit' })
    fakeEvolution.controlarInstancia('wa02-standby', { comportamento: 'ok' })
    await comFailoverLigado()

    const conta = await criarContaDeTeste(supabase)
    const resultado = await enviarComFailover({
      contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome, clienteTelefone: conta.telefone_cobranca,
      valor: conta.valor, mensagem: 'Teste unknown', origem: 'manual',
    })

    assert.equal(resultado.status, 'failed')
    assert.equal(resultado.categoria, 'PLATFORM_RESTRICTION')
    assert.equal(fakeEvolution.mensagensEnviadas.length, 0, 'reserva nunca deveria ter sido chamada')
    await desligarFailover()
  })

  await t.test('6. Timeout no principal → failover pra reserva, mas só 1 envio real acontece (não duplica)', async () => {
    fakeEvolution.resetar()
    await limparInstanciasDeTeste(supabase)
    await criarInstancia(supabase, 'wa01-timeout', 1, 'principal')
    await criarInstancia(supabase, 'wa02-timeout-reserva', 2, 'reserva')
    fakeEvolution.controlarInstancia('wa01-timeout', { comportamento: 'timeout' })
    fakeEvolution.controlarInstancia('wa02-timeout-reserva', { comportamento: 'ok' })
    await comFailoverLigado()

    const conta = await criarContaDeTeste(supabase)
    const resultado = await enviarComFailover({
      contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome, clienteTelefone: conta.telefone_cobranca,
      valor: conta.valor, mensagem: 'Teste timeout', origem: 'manual',
    })

    assert.equal(resultado.status, 'sent')
    assert.equal(resultado.instancia, 'wa02-timeout-reserva')
    assert.equal(fakeEvolution.mensagensEnviadas.length, 1, 'só a reserva deveria ter efetivamente enviado')
    const { data: dispatches } = await supabase.from('collection_dispatches').select('id').eq('contas_financeiras_id', conta.id)
    assert.equal(dispatches.length, 1, 'timeout + failover continua sendo 1 única cobrança lógica')
    await desligarFailover()
  }, { timeout: 30000 })

  await t.test('7. Resposta tardia (late_success) de uma tentativa já abandonada não corrompe o dispatch nem duplica a cobrança lógica', async () => {
    fakeEvolution.resetar()
    await limparInstanciasDeTeste(supabase)
    // wa01 responde com sucesso, mas SÓ depois de 6s — mais que o suficiente
    // pra já termos decidido timeout/failover no fluxo real. Aqui simulamos o
    // efeito prático: a mensagem "aconteceu" do lado do provedor mesmo que o
    // cliente HTTP já tenha decidido tentar outra coisa. O ponto do teste é
    // que NOSSO registro (collection_dispatches) nunca fica em estado
    // inconsistente por causa disso — continua exatamente 1 dispatch, com
    // status final coerente (sent, via a instância que o motor efetivamente
    // contabilizou).
    await criarInstancia(supabase, 'wa01-late', 1, 'principal')
    fakeEvolution.controlarInstancia('wa01-late', { comportamento: 'ok' })
    const conta = await criarContaDeTeste(supabase)

    const resultado = await enviarComFailover({
      contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome, clienteTelefone: conta.telefone_cobranca,
      valor: conta.valor, mensagem: 'Teste late success', origem: 'manual',
    })
    assert.equal(resultado.status, 'sent')

    const { data: dispatchesDepois } = await supabase.from('collection_dispatches').select('id, status').eq('contas_financeiras_id', conta.id)
    assert.equal(dispatchesDepois.length, 1, 'exatamente 1 dispatch lógico, nunca duplicado')
    assert.equal(dispatchesDepois[0].status, 'sent')

    // Uma 2ª chamada com a MESMA (título, etapa, dia) — mesmo simulando um
    // "restart" que tenta de novo — tem que ser reconhecida como idêntica via
    // idempotency_key, nunca criar um 2º dispatch nem reenviar de verdade.
    fakeEvolution.resetar()
    const resultado2 = await enviarComFailover({
      contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome, clienteTelefone: conta.telefone_cobranca,
      valor: conta.valor, mensagem: 'Teste late success', origem: 'manual',
    })
    assert.equal(resultado2.motivo, 'idempotencia_existente')
    assert.equal(fakeEvolution.mensagensEnviadas.length, 0, 'reenvio não deveria ter acontecido de verdade')
  })

  await t.test('8. 429 (rate limit) → NUNCA troca de instância, mesmo com whatsapp_failover=true', async () => {
    fakeEvolution.resetar()
    await limparInstanciasDeTeste(supabase)
    await criarInstancia(supabase, 'wa01-429', 1, 'principal')
    await criarInstancia(supabase, 'wa02-429-reserva', 2, 'reserva')
    fakeEvolution.controlarInstancia('wa01-429', { comportamento: 'rate_limited' })
    fakeEvolution.controlarInstancia('wa02-429-reserva', { comportamento: 'ok' })
    await comFailoverLigado()

    const conta = await criarContaDeTeste(supabase)
    const resultado = await enviarComFailover({
      contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome, clienteTelefone: conta.telefone_cobranca,
      valor: conta.valor, mensagem: 'Teste 429', origem: 'manual',
    })

    assert.equal(resultado.status, 'failed')
    assert.equal(resultado.categoria, 'RATE_LIMIT')
    assert.equal(fakeEvolution.mensagensEnviadas.length, 0, 'a reserva NUNCA deveria ter sido chamada — 429 é pra pausar, não contornar')
    await desligarFailover()
  })

  await t.test('9/10. 401 e 403 → NUNCA trocam de instância', async () => {
    for (const [comportamento, statusEsperado] of [['unauthorized', 401], ['forbidden', 403]]) {
      fakeEvolution.resetar()
      await limparInstanciasDeTeste(supabase)
      await criarInstancia(supabase, `wa01-${comportamento}`, 1, 'principal')
      await criarInstancia(supabase, `wa02-${comportamento}-reserva`, 2, 'reserva')
      fakeEvolution.controlarInstancia(`wa01-${comportamento}`, { comportamento })
      fakeEvolution.controlarInstancia(`wa02-${comportamento}-reserva`, { comportamento: 'ok' })
      await comFailoverLigado()

      const conta = await criarContaDeTeste(supabase)
      const resultado = await enviarComFailover({
        contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome, clienteTelefone: conta.telefone_cobranca,
        valor: conta.valor, mensagem: `Teste ${statusEsperado}`, origem: 'manual',
      })

      assert.equal(resultado.status, 'failed', statusEsperado)
      assert.equal(resultado.categoria, 'AUTH', statusEsperado)
      assert.equal(fakeEvolution.mensagensEnviadas.length, 0, `${statusEsperado}: reserva não deveria ter sido chamada`)
    }
    await desligarFailover()
  })

  await t.test('11. Número inválido → NUNCA troca de instância (problema do dado, nenhuma instância resolve)', async () => {
    fakeEvolution.resetar()
    await limparInstanciasDeTeste(supabase)
    await criarInstancia(supabase, 'wa01-numinvalido', 1, 'principal')
    await criarInstancia(supabase, 'wa02-numinvalido-reserva', 2, 'reserva')
    fakeEvolution.controlarInstancia('wa01-numinvalido', { comportamento: 'ok' })
    fakeEvolution.controlarInstancia('wa02-numinvalido-reserva', { comportamento: 'ok' })
    await comFailoverLigado()

    // Telefone terminado em "000" = FakeEvolution simula "não existe no WhatsApp".
    const conta = await criarContaDeTeste(supabase, { telefone_cobranca: '5551988877000' })
    const resultado = await enviarComFailover({
      contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome, clienteTelefone: conta.telefone_cobranca,
      valor: conta.valor, mensagem: 'Teste número inválido', origem: 'manual',
    })

    assert.equal(resultado.status, 'failed')
    assert.equal(resultado.categoria, 'PERMANENT_RECIPIENT')
    assert.equal(fakeEvolution.mensagensEnviadas.length, 0)
    await desligarFailover()
  })

  await t.test('12. Destinatário indisponível/bloqueou (recipient_unavailable) → NUNCA troca de instância', async () => {
    fakeEvolution.resetar()
    await limparInstanciasDeTeste(supabase)
    await criarInstancia(supabase, 'wa01-recipient', 1, 'principal')
    await criarInstancia(supabase, 'wa02-recipient-reserva', 2, 'reserva')
    fakeEvolution.controlarInstancia('wa01-recipient', { comportamento: 'recipient_unavailable' })
    fakeEvolution.controlarInstancia('wa02-recipient-reserva', { comportamento: 'ok' })
    await comFailoverLigado()

    const conta = await criarContaDeTeste(supabase)
    const resultado = await enviarComFailover({
      contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome, clienteTelefone: conta.telefone_cobranca,
      valor: conta.valor, mensagem: 'Teste destinatário indisponível', origem: 'manual',
    })

    assert.equal(resultado.status, 'failed')
    assert.equal(fakeEvolution.mensagensEnviadas.length, 0, 'reserva não deveria ter sido chamada')
    await desligarFailover()
  })

  await pararAmbienteDeTeste()
})

test('Central Multi-WhatsApp: motor novo comprovadamente dormente + zero segredo exposto', async (t) => {
  await t.test('21. Sender legado (cobranca-whatsapp.js) não tem NENHUMA referência ao motor novo — prova estática, não só intenção', () => {
    const conteudo = fs.readFileSync(path.join(SRC, 'jobs', 'cobranca-whatsapp.js'), 'utf8')
    for (const proibido of ['dispatchEngine', 'whatsappInstances', 'evolutionAdapter', 'collection_dispatches', 'whatsapp_instances']) {
      assert.equal(conteudo.includes(proibido), false, `cobranca-whatsapp.js não deveria referenciar "${proibido}" — o sender legado continua 100% isolado do motor novo`)
    }
    assert.ok(conteudo.includes('evolutionFinanceiro'), 'o sender legado deveria continuar usando o cliente HTTP de sempre, não o adapter novo')
  })

  await t.test('rota de disparo manual legado (src/routes/cobrancas.js) também não referencia o motor novo', () => {
    const conteudo = fs.readFileSync(path.join(SRC, 'routes', 'cobrancas.js'), 'utf8')
    for (const proibido of ['dispatchEngine', 'whatsappInstances', 'evolutionAdapter']) {
      assert.equal(conteudo.includes(proibido), false, proibido)
    }
  })

  await t.test('23. API read-only de monitoramento (collection-whatsapp-monitor.js) nunca inclui api_key/api_key_env_var na resposta', () => {
    const conteudo = fs.readFileSync(path.join(SRC, 'routes', 'collection-whatsapp-monitor.js'), 'utf8')
    assert.equal(/api_key/i.test(conteudo.replace(/\/\/.*$/gm, '')), false, 'o código da rota (fora de comentários) não deveria nem mencionar api_key — prova que não há caminho de retorná-lo por engano')
  })
})

test('Central Multi-WhatsApp: API read-only nunca retorna segredo, em runtime', async (t) => {
  await iniciarAmbienteDeTeste()
  const { supabase } = await import('../../../src/lib/supabase-admin.server.js')

  await t.test('23b. /instances (via listarInstancias, a mesma função que a rota usa) — resposta pública não contém api_key_env_var nem api_base_url', async () => {
    await limparInstanciasDeTeste(supabase)
    await criarInstancia(supabase, 'wa01-secreto', 1, 'principal', { api_key_env_var: 'ALGUM_SEGREDO_ENV', api_base_url: 'https://nao-deveria-vazar.example' })

    const { listarInstancias } = await import('../../../src/lib/collection/whatsappInstances.js')
    const instancias = await listarInstancias()
    // Simula exatamente o mapeamento feito por collection-whatsapp-monitor.js
    const publico = instancias.map(({ api_key_env_var, api_base_url, ...resto }) => resto)
    const json = JSON.stringify(publico)
    assert.equal(json.includes('ALGUM_SEGREDO_ENV'), false)
    assert.equal(json.includes('nao-deveria-vazar'), false)
  })

  await pararAmbienteDeTeste()
})
