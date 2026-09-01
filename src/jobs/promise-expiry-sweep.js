// 2026-09-01 — agendamento do processamento de promessas vencidas
// (processarPromessasVencidas, promises.js — já existia, nunca tinha
// scheduler ativo; o job antigo que o chamava está em quarentena). Toda
// promessa 'ativa' com promised_date < hoje BRT vira 'quebrada', o que
// libera o título de volta pra régua (promessaAtivaPara() passa a
// retornar null) — o próximo ciclo normal da régua decide o que fazer,
// este job NUNCA envia mensagem/liga. Idempotente por construção: a query
// de vencidas é sempre `status='ativa' AND promised_date < hoje`, então uma
// promessa já marcada 'quebrada' não é encontrada de novo.
import { processarPromessasVencidas } from '../lib/collection/promises.js'
import { hojeBrtISO } from '../lib/collection/collectionContactPolicy.js'

export async function runPromiseExpirySweep() {
  const quebradas = await processarPromessasVencidas(hojeBrtISO())
  console.log('[promise-expiry-sweep] concluído:', { quebradas: quebradas.length })
  return { quebradas: quebradas.length }
}
