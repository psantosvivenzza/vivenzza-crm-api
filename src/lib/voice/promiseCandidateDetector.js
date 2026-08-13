// Voice AI EXTERNAL PILOT READINESS — a IA pode PERCEBER que o cliente
// disse algo como "pago sexta", mas nesta fase (readiness, ainda sem
// cliente real) isso vira só um CANDIDATO pra revisão humana — nunca uma
// promessa real, nunca baixa título, nunca muta financeiro. A decisão de
// como (e se) transformar isso numa promessa real fica pra uma fase futura,
// deliberadamente fora deste MVP.
const INTENTS_COM_PROMESSA_POTENCIAL = new Set(['QUERO_PAGAR', 'PEDIDO_NOVA_DATA'])

export function detectarPromiseCandidate(classificacao, geracao) {
  if (!INTENTS_COM_PROMESSA_POTENCIAL.has(classificacao?.intent)) return null
  return {
    promise_candidate: true,
    intent_origem: classificacao.intent,
    data_extraida: geracao?.extractedDate ?? null,
    aviso: 'CANDIDATO apenas — nenhuma promessa real foi criada, nenhum título foi baixado, nenhuma mutação financeira ocorreu',
  }
}
