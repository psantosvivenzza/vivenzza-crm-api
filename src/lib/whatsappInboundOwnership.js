import { timingSafeEqual } from 'node:crypto'
import { fzapWebhookSecret } from './fzapWebhookSecret.js'
import { readFzapConfig } from './fzapConnections.js'
import { whatsappTransportFor } from './whatsappProviderClient.js'
import { normalizeFzapWebhook } from './fzapWebhookEvents.js'
import { ownershipStore } from './whatsappOwnershipStore.js'

const unavailable = (res) => res.status(503).json({ erro: 'Não foi possível confirmar a conexão WhatsApp agora.' })
const defaultFinancialCheck = async (instanceName) => (await import('./collection/whatsappInstances.js')).ehInstanciaFinanceira(instanceName)

// Ownership is read for every event. An outage never enables a second transport.
export function createEvolutionOwnershipMiddleware({ env = process.env, getConfig = () => readFzapConfig(env), transportFor, store = ownershipStore } = {}) {
  return async function evolutionOwnership(req, res, next) {
    try {
      const config = getConfig()
      if (!config?.connections?.length) return next()
      const instance = req.body?.instance ?? req.body?.instanceName
      if (typeof instance !== 'string' || !instance) return unavailable(res)
      const connection = config.connections.find((item) => item.instanceName === instance)
      if (!connection) return next()
      let owner
      if (transportFor) owner = await transportFor(instance, { env }) // isolated legacy fixture seam
      else {
        const state = await store.get(connection.id)
        if (state.instanceName !== connection.instanceName || state.finalidade !== connection.finalidade) return unavailable(res)
        owner = state.owner
      }
      if (owner === 'fzap') return res.json({ status: 'ignored' })
      if (owner === 'evolution') return next()
      return unavailable(res)
    } catch { return unavailable(res) }
  }
}

export const evolutionOwnership = createEvolutionOwnershipMiddleware()

// Factory has no imports of handlers, database or jobs; mount with explicit callbacks.
export function createFzapWebhookHandler({ env = process.env, getConfig = () => readFzapConfig(env), transportFor = whatsappTransportFor, normalize = normalizeFzapWebhook, financial, commercial, site, financialCheck = defaultFinancialCheck, logger = console, now = () => Date.now(), dedupMaxEntries = 10000 } = {}) {
  // Process-local only: no exactly-once promise across replicas or restarts.
  // Full cache rejects new work rather than evicting an unexpired reservation.
  const messages = new Map()
  const maxEntries = Math.min(10000, Math.max(1, dedupMaxEntries))
  const ttl = 6 * 60 * 60 * 1000
  return async function fzapWebhook(req, res) {
    let reservationKey
    let reservation
    const expected = fzapWebhookSecret(env.FZAP_WEBHOOK_SECRET, req.params?.id)
    if (typeof expected !== 'string' || expected.length < 32 || expected.length > 256) return unavailable(res)
    const sent = req.headers?.['x-fzap-webhook-token']
    const a = Buffer.from(typeof sent === 'string' && sent.length <= 256 ? sent : '', 'utf8')
    const b = Buffer.from(expected, 'utf8')
    if (a.length !== b.length || !timingSafeEqual(a, b)) return res.status(401).json({ erro: 'Token de webhook inválido' })
    try {
      const config = getConfig()
      const connection = config?.connections?.find((item) => item.id === req.params?.id)
      if (!connection) return res.status(404).json({ erro: 'Conexão não encontrada' })
      const owner = await transportFor(connection.instanceName, { env })
      if (owner === 'evolution') return res.json({ status: 'ignored' })
      if (owner !== 'fzap') return unavailable(res)
      // A direction-only sender never creates a sales lead, replies as Lara or
      // enters the debt collection inbox. Authentication and ownership still apply.
      if (connection.finalidade === 'notificacoes') return res.json({ status: 'ignored' })
      const event = normalize(req.body, connection.instanceName)
      if (!event) return res.json({ status: 'ignored' })
      // Config purpose alone cannot authorize the financial inbox: its existing
      // registry must independently confirm the same domain before any dispatch.
      const registeredFinancial = await financialCheck(connection.instanceName)
      if (typeof registeredFinancial !== 'boolean' || (connection.finalidade === 'financeiro') !== registeredFinancial) return unavailable(res)
      if (event.event === 'messages.upsert' && typeof event.data?.key?.id === 'string') {
        for (const [key, entry] of messages) if (!entry.inflight && entry.expiresAt <= now()) messages.delete(key)
        reservationKey = JSON.stringify([connection.id, event.data.key.remoteJid, event.data.key.fromMe, event.data.key.id])
        const previous = messages.get(reservationKey)
        if (previous) {
          // An in-flight operation without successful acknowledgement can fail;
          // ask the provider to retry instead of acknowledging a possible loss.
          if (!previous.acked && (!previous.res?.headersSent || previous.res.statusCode >= 400)) return unavailable(res)
          return res.json({ status: 'ignored' })
        }
        if (messages.size >= maxEntries) return unavailable(res)
        reservation = { inflight: true, expiresAt: now() + ttl, res }
        messages.set(reservationKey, reservation)
      }
      // Instance identity comes solely from the authenticated URL allowlist.
      req.body = event
      const isSite = connection.instanceName === env.SDR_SITE_INSTANCE?.trim() || connection.instanceName === 'Mesagens Site Reativação'
      if (isSite) {
        if (connection.finalidade !== 'comercial' || typeof site !== 'function') return unavailable(res)
        return await site(req, res, { provider: 'fzap' })
      }
      if (connection.finalidade === 'financeiro') {
        if (typeof financial !== 'function') return unavailable(res)
        await financial(event, { financialExpected: true })
        return res.json({ status: 'received' })
      }
      if (connection.finalidade !== 'comercial' || typeof commercial !== 'function') return unavailable(res)
      return await commercial(req, res)
    } catch {
      // Existing SDR acknowledges before processing; never send a second response.
      if (!res.headersSent) return unavailable(res)
      logger.error('[fzap-webhook] processing_failed_after_ack', { code: 'FZAP_INBOUND_AFTER_ACK_FAILED', connection_id: /^[a-z0-9][a-z0-9_-]{0,63}$/.test(req.params?.id || '') ? req.params.id : 'invalid' })
    } finally {
      if (reservation) {
        reservation.inflight = false
        if (!res.headersSent || res.statusCode >= 400) messages.delete(reservationKey)
        else {
          reservation.acked = true
          reservation.expiresAt = now() + ttl
        }
        // Do not retain Express req/res (and thereby message bodies) for the TTL.
        delete reservation.res
      }
    }
  }
}
