// 2026-09-13 — achado real: processWhatsappEvent (src/routes/webhook-handler.js)
// logava telefone completo + trecho do CONTEÚDO da mensagem em toda mensagem
// processada (console.log incondicional, sem erro nenhum) e, no catch geral,
// dumpava o PAYLOAD BRUTO da Evolution (JSON.stringify(payload).slice(0,200))
// — que sempre inclui key.remoteJid (telefone completo) e, na maioria dos
// eventos, message.conversation (conteúdo da mensagem) bem dentro dos
// primeiros 200 caracteres. Ambos os logs vão para stdout/stderr do processo
// (Railway) em toda mensagem/erro, sem nenhuma necessidade operacional que
// justifique expor telefone completo ou conteúdo de conversa.
//
// Este teste usa telefone e conteúdo 100% SINTÉTICOS (nunca dado real) para
// provar adversarialmente que, após a correção, nenhum dos dois vaza em
// nenhum log emitido por esta função — nem no caminho feliz, nem no catch
// geral (payload propositalmente malformado pra forçar uma exceção depois
// que o conteúdo sensível já está no objeto `payload`).
import { test, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste } from './_setup.mjs'

let supabase, processWhatsappEvent

const TELEFONE_SINTETICO = '5551900009999' // sintético — nunca um número real
const SEGREDO_SINTETICO = 'SEGREDO_SINTETICO_NAO_VAZAR_7f3a9c'
const CONTEUDO_MENSAGEM_SINTETICO = `Minha senha é ${SEGREDO_SINTETICO} e meu cartão é 4111-1111-1111-1111`

const idsLeadsCriados = []
const evolutionIdsCriados = []

before(async () => {
  await iniciarAmbienteDeTeste()
  ;({ supabase } = await import('../../../src/lib/supabase-admin.server.js'))
  ;({ processWhatsappEvent } = await import('../../../src/routes/webhook-handler.js'))
})

after(async () => {
  if (evolutionIdsCriados.length) await supabase.from('whatsapp_mensagens').delete().in('evolution_id', evolutionIdsCriados)
  if (idsLeadsCriados.length) await supabase.from('leads').delete().in('id', idsLeadsCriados)
  await pararAmbienteDeTeste()
})

// Captura tudo que passaria por console.log/console.error durante o teste,
// sem deixar nada realmente escrever no terminal (evita poluir a saída da
// suíte com o próprio conteúdo sintético sob teste).
let linhasLog = []
let originalLog, originalError
beforeEach(() => {
  linhasLog = []
  originalLog = console.log
  originalError = console.error
  console.log = (...args) => linhasLog.push(args.map(String).join(' '))
  console.error = (...args) => linhasLog.push(args.map(String).join(' '))
})
afterEach(() => {
  console.log = originalLog
  console.error = originalError
})

function assertNenhumLogContem(...proibidos) {
  for (const linha of linhasLog) {
    for (const proibido of proibidos) {
      assert.ok(
        !linha.includes(proibido),
        `log não deveria conter "${proibido}", mas encontrado em: ${linha}`,
      )
    }
  }
}

test('processWhatsappEvent: caminho feliz nunca loga telefone completo nem conteúdo da mensagem', async () => {
  const evolutionId = `sanit-happy-${Date.now()}`
  evolutionIdsCriados.push(evolutionId)

  await processWhatsappEvent({
    event: 'messages.upsert',
    instance: 'vivenzza',
    data: {
      key: { remoteJid: `${TELEFONE_SINTETICO}@s.whatsapp.net`, fromMe: false, id: evolutionId },
      message: { conversation: CONTEUDO_MENSAGEM_SINTETICO },
    },
  })

  assert.ok(linhasLog.length > 0, 'esperava pelo menos um log emitido pelo caminho feliz')

  // Nunca o telefone completo (nem com nem sem prefixo de país) nem o
  // conteúdo da mensagem/segredo sintético em nenhuma linha de log.
  assertNenhumLogContem(
    TELEFONE_SINTETICO,
    TELEFONE_SINTETICO.replace(/^55/, ''),
    SEGREDO_SINTETICO,
    CONTEUDO_MENSAGEM_SINTETICO,
    '4111-1111-1111-1111',
  )

  // Prova positiva: o log de operação continua existindo e usa o telefone
  // MASCARADO (só os últimos 4 dígitos visíveis), não omite a métrica toda.
  const linhaWebhook = linhasLog.find((l) => l.includes('[webhook]') && l.includes('entrada'))
  assert.ok(linhaWebhook, 'esperava a linha de log operacional [webhook] .. entrada')
  assert.match(linhaWebhook, /\*{4,}9999/, 'telefone deveria aparecer mascarado, terminando nos 4 últimos dígitos reais')
  assert.match(linhaWebhook, /tamanho:\s*\d+/, 'deveria reportar o tamanho da mensagem, nunca o texto')

  // Limpeza dos dados criados por este teste
  const { data: leads } = await supabase.from('leads').select('id').eq('telefone', TELEFONE_SINTETICO.replace(/^55/, ''))
  for (const l of leads ?? []) idsLeadsCriados.push(l.id)
})

test('processWhatsappEvent: catch geral nunca dumpa o payload bruto (telefone/conteúdo) quando o parsing falha', async () => {
  const evolutionId = `sanit-catch-${Date.now()}`

  // Payload adversarial: key.remoteJid propositalmente NÃO é string (objeto),
  // o que faz `remoteJid.endsWith(...)` estourar TypeError síncrono DEPOIS
  // que o payload inteiro (com o segredo sintético em message.conversation)
  // já foi recebido pela função — exatamente o cenário em que o código
  // antigo fazia `JSON.stringify(payload).slice(0, 200)` no catch.
  const payloadMalformado = {
    event: 'messages.upsert',
    instance: 'vivenzza',
    data: {
      key: { remoteJid: { isso: 'nao deveria ser um objeto' }, fromMe: false, id: evolutionId },
      message: { conversation: CONTEUDO_MENSAGEM_SINTETICO },
    },
  }

  await processWhatsappEvent(payloadMalformado)

  assert.ok(linhasLog.length > 0, 'esperava que o catch geral tivesse logado algo sobre a falha')
  assertNenhumLogContem(
    SEGREDO_SINTETICO,
    CONTEUDO_MENSAGEM_SINTETICO,
    '4111-1111-1111-1111',
    'isso', // nem fragmento do objeto malformado deveria vazar
  )

  const linhaErro = linhasLog.find((l) => l.includes('[webhook] erro ao processar evento'))
  assert.ok(linhaErro, 'esperava o log sanitizado de erro do catch geral')
  assert.match(linhaErro, /event:\s*messages\.upsert/, 'deveria reportar o tipo do evento, nunca o payload bruto')
})
