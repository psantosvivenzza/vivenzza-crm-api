// IA WhatsApp MVP — classificação estruturada de intenção da mensagem
// recebida. Nunca confia em JSON cru do LLM: valida contra os valores
// permitidos e, se inválido/ausente, cai em 'UNKNOWN' + needsHuman=true em vez
// de travar o fluxo ou inventar um intent.
//
// Política de confidence/fallback: além do formato, o modelo também informa
// `confidence` (autoavaliação — heurístico, não probabilidade calibrada) e
// `cliente_irritado`. Confidence baixa ou cliente irritado força
// needsHuman=true mesmo com um intent validamente reconhecido — "não
// improvisar": melhor escalar demais do que decidir uma resposta financeira
// errada sozinha.
import { getAIProvider } from './aiProvider.js'

export const INTENTS = Object.freeze([
  'QUERO_PAGAR', 'PRECISO_BOLETO_PIX', 'PEDIDO_NOVA_DATA', 'SEM_CONDICAO_AGORA',
  'JA_PAGUEI', 'CONTESTA_VALOR', 'QUERO_ATENDENTE', 'DUVIDA_GERAL', 'UNKNOWN',
])

// Exportado — reaproveitado tanto pela chamada direta (abaixo) quanto pelo
// worker local (jobQueue.js prepara o job com este MESMO prompt, pra nunca
// haver 2 versões divergentes do guardrail rodando em paralelo).
export const CLASSIFY_SYSTEM_PROMPT = `Você classifica mensagens de clientes recebidas em uma conversa de cobrança financeira.
Responda APENAS com um JSON válido no formato:
{"intent": "<uma das opções>", "confidence": "<alta|media|baixa>", "cliente_irritado": <true|false>}

Opções válidas de intent: ${INTENTS.join(', ')}.
QUERO_PAGAR = cliente quer pagar mas não confirmou ainda nem pediu boleto/pix especificamente.
PRECISO_BOLETO_PIX = cliente pede boleto, pix, código de pagamento, segunda via.
PEDIDO_NOVA_DATA = cliente propõe pagar em outra data (ex: "pago sexta", "consigo só semana que vem").
SEM_CONDICAO_AGORA = cliente diz que não tem condição de pagar agora, sem propor data.
JA_PAGUEI = cliente afirma já ter pago.
CONTESTA_VALOR = cliente questiona/discorda do valor cobrado.
QUERO_ATENDENTE = cliente pede explicitamente para falar com uma pessoa/atendente.
DUVIDA_GERAL = pergunta que não se encaixa nas anteriores.
UNKNOWN = não dá pra classificar com segurança nas opções acima.
Use "confidence":"baixa" sempre que a mensagem for ambígua, confusa, tiver múltiplas
intenções misturadas, ou você não tiver certeza real. Não infle a confiança.
Não adicione texto fora do JSON. Se não tiver certeza do intent, use "UNKNOWN".`

// Nunca confia em JSON cru do LLM (worker local incluso) — valida contra o
// enum sempre no BACKEND, nunca no worker.
export function validarClassificacao(json) {
  if (!json || typeof json !== 'object') return null
  if (!INTENTS.includes(json.intent)) return null
  const confidence = ['alta', 'media', 'baixa'].includes(json.confidence) ? json.confidence : 'baixa'
  const clienteIrritado = json.cliente_irritado === true
  return { intent: json.intent, confidence, clienteIrritado }
}

// Política de confidence/fallback aplicada sobre um resultado JÁ validado —
// mesma regra pro caminho direto e pro resultado vindo do worker.
export function resolverClassificacao(validado) {
  if (!validado) return { intent: 'UNKNOWN', needsHuman: true, motivo: 'json_invalido_do_llm' }
  const { intent, confidence, clienteIrritado } = validado
  if (confidence === 'baixa') return { intent, needsHuman: true, motivo: 'confidence_baixa', confidence, clienteIrritado }
  if (clienteIrritado) return { intent, needsHuman: true, motivo: 'cliente_irritado', confidence, clienteIrritado }
  return { intent, needsHuman: false, confidence, clienteIrritado }
}

export async function classificarIntencao(textoCliente) {
  const provider = getAIProvider()

  if (!(await provider.disponivel())) {
    return { intent: 'UNKNOWN', needsHuman: true, motivo: 'ai_indisponivel' }
  }

  try {
    const resposta = await provider.chat({
      systemPrompt: CLASSIFY_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: textoCliente }],
      jsonMode: true,
    })
    let parsed = null
    try {
      parsed = JSON.parse(resposta.content ?? '')
    } catch {
      parsed = null
    }
    return resolverClassificacao(validarClassificacao(parsed))
  } catch (err) {
    return { intent: 'UNKNOWN', needsHuman: true, motivo: `erro_classificacao: ${err.message}` }
  }
}
