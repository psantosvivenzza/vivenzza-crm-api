import { createHmac } from 'node:crypto'

// Each webhook gets a distinct credential; reading one instance's configuration
// cannot authenticate events for another instance or reveal the root secret.
export function fzapWebhookSecret(master, id) {
  if (typeof master !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(master)
    || typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) return null
  return createHmac('sha256', master).update(id, 'utf8').digest('hex')
}
