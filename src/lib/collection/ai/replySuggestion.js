// IA WhatsApp MVP — orquestrador: mensagem recebida -> classifica intenção ->
// carrega contexto permitido -> gera sugestão de resposta -> valida
// politica/regras no backend -> registra (shadow, nunca envia) -> disponível
// pro operador via API read-only.
//
// SIMPLIFICAÇÃO DELIBERADA (registrada, não silenciosa): o contexto (título,
// promessa ativa, status de pagamento, política de negociação) é carregado
// DETERMINISTICAMENTE pelo backend (collectionContext.js), não escolhido pelo
// LLM via tool-calling. `tools_requested` no resultado reflete essas fontes
// fixas, não uma decisão livre da IA. Isso reduz a superfície de risco de um
// MVP que ainda não tem aprovação humana no loop de execução — tool-calling
// real (IA escolhendo o que consultar) fica como evolução natural, não
// bloqueante para este MVP.
import { classificarIntencao } from './intentClassifier.js'
import { getAIProvider } from './aiProvider.js'
import { carregarContextoCliente } from './collectionContext.js'
import { registrarSugestao } from './shadowSuggestions.js'
import { registrarEvento, ORIGEM } from '../timeline.js'

const ACAO_POR_INTENT = {
  QUERO_PAGAR: 'ENVIAR_INSTRUCOES_PAGAMENTO',
  PRECISO_BOLETO_PIX: 'ENVIAR_PIX_OU_BOLETO',
  PEDIDO_NOVA_DATA: 'REGISTRAR_PROMESSA_DRAFT',
  SEM_CONDICAO_AGORA: 'ENCAMINHAR_HUMANO',
  JA_PAGUEI: 'VERIFICAR_PAGAMENTO',
  CONTESTA_VALOR: 'ENCAMINHAR_HUMANO',
  QUERO_ATENDENTE: 'ENCAMINHAR_HUMANO',
  DUVIDA_GERAL: 'RESPONDER_DUVIDA',
  UNKNOWN: 'ENCAMINHAR_HUMANO',
}

// Requer humano SEMPRE, independente de confidence — pedido explícito do
// projeto: contestação de valor, cliente pede atendente, situação financeira
// ambígua ("sem condição agora" sem proposta de data) e intent não reconhecido.
const INTENTS_SEMPRE_HUMANO = new Set(['CONTESTA_VALOR', 'QUERO_ATENDENTE', 'SEM_CONDICAO_AGORA', 'UNKNOWN'])

const TOOLS_REQUESTED_FIXO = Object.freeze(['titulo_aberto', 'promessa_ativa', 'status_pagamento', 'politica_negociacao'])

const GERACAO_SYSTEM_PROMPT_BASE = `Você é um assistente de cobrança financeira educado e direto, respondendo em português do Brasil.
Gere uma resposta curta e cordial para a mensagem do cliente, considerando o contexto financeiro fornecido.
NUNCA prometa desconto, parcelamento ou condição especial que não esteja explicitamente autorizada no contexto.
NUNCA confirme recebimento de pagamento sem que o contexto diga que já foi confirmado.
Se o cliente propôs uma data de pagamento, tente identificar essa data no formato AAAA-MM-DD.
Responda APENAS com um JSON válido no formato:
{"suggested_reply": "<texto da resposta sugerida>", "extracted_date": "<AAAA-MM-DD ou null>"}
Não adicione texto fora do JSON.`

