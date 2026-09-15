// Fuso do módulo de ponto — mesma convenção do resto do repo
// (src/lib/collection/collectionContactPolicy.js): America/Sao_Paulo,
// BRT = UTC-3 fixo (sem horário de verão desde 2019).
export { hojeBrtISO, COLLECTION_TIMEZONE as PONTO_TIMEZONE } from '../collection/collectionContactPolicy.js'

import { COLLECTION_TIMEZONE as PONTO_TIMEZONE } from '../collection/collectionContactPolicy.js'

// Dia BRT (YYYY-MM-DD) de uma data/hora específica — usado para marcações
// vindas de correção aprovada, onde o dia relevante é o da hora corrigida,
// não o de hoje (diferente de hojeBrtISO(), que é sempre "agora").
export function diaBrtDe(data) {
  return new Date(data).toLocaleDateString('en-CA', { timeZone: PONTO_TIMEZONE })
}
