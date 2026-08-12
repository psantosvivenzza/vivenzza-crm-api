// Cenários 1-9 do pedido de homologação — motor de failover/idempotência/limites,
// rodando o CÓDIGO REAL (src/lib/collection/dispatchEngine.js) contra Postgres
// local + Fake Evolution API.
//
// Tudo dentro de um único test() com subtestes via `t.test()` (não vários
// test() soltos no topo do arquivo) — node:test só garante ordem sequencial
// estrita para subtestes de um mesmo pai; testes irmãos no topo do arquivo
// podem intercalar mesmo com --test-concurrency=1 (confirmado empiricamente
// nesta versão do Node — 2 testes que dependiam de whatsapp_instances limpo
// viam a instância criada pelo teste anterior antes do DELETE do próprio
// teste terminar). Isso importa aqui porque os testes compartilham estado
// mutável real (tabela whatsapp_instances, singleton automacoes_config).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste, criarContaDeTeste, limparInstanciasDeTeste } from './_setup.mjs'

async function criarInstancia(supabase, nome, prioridade, papel = 'reserva') {
  const { data, error } = await supabase.from('whatsapp_instances').insert({
    name: nome, instance_name: nome, priority: prioridade, role: papel, enabled: true,
  }).select().single()
  if (error) throw error
  return data
}