async function gerarSugestaoDeResposta({ mensagemCliente, contexto, intent }) {
  const provider = getAIProvider()
  if (!(await provider.disponivel())) {
    return { suggestedReply: null, extractedDate: null, motivo: 'ai_indisponivel' }
  }

  const hojeBrt = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
  const contextoResumo = {
    saldo: contexto.titulo?.saldo ?? null,
    vencimento: contexto.titulo?.vencimento ?? null,
    quitado: contexto.quitado,
    promessaAtiva: Boolean(contexto.promessaAtiva),
    politicaNegociacaoDisponivel: Boolean(contexto.politica),
  }
  const systemPrompt = `${GERACAO_SYSTEM_PROMPT_BASE}\nHoje é ${hojeBrt}.\nContexto do título: ${JSON.stringify(contextoResumo)}\nIntenção já classificada: ${intent}.`

  try {
    const resposta = await provider.chat({ systemPrompt, messages: [{ role: 'user', content: mensagemCliente }], jsonMode: true })
    let parsed = null
    try {
      parsed = JSON.parse(resposta.content ?? '')
    } catch {
      parsed = null
    }
    if (!parsed || typeof parsed.suggested_reply !== 'string') {
      return { suggestedReply: null, extractedDate: null, motivo: 'json_invalido_do_llm' }
    }
    return { suggestedReply: parsed.suggested_reply, extractedDate: parsed.extracted_date || null }
  } catch (err) {
    return { suggestedReply: null, extractedDate: null, motivo: `erro_geracao: ${err.message}` }
  }
}

export async function sugerirRespostaCliente({ contasFinanceirasId, clienteTelefone, mensagemCliente }) {
  const classificacao = await classificarIntencao(mensagemCliente)
  const contexto = await carregarContextoCliente({ contasFinanceirasId })

  const reasonCodes = []
  let requiresHuman = classificacao.needsHuman
  if (classificacao.motivo) reasonCodes.push(classificacao.motivo)
  if (INTENTS_SEMPRE_HUMANO.has(classificacao.intent)) {
    requiresHuman = true
    reasonCodes.push(`intent_sempre_humano:${classificacao.intent}`)
  }
  if (contexto.quitado) {
    requiresHuman = true
    reasonCodes.push('titulo_ja_quitado')
  }
  if (!contexto.politica && classificacao.intent === 'PEDIDO_NOVA_DATA') {
    reasonCodes.push('sem_politica_negociacao_ativa')
  }

  const geracao = await gerarSugestaoDeResposta({ mensagemCliente, contexto, intent: classificacao.intent })
  if (geracao.motivo) reasonCodes.push(geracao.motivo)

  // PROMISE_DRAFT: nunca grava em collection_promises de verdade — só um campo
  // jsonb dentro do shadow, para revisão humana decidir se confirma.
  const promiseCandidate = classificacao.intent === 'PEDIDO_NOVA_DATA' && geracao.extractedDate && !contexto.quitado
    ? { data_sugerida: geracao.extractedDate, valor: contexto.titulo?.saldo ?? null, status: 'candidata_revisao_humana' }
    : null

  const recommendedAction = ACAO_POR_INTENT[classificacao.intent] ?? 'ENCAMINHAR_HUMANO'

  const registro = await registrarSugestao({
    contasFinanceirasId,
    clienteTelefone,
    mensagemCliente,
    intent: classificacao.intent,
    confidence: classificacao.confidence ?? 'baixa',
    clienteIrritado: classificacao.clienteIrritado ?? false,
    suggestedReply: geracao.suggestedReply,
    recommendedAction,
    requiresHuman,
    reasonCodes,
    extractedDate: geracao.extractedDate,
    promiseCandidate,
    toolsRequested: [...TOOLS_REQUESTED_FIXO],
    aiProvider: getAIProvider().nome,
  })

  await registrarEvento({
    contasFinanceirasId,
    clienteTelefone,
    tipo: 'SUGESTAO_IA',
    origem: ORIGEM.AI,
    descricao: `Sugestão de IA (shadow, sem envio): intent=${classificacao.intent}, ação=${recommendedAction}, requires_human=${requiresHuman}`,
    dados: { suggestion_id: registro.id, intent: classificacao.intent, recommended_action: recommendedAction, requires_human: requiresHuman, reason_codes: reasonCodes },
  })

  return registro
}
