// Voice AI EXTERNAL PILOT READINESS — vocabulário de resultado, separado em
// duas dimensões que NUNCA devem ser misturadas:
//
// 1. RESULTADO TÉCNICO — o que aconteceu com o CANAL (discou? tocou?
//    atendeu? caiu?). Nada aqui sabe o que foi dito na conversa.
// 2. RESULTADO CONVERSACIONAL — a intenção final classificada pelo MESMO
//    cérebro do WhatsApp (intentClassifier.js — reexportado aqui, nunca
//    duplicado). Nada aqui decide sozinho se a ligação "funcionou".
//
// Nenhum dos dois, isoladamente ou combinados, vira mutação financeira
// automática — ver promiseCandidateDetector.js.
export const RESULTADOS_TECNICOS = Object.freeze([
  'CREATED', 'RINGING', 'ANSWERED', 'NO_ANSWER', 'BUSY', 'FAILED', 'COMPLETED', 'HANGUP',
])

export { INTENTS as RESULTADOS_CONVERSACIONAIS } from '../collection/ai/intentClassifier.js'
