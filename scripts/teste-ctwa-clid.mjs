// Teste unitário de detectarCtwaClid (src/routes/webhook-handler.js) — puro,
// sem I/O. Cobre os dois formatos de payload que a Evolution API pode mandar
// pra um clique em anúncio "Click to WhatsApp": Cloud API oficial
// (referral.ctwa_clid, snake_case) e Baileys/multi-device
// (contextInfo.externalAdReply.ctwaClid, camelCase). Existe porque a auditoria
// de tráfego de 2026-08-04 encontrou ctwa_clid 0/2.135 preenchido nos últimos
// 30 dias — ver AUDITORIA_TRAFEGO_PAGO.md §3.1 e CHANGELOG_TRAFEGO.md.
import { detectarCtwaClid } from '../src/routes/webhook-handler.js'

let falhas = 0
function check(nome, cond) {
  if (cond) console.log(`OK — ${nome}`)
  else { falhas++; console.log(`FALHOU — ${nome}`) }
}

check('Cloud API oficial (referral.ctwa_clid)',
  detectarCtwaClid({ referral: { ctwa_clid: 'ABC123', headline: 'B2B Regiões' } }) === 'ABC123')

check('Baileys/multi-device (contextInfo.externalAdReply.ctwaClid, extendedTextMessage)',
  detectarCtwaClid({ message: { extendedTextMessage: { contextInfo: { externalAdReply: { ctwaClid: 'XYZ789' } } } } }) === 'XYZ789')

check('Baileys/multi-device via imageMessage',
  detectarCtwaClid({ message: { imageMessage: { contextInfo: { externalAdReply: { ctwaClid: 'IMG456' } } } } }) === 'IMG456')

check('mensagem sem referral nem externalAdReply retorna null (não inventa clid)',
  detectarCtwaClid({ message: { conversation: 'oi, tudo bem?' } }) === null)

check('objeto vazio retorna null', detectarCtwaClid({}) === null)

console.log(`\n${falhas === 0 ? 'TODOS OS TESTES PASSARAM' : `${falhas} TESTE(S) FALHARAM`}`)
process.exit(falhas === 0 ? 0 : 1)
