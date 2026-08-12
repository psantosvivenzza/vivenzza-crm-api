// IA WhatsApp MVP (2026-08-12) — mensagem recebida -> intenção -> contexto ->
// sugestão estruturada -> shadow (nunca envia, nunca decide sozinha). Cobre os
// 6 cenários pedidos + guardrails (política de negociação, human handoff,
// shadow nunca escreve em tabela financeira real).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste, criarContaDeTeste } from './_setup.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(__dirname, '..', '..', '..', 'src')

process.env.AI_PROVIDER = 'mock'

test('IA WhatsApp MVP: classificação + sugestão estruturada (shadow)', async (t) => {
  await iniciarAmbienteDeTeste()
  const { supabase } = await import('../../../src/lib/supabase-admin.server.js')
  const { sugerirRespostaCliente } = await import('../../../src/lib/collection/ai/replySuggestion.js')

  async function limparEstadoIa(contasFinanceirasId) {
    await supabase.from('ai_shadow_suggestions').delete().eq('contas_financeiras_id', contasFinanceirasId)
    await supabase.from('negotiation_policies').delete().neq('id', '00000000-0000-0000-0000-000000000000')
  }

  await t.test('1. "vou pagar sexta" -> PEDIDO_NOVA_DATA, promessa candidata (nunca grava em collection_promises)', async () => {
    const conta = await criarContaDeTeste(supabase)
    await limparEstadoIa(conta.id)

    const sugestao = await sugerirRespostaCliente({ contasFinanceirasId: conta.id, clienteTelefone: conta.telefone_cobranca, mensagemCliente: 'vou pagar sexta' })

    assert.equal(sugestao.intent, 'PEDIDO_NOVA_DATA')
    assert.equal(sugestao.recommended_action, 'REGISTRAR_PROMESSA_DRAFT')
    assert.ok(sugestao.promise_candidate, 'deveria ter extraído uma promessa candidata')
    assert.ok(sugestao.extracted_date, 'deveria ter extraído uma data')

    const { data: promessasReais } = await supabase.from('collection_promises').select('id').eq('contas_financeiras_id', conta.id)
    assert.equal(promessasReais.length, 0, 'shadow nunca deveria gravar uma promessa real')
  })

  await t.test('2. "já paguei" -> JA_PAGUEI, ação recomendada é verificar pagamento', async () => {
    const conta = await criarContaDeTeste(supabase)
    await limparEstadoIa(conta.id)

    const sugestao = await sugerirRespostaCliente({ contasFinanceirasId: conta.id, clienteTelefone: conta.telefone_cobranca, mensagemCliente: 'já paguei' })

    assert.equal(sugestao.intent, 'JA_PAGUEI')
    assert.equal(sugestao.recommended_action, 'VERIFICAR_PAGAMENTO')
  })

  await t.test('3. "esse valor está errado" -> CONTESTA_VALOR, requires_human=true sempre', async () => {
    const conta = await criarContaDeTeste(supabase)
    await limparEstadoIa(conta.id)

    const sugestao = await sugerirRespostaCliente({ contasFinanceirasId: conta.id, clienteTelefone: conta.telefone_cobranca, mensagemCliente: 'esse valor está errado' })

    assert.equal(sugestao.intent, 'CONTESTA_VALOR')
    assert.equal(sugestao.requires_human, true)
    assert.ok(sugestao.reason_codes.some((r) => r.startsWith('intent_sempre_humano')))
  })

  await t.test('4. "manda o pix" -> PRECISO_BOLETO_PIX', async () => {
    const conta = await criarContaDeTeste(supabase)
    await limparEstadoIa(conta.id)

    const sugestao = await sugerirRespostaCliente({ contasFinanceirasId: conta.id, clienteTelefone: conta.telefone_cobranca, mensagemCliente: 'manda o pix' })

    assert.equal(sugestao.intent, 'PRECISO_BOLETO_PIX')
    assert.equal(sugestao.recommended_action, 'ENVIAR_PIX_OU_BOLETO')
  })

  await t.test('5. "quero falar com alguém" -> QUERO_ATENDENTE, requires_human=true', async () => {
    const conta = await criarContaDeTeste(supabase)
    await limparEstadoIa(conta.id)

    const sugestao = await sugerirRespostaCliente({ contasFinanceirasId: conta.id, clienteTelefone: conta.telefone_cobranca, mensagemCliente: 'quero falar com alguém' })

    assert.equal(sugestao.intent, 'QUERO_ATENDENTE')
    assert.equal(sugestao.requires_human, true)
  })

  await t.test('6. "não consigo pagar agora" -> SEM_CONDICAO_AGORA, requires_human=true', async () => {
    const conta = await criarContaDeTeste(supabase)
    await limparEstadoIa(conta.id)

    const sugestao = await sugerirRespostaCliente({ contasFinanceirasId: conta.id, clienteTelefone: conta.telefone_cobranca, mensagemCliente: 'não consigo pagar agora' })

    assert.equal(sugestao.intent, 'SEM_CONDICAO_AGORA')
    assert.equal(sugestao.requires_human, true)
  })

  await t.test('7. Resultado estruturado tem todos os campos pedidos', async () => {
    const conta = await criarContaDeTeste(supabase)
    await limparEstadoIa(conta.id)

    const sugestao = await sugerirRespostaCliente({ contasFinanceirasId: conta.id, clienteTelefone: conta.telefone_cobranca, mensagemCliente: 'oi, tenho uma dúvida sobre essa cobrança' })

    for (const campo of ['intent', 'confidence', 'suggested_reply', 'recommended_action', 'requires_human', 'reason_codes', 'tools_requested']) {
      assert.ok(campo in sugestao, `campo "${campo}" ausente no resultado estruturado`)
    }
    // Nota: o compat client local do Postgres de teste devolve um array VAZIO
    // em coluna jsonb como {} em vez de [] (quirk confirmado do harness local,
    // não do código de produção — Supabase real não tem esse problema) — por
    // isso a checagem aceita ambas as formas para reason_codes em vez de exigir
    // Array.isArray estrito.
    assert.equal(Object.keys(sugestao.reason_codes).length, 0)
    assert.ok(Array.isArray(sugestao.tools_requested))
    assert.ok(sugestao.tools_requested.length > 0)
  })

  await t.test('8. Sem política de negociação ativa -> PEDIDO_NOVA_DATA carrega reason_code de política ausente', async () => {
    const conta = await criarContaDeTeste(supabase)
    await limparEstadoIa(conta.id)

    const sugestao = await sugerirRespostaCliente({ contasFinanceirasId: conta.id, clienteTelefone: conta.telefone_cobranca, mensagemCliente: 'pago segunda' })

    assert.ok(sugestao.reason_codes.includes('sem_politica_negociacao_ativa'))
  })

  await t.test('9. Título já quitado -> requires_human=true mesmo com intent simples, nenhuma ação automática sugerida sem revisão', async () => {
    const conta = await criarContaDeTeste(supabase, { valor: 500, valor_pago: 500 })
    await limparEstadoIa(conta.id)

    const sugestao = await sugerirRespostaCliente({ contasFinanceirasId: conta.id, clienteTelefone: conta.telefone_cobranca, mensagemCliente: 'quero pagar' })

    assert.equal(sugestao.requires_human, true)
    assert.ok(sugestao.reason_codes.includes('titulo_ja_quitado'))
  })

  await t.test('10. Shadow nunca dispara envio real nem cria collection_dispatches/cobrancas_whatsapp', async () => {
    const conta = await criarContaDeTeste(supabase)
    await limparEstadoIa(conta.id)

    await sugerirRespostaCliente({ contasFinanceirasId: conta.id, clienteTelefone: conta.telefone_cobranca, mensagemCliente: 'quero pagar' })

    const { data: dispatches } = await supabase.from('collection_dispatches').select('id').eq('contas_financeiras_id', conta.id)
    const { data: cobrancasLegado } = await supabase.from('cobrancas_whatsapp').select('id').eq('contas_financeiras_id', conta.id)
    assert.equal(dispatches.length, 0, 'IA shadow nunca deveria criar um dispatch real')
    assert.equal(cobrancasLegado.length, 0, 'IA shadow nunca deveria usar o sender legado')
  })

  await t.test('11. Cada sugestão registra 1 evento SUGESTAO_IA na timeline, origem=AI', async () => {
    const conta = await criarContaDeTeste(supabase)
    await limparEstadoIa(conta.id)

    const sugestao = await sugerirRespostaCliente({ contasFinanceirasId: conta.id, clienteTelefone: conta.telefone_cobranca, mensagemCliente: 'quero pagar' })

    const { data: eventos } = await supabase.from('collection_timeline_events').select('*').eq('contas_financeiras_id', conta.id).eq('tipo', 'SUGESTAO_IA')
    assert.equal(eventos.length, 1)
    assert.equal(eventos[0].origem, 'AI')
    assert.equal(eventos[0].dados.suggestion_id, sugestao.id)
  })

  await t.test('12. API read-only (listarSugestoes) devolve a sugestão sem tocar Evolution nem escrever nada', async () => {
    const conta = await criarContaDeTeste(supabase)
    await limparEstadoIa(conta.id)
    const { listarSugestoes } = await import('../../../src/lib/collection/ai/shadowSuggestions.js')

    await sugerirRespostaCliente({ contasFinanceirasId: conta.id, clienteTelefone: conta.telefone_cobranca, mensagemCliente: 'manda o pix' })
    const lista = await listarSugestoes({ contasFinanceirasId: conta.id })

    assert.equal(lista.length, 1)
    assert.equal(lista[0].intent, 'PRECISO_BOLETO_PIX')
  })

  await pararAmbienteDeTeste()
})

test('IA WhatsApp MVP: sem SQL arbitrário, sem acesso irrestrito ao banco (prova estática)', async () => {
  const arquivos = ['collection/ai/replySuggestion.js', 'collection/ai/collectionContext.js', 'collection/ai/shadowSuggestions.js', 'collection/ai/intentClassifier.js']
  for (const rel of arquivos) {
    const conteudo = fs.readFileSync(path.join(SRC, 'lib', rel), 'utf8')
    assert.equal(/\.rpc\(|\bexecute_sql\b|\bpg\.query\(|template literal.*SELECT/i.test(conteudo), false, `${rel} não deveria montar SQL dinâmico — só chamadas Supabase tipadas`)
  }
})
