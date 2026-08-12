// Integração operacional (2026-08-12) — cobranca-whatsapp.js (cron + disparo
// manual em massa) e cobrancas.js (disparo manual individual) agora delegam
// para o motor novo (dispatchEngine/enviarComFailover) através de um ponto
// único (collectionRouting.js/enviarCobrancaComRoteamento), gateado por
// automacoes_config.multi_whatsapp. Cenários A-H do pedido de homologação:
// preservação do legado com a flag desligada, ativação do motor novo com a
// flag ligada, reuso das regras de failover já homologadas na FASE C.3D
// (nada redesenhado aqui), idempotência através do ponto de roteamento
// (cobre tanto "cron não duplica" quanto "manual não duplica" — a chave de
// idempotência não distingue origem) e exclusão estrutural do pool comercial.
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

test('Roteamento operacional multi-WhatsApp (cenários A-H)', async (t) => {
  const fakeEvolution = await iniciarAmbienteDeTeste()
  const { supabase } = await import('../../../src/lib/supabase-admin.server.js')
  const { enviarCobrancaComRoteamento } = await import('../../../src/lib/collection/collectionRouting.js')
  const { selecionarProximaInstancia } = await import('../../../src/lib/collection/whatsappInstances.js')
  const { invalidarCacheFlags } = await import('../../../src/lib/collection/featureFlags.js')

  async function setFlags({ multiWhatsapp, whatsappFailover = false }) {
    await supabase.from('automacoes_config').update({ multi_whatsapp: multiWhatsapp, whatsapp_failover: whatsappFailover }).eq('id', 1)
    invalidarCacheFlags()
  }

  await t.test('A. multi_whatsapp=false → sender legado chamado, dispatchEngine NÃO chamado', async () => {
    fakeEvolution.resetar()
    await limparInstanciasDeTeste(supabase)
    await setFlags({ multiWhatsapp: false })
    // FINANCEIRO_WHATSAPP_INSTANCE em _setup.mjs = 'teste-financeiro-01' — o
    // sender legado sempre usa essa instância fixa, nunca lê whatsapp_instances.
    fakeEvolution.controlarInstancia('teste-financeiro-01', { comportamento: 'ok' })

    const conta = await criarContaDeTeste(supabase)
    const resultado = await enviarCobrancaComRoteamento({
      contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
      clienteTelefone: conta.telefone_cobranca, valor: conta.valor, mensagem: 'Teste A', origem: 'cron',
    })

    assert.equal(resultado.status, 'sent')
    assert.equal(resultado.motor, 'legado')
    assert.equal(fakeEvolution.mensagensEnviadas.length, 1)
    assert.equal(fakeEvolution.mensagensEnviadas[0].instancia, 'teste-financeiro-01')

    const { data: dispatches } = await supabase.from('collection_dispatches').select('id').eq('contas_financeiras_id', conta.id)
    assert.equal(dispatches.length, 0, 'dispatchEngine não deveria ter criado nenhum registro com a flag desligada')
  })

  await t.test('B. multi_whatsapp=true → dispatchEngine chamado, sender legado NÃO chamado', async () => {
    fakeEvolution.resetar()
    await limparInstanciasDeTeste(supabase)
    await criarInstancia(supabase, 'wa01-rot-b', 1, 'principal')
    fakeEvolution.controlarInstancia('wa01-rot-b', { comportamento: 'ok' })
    await setFlags({ multiWhatsapp: true })

    const conta = await criarContaDeTeste(supabase)
    const resultado = await enviarCobrancaComRoteamento({
      contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
      clienteTelefone: conta.telefone_cobranca, valor: conta.valor, mensagem: 'Teste B', origem: 'cron',
    })

    assert.equal(resultado.status, 'sent')
    assert.equal(resultado.motor, 'v2')
    assert.equal(fakeEvolution.mensagensEnviadas.length, 1)
    assert.equal(fakeEvolution.mensagensEnviadas[0].instancia, 'wa01-rot-b')
    assert.notEqual(fakeEvolution.mensagensEnviadas[0].instancia, 'teste-financeiro-01', 'sender legado não deveria ter sido chamado com a flag ligada')

    const { data: dispatches } = await supabase.from('collection_dispatches').select('id').eq('contas_financeiras_id', conta.id)
    assert.equal(dispatches.length, 1)

    await setFlags({ multiWhatsapp: false })
  })

  await t.test('C. whatsapp_failover=false → nenhuma reserva, mesmo em falha técnica elegível', async () => {
    fakeEvolution.resetar()
    await limparInstanciasDeTeste(supabase)
    await criarInstancia(supabase, 'wa01-rot-c', 1, 'principal')
    await criarInstancia(supabase, 'wa02-rot-c', 2, 'reserva')
    fakeEvolution.controlarInstancia('wa01-rot-c', { comportamento: 'unavailable' })
    fakeEvolution.controlarInstancia('wa02-rot-c', { comportamento: 'ok' })
    await setFlags({ multiWhatsapp: true, whatsappFailover: false })

    const conta = await criarContaDeTeste(supabase)
    const resultado = await enviarCobrancaComRoteamento({
      contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
      clienteTelefone: conta.telefone_cobranca, valor: conta.valor, mensagem: 'Teste C', origem: 'cron',
    })

    assert.equal(resultado.status, 'failed')
    assert.equal(fakeEvolution.mensagensEnviadas.length, 0, 'reserva nunca deveria ter sido chamada com whatsapp_failover=false')

    await setFlags({ multiWhatsapp: false })
  })

  await t.test('D. whatsapp_failover=true + falha técnica elegível → reserva assume', async () => {
    fakeEvolution.resetar()
    await limparInstanciasDeTeste(supabase)
    await criarInstancia(supabase, 'wa01-rot-d', 1, 'principal')
    await criarInstancia(supabase, 'wa02-rot-d', 2, 'reserva')
    fakeEvolution.controlarInstancia('wa01-rot-d', { comportamento: 'unavailable' })
    fakeEvolution.controlarInstancia('wa02-rot-d', { comportamento: 'ok' })
    await setFlags({ multiWhatsapp: true, whatsappFailover: true })

    const conta = await criarContaDeTeste(supabase)
    const resultado = await enviarCobrancaComRoteamento({
      contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
      clienteTelefone: conta.telefone_cobranca, valor: conta.valor, mensagem: 'Teste D', origem: 'cron',
    })

    assert.equal(resultado.status, 'sent')
    assert.equal(resultado.instancia, 'wa02-rot-d')
    assert.equal(fakeEvolution.mensagensEnviadas.length, 1, 'só a reserva deveria ter efetivamente enviado')

    const { data: dispatches } = await supabase.from('collection_dispatches').select('id').eq('contas_financeiras_id', conta.id)
    assert.equal(dispatches.length, 1, '1 única cobrança lógica, mesmo com 2 tentativas')

    await setFlags({ multiWhatsapp: false })
  })

  await t.test('E. Erro não elegível (429) → nunca troca de instância, mesmo com whatsapp_failover=true', async () => {
    fakeEvolution.resetar()
    await limparInstanciasDeTeste(supabase)
    await criarInstancia(supabase, 'wa01-rot-e', 1, 'principal')
    await criarInstancia(supabase, 'wa02-rot-e', 2, 'reserva')
    fakeEvolution.controlarInstancia('wa01-rot-e', { comportamento: 'rate_limited' })
    fakeEvolution.controlarInstancia('wa02-rot-e', { comportamento: 'ok' })
    await setFlags({ multiWhatsapp: true, whatsappFailover: true })

    const conta = await criarContaDeTeste(supabase)
    const resultado = await enviarCobrancaComRoteamento({
      contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
      clienteTelefone: conta.telefone_cobranca, valor: conta.valor, mensagem: 'Teste E', origem: 'cron',
    })

    assert.equal(resultado.status, 'failed')
    assert.equal(resultado.categoria, 'RATE_LIMIT')
    assert.equal(fakeEvolution.mensagensEnviadas.length, 0, 'a reserva NUNCA deveria ter sido chamada — 429 é pra pausar, não contornar')

    await setFlags({ multiWhatsapp: false })
  })

  await t.test('F/G. Chamada repetida da MESMA cobrança lógica (cron e manual) através do roteamento não duplica', async () => {
    // idempotencyKeyDispatch (idempotency.js) é cobranca:{contasFinanceirasId}:
    // etapa{etapa}:{diaBrt} — não inclui `origem`, então cron e manual disputando
    // a mesma cobrança lógica colidem na mesma chave por construção. Isso já é
    // provado no motor (dispatch-engine.test.mjs, cenário 6); aqui prova-se que
    // o ponto de roteamento novo não abre uma segunda via de duplicidade.
    fakeEvolution.resetar()
    await limparInstanciasDeTeste(supabase)
    await criarInstancia(supabase, 'wa01-rot-fg', 1, 'principal')
    fakeEvolution.controlarInstancia('wa01-rot-fg', { comportamento: 'ok' })
    await setFlags({ multiWhatsapp: true })

    const conta = await criarContaDeTeste(supabase)
    const args = {
      contasFinanceirasId: conta.id, etapa: 4, clienteNome: conta.pessoa_nome,
      clienteTelefone: conta.telefone_cobranca, valor: conta.valor, mensagem: 'Teste F/G',
    }
    const r1 = await enviarCobrancaComRoteamento({ ...args, origem: 'cron' })
    const r2 = await enviarCobrancaComRoteamento({ ...args, origem: 'manual' })

    assert.equal(r1.status, 'sent')
    assert.equal(r2.motivo, 'idempotencia_existente', 'a 2ª chamada lógica (cron ou manual) deveria ser reconhecida como a mesma cobrança')
    assert.equal(fakeEvolution.mensagensEnviadas.length, 1, 'só 1 envio real, mesmo com cron e manual disputando a mesma cobrança lógica')

    const { data: dispatches } = await supabase.from('collection_dispatches').select('id').eq('contas_financeiras_id', conta.id).eq('etapa', 4)
    assert.equal(dispatches.length, 1)

    await setFlags({ multiWhatsapp: false })
  })

  await t.test('H. Instância comercial (vivenzza/vivenzza-teste-cloud) nunca entra no pool financeiro, mesmo se cadastrada por engano', async () => {
    await limparInstanciasDeTeste(supabase)
    await criarInstancia(supabase, 'vivenzza', 1, 'principal') // priority 1 — venceria se não fosse bloqueada
    await criarInstancia(supabase, 'vivenzza-teste-cloud', 2, 'reserva')
    await criarInstancia(supabase, 'wa-financeiro-legitima', 3, 'reserva')

    const escolhida = await selecionarProximaInstancia({})
    assert.equal(escolhida?.instance_name, 'wa-financeiro-legitima', 'só a instância financeira legítima deveria ser elegível — comercial excluída mesmo com prioridade melhor')
  })

  await pararAmbienteDeTeste()
})