test('motor de dispatch/failover/idempotência (cenários 1-9)', async (t) => {
  const fakeEvolution = await iniciarAmbienteDeTeste()
  const { supabase } = await import('../../../src/lib/supabase-admin.server.js')
  const { enviarComFailover, aplicarAckDeEntrega } = await import('../../../src/lib/collection/dispatchEngine.js')
  const { registrarEventoExterno } = await import('../../../src/lib/collection/idempotency.js')
  const { obterConfigCobranca, invalidarCacheFlags } = await import('../../../src/lib/collection/featureFlags.js')

  await t.test('1. WA01 envia e entrega — dispatch e attempt viram sent', async () => {
    fakeEvolution.resetar()
    await limparInstanciasDeTeste(supabase)
    await criarInstancia(supabase, 'wa01-teste', 1, 'principal')
    fakeEvolution.controlarInstancia('wa01-teste', { comportamento: 'ok' })
    const conta = await criarContaDeTeste(supabase)

    const resultado = await enviarComFailover({
      contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome, clienteTelefone: conta.telefone_cobranca,
      valor: conta.valor, mensagem: 'Mensagem de teste', origem: 'manual',
    })

    assert.equal(resultado.status, 'sent')
    const { data: dispatch } = await supabase.from('collection_dispatches').select('*').eq('id', resultado.dispatchId).single()
    assert.equal(dispatch.status, 'sent')
    assert.equal(fakeEvolution.mensagensEnviadas.length, 1)
    assert.equal(fakeEvolution.mensagensEnviadas[0].instancia, 'wa01-teste')
  })

  await t.test('2. WA01 indisponível (falha TÉCNICA inequívoca) e WA02 assume (whatsapp_failover=true) — só 1 cobrança lógica', async () => {
    fakeEvolution.resetar()
    await limparInstanciasDeTeste(supabase)
    await criarInstancia(supabase, 'wa01-falha', 1, 'principal')
    await criarInstancia(supabase, 'wa02-reserva', 2, 'reserva')
    // FASE C.1 (homologação) — 'unavailable' (HTTP 500) é a categoria
    // TECHNICAL_RETRYABLE inequívoca; 'fail_explicit' (400 genérico) deixou de
    // ser failover-eligible sob a nova taxonomia mais rígida (ver teste 10).
    fakeEvolution.controlarInstancia('wa01-falha', { comportamento: 'unavailable' })
    fakeEvolution.controlarInstancia('wa02-reserva', { comportamento: 'ok' })
    await supabase.from('automacoes_config').update({ whatsapp_failover: true }).eq('id', 1)
    invalidarCacheFlags()

    const conta = await criarContaDeTeste(supabase)
    const resultado = await enviarComFailover({
      contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome, clienteTelefone: conta.telefone_cobranca,
      valor: conta.valor, mensagem: 'Teste failover', origem: 'manual',
    })

    assert.equal(resultado.status, 'sent')
    assert.equal(resultado.instancia, 'wa02-reserva')
    assert.equal(fakeEvolution.mensagensEnviadas.length, 1, 'só WA02 deve ter efetivamente enviado')

    const { data: dispatches } = await supabase.from('collection_dispatches').select('id').eq('contas_financeiras_id', conta.id)
    assert.equal(dispatches.length, 1, 'apenas 1 dispatch lógico, mesmo com 2 tentativas')

    const { data: tentativas } = await supabase.from('collection_dispatch_attempts').select('*').eq('dispatch_id', dispatches[0].id).order('attempt_number', { ascending: true })
    assert.equal(tentativas.length, 2)
    assert.equal(tentativas[0].status, 'failed')
    assert.equal(tentativas[1].status, 'sent')

    await supabase.from('automacoes_config').update({ whatsapp_failover: false }).eq('id', 1)
    invalidarCacheFlags()
  })

  await t.test('3. WA01 fica pending (sent) — WA02 NÃO envia imediatamente', async () => {
    fakeEvolution.resetar()
    await limparInstanciasDeTeste(supabase)
    await criarInstancia(supabase, 'wa01-pending', 1, 'principal')
    await criarInstancia(supabase, 'wa02-standby', 2, 'reserva')
    fakeEvolution.controlarInstancia('wa01-pending', { comportamento: 'ok' })
    await supabase.from('automacoes_config').update({ whatsapp_failover: true, failover_on_delivery_timeout: false }).eq('id', 1)
    invalidarCacheFlags()

    const conta = await criarContaDeTeste(supabase)
    const resultado = await enviarComFailover({
      contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome, clienteTelefone: conta.telefone_cobranca,
      valor: conta.valor, mensagem: 'Teste pending', origem: 'manual',
    })

    assert.equal(resultado.status, 'sent')
    assert.equal(fakeEvolution.mensagensEnviadas.length, 1, 'WA02 nunca deveria ter sido chamado — sucesso na 1ª tentativa encerra o loop')
    await supabase.from('automacoes_config').update({ whatsapp_failover: false }).eq('id', 1)
    invalidarCacheFlags()
  })

  await t.test('4. Mensagem entregue (ACK) cancela futuras tentativas — nunca regride status', async () => {
    fakeEvolution.resetar()
    await limparInstanciasDeTeste(supabase)
    await criarInstancia(supabase, 'wa01-ack', 1, 'principal')
    fakeEvolution.controlarInstancia('wa01-ack', { comportamento: 'ok' })
    const conta = await criarContaDeTeste(supabase)

    const resultado = await enviarComFailover({
      contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome, clienteTelefone: conta.telefone_cobranca,
      valor: conta.valor, mensagem: 'Teste ACK', origem: 'manual',
    })
    const providerMessageId = fakeEvolution.mensagensEnviadas[0].msgId

    await aplicarAckDeEntrega(providerMessageId, 'DELIVERY_ACK')
    let { data: dispatch } = await supabase.from('collection_dispatches').select('status').eq('id', resultado.dispatchId).single()
    assert.equal(dispatch.status, 'delivered')

    await aplicarAckDeEntrega(providerMessageId, 'SERVER_ACK')
    ;({ data: dispatch } = await supabase.from('collection_dispatches').select('status').eq('id', resultado.dispatchId).single())
    assert.equal(dispatch.status, 'delivered', 'ACK atrasado de status inferior não pode regredir o status')
  })

  await t.test('5. Webhook duplicado é idempotente — 2º evento igual não reprocessa', async () => {
    const externalId = `messages.update:teste-${Date.now()}:READ`
    const r1 = await registrarEventoExterno({ provider: 'evolution', eventType: 'messages.update', externalId, payload: { x: 1 } })
    const r2 = await registrarEventoExterno({ provider: 'evolution', eventType: 'messages.update', externalId, payload: { x: 1 } })
    assert.equal(r1.novo, true)
    assert.equal(r2.novo, false, 'segundo registro do MESMO evento deve ser reconhecido como duplicata')
  })

  await t.test('6. Worker "reinicia" no meio (2 chamadas concorrentes) — não duplica cobrança', async () => {
    fakeEvolution.resetar()
    await limparInstanciasDeTeste(supabase)
    await criarInstancia(supabase, 'wa01-concorrente', 1, 'principal')
    fakeEvolution.controlarInstancia('wa01-concorrente', { comportamento: 'ok' })
    const conta = await criarContaDeTeste(supabase)

    const args = {
      contasFinanceirasId: conta.id, etapa: 5, clienteNome: conta.pessoa_nome, clienteTelefone: conta.telefone_cobranca,
      valor: conta.valor, mensagem: 'Teste concorrência', origem: 'cron',
    }
    const [r1, r2] = await Promise.all([enviarComFailover(args), enviarComFailover(args)])

    const statusFinais = [r1.status, r2.status].sort()
    assert.ok(statusFinais.includes('sent'), JSON.stringify({ r1, r2 }))
    assert.equal(fakeEvolution.mensagensEnviadas.length, 1, 'idempotência: só 1 envio real deve ter ocorrido')

    const { data: dispatches } = await supabase.from('collection_dispatches').select('id').eq('contas_financeiras_id', conta.id).eq('etapa', 5)
    assert.equal(dispatches.length, 1, 'apenas 1 collection_dispatches, mesmo com 2 chamadas concorrentes')
  })

  await t.test('9. N instâncias cadastradas NÃO multiplicam o limite diário global', async () => {
    fakeEvolution.resetar()
    await limparInstanciasDeTeste(supabase)
    await criarInstancia(supabase, 'wa01-multi', 1, 'principal')
    await criarInstancia(supabase, 'wa02-multi', 2, 'reserva')
    await criarInstancia(supabase, 'wa03-multi', 3, 'reserva')
    invalidarCacheFlags()
    const config = await obterConfigCobranca()
    assert.equal(config.global_daily_limit, 30, 'o limite é GLOBAL (na config), não multiplicado pelo número de instâncias cadastradas')
  })

  await pararAmbienteDeTeste()
})
