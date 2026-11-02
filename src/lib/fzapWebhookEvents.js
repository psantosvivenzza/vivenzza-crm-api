// Contract: FZAP 1.36 Whatsmeow Message/Receipt envelopes. Authentication and
// transport ownership are checked by the route, never by fields in this payload.
// Source: https://github.com/tulir/whatsmeow/blob/main/types/events/events.go
const jid = (value) => typeof value === 'string' && /^[0-9]+(?::[0-9]+)?@(s\.whatsapp\.net|lid)$/.test(value)
// WhatsApp device suffix is routing metadata, never a phone digit. Only remove
// an explicitly numeric suffix from an already validated individual JID.
const canonicalJid = (value) => value.replace(/:[0-9]+@/, '@')
const id = (value) => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,256}$/.test(value)
const object = (value) => value && typeof value === 'object' && !Array.isArray(value)

function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value)
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000)
  }
  return undefined
}

// Flatten at most four protocol wrappers. Preserve the complete inner content
// and its contextInfo; outer context is retained when no inner context exists.
function unwrapMessage(input) {
  let message = input
  const wrappers = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'documentWithCaptionMessage']
  let inheritedContext
  for (let depth = 0; depth <= 4; depth++) {
    if (!object(message)) return null
    const wrapper = wrappers.find((kind) => Object.hasOwn(message, kind))
    if (!wrapper) return inheritedContext && !message.messageContextInfo ? { ...message, messageContextInfo: inheritedContext } : message
    if (depth === 4 || !object(message[wrapper]) || !object(message[wrapper].message)) return null
    inheritedContext = message.messageContextInfo || inheritedContext
    message = message[wrapper].message
  }
  return null
}

// Whatsmeow protobuf JSON preserves acronym casing. The existing CRM media
// pipeline uses the Evolution/Baileys spelling; adapt only these known fields.
function normalizeMediaFields(message, type) {
  if (!['imageMessage', 'audioMessage', 'videoMessage', 'documentMessage'].includes(type)) return message
  const source = message[type]
  if (!object(source)) return message
  const media = { ...source }
  let invalid = false
  for (const [native, canonical] of [['URL', 'url'], ['fileSHA256', 'fileSha256'], ['fileEncSHA256', 'fileEncSha256']]) {
    if (source[native] == null) continue
    if (typeof source[native] !== 'string' || !source[native]
      || (source[canonical] != null && source[canonical] !== source[native])) { invalid = true; continue }
    media[canonical] = source[native]
  }
  // Preserve the inbox message/placeholder even when its attachment is invalid.
  // An ambiguous credential must never reach the existing media downloader.
  if (invalid) for (const key of ['url', 'fileSha256', 'fileEncSha256']) delete media[key]
  return { ...message, [type]: media }
}

export function normalizeFzapWebhook(payload, instanceName) {
  if (typeof instanceName !== 'string' || !instanceName || !object(payload) || !object(payload.event)) return null
  const event = payload.event
  if (payload.type === 'Message') {
    const info = event.Info
    if (!object(info) || info.IsGroup === true || !id(info.ID) || !jid(info.Chat) || typeof info.IsFromMe !== 'boolean' || !object(event.Message)) return null
    // Unknown protocol/system messages are ignored, not invented as user text.
    let message = unwrapMessage(event.Message)
    if (!message) return null
    const kinds = ['conversation', 'extendedTextMessage', 'imageMessage', 'audioMessage', 'videoMessage', 'documentMessage', 'stickerMessage', 'contactMessage', 'contactsArrayMessage', 'locationMessage', 'liveLocationMessage', 'reactionMessage']
    const messageType = kinds.find((kind) => Object.hasOwn(message, kind))
    if (!messageType) return null
    message = normalizeMediaFields(message, messageType)
    const key = { id: info.ID, remoteJid: canonicalJid(info.Chat), fromMe: info.IsFromMe }
    // Only Whatsmeow's explicit alternate identity may resolve a LID; no phone repair.
    const alternate = info.IsFromMe ? info.RecipientAlt : info.SenderAlt
    if (info.Chat.endsWith('@lid') && jid(alternate) && alternate.endsWith('@s.whatsapp.net')) key.remoteJidAlt = canonicalJid(alternate)
    // An unresolved LID is not a phone number for any downstream domain.
    if (key.remoteJid.endsWith('@lid') && !key.remoteJidAlt) return null
    const data = { key, message, messageType }
    if (typeof info.PushName === 'string') data.pushName = info.PushName
    const time = timestamp(info.Timestamp)
    if (time !== undefined) data.messageTimestamp = time
    return { event: 'messages.upsert', instance: instanceName, data }
  }
  if (['Receipt', 'ReadReceipt'].includes(payload.type)) {
    if (event.IsGroup === true || !jid(event.Chat) || !Array.isArray(event.MessageIDs) || !event.MessageIDs.length || event.MessageIDs.some((value) => !id(value))) return null
    // read-self concerns our reading an incoming message, not delivery of a send.
    const status = { '': 'DELIVERY_ACK', delivered: 'DELIVERY_ACK', read: 'READ', played: 'PLAYED' }[event.Type]
    if (!status) return null
    return { event: 'messages.update', instance: instanceName, data: [...new Set(event.MessageIDs)].map((messageId) => ({ key: { id: messageId, remoteJid: canonicalJid(event.Chat) }, status })) }
  }
  return null
}
