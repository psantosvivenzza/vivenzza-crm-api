import test from 'node:test'
import assert from 'node:assert/strict'
import { createFzapConnectionsRouter } from '../../src/routes/whatsapp-conexoes.js'
import { FzapConnectionError } from '../../src/lib/fzapConnections.js'

const admin = { email: 'psantos@vivenzzaprofessional.com.br', role: 'admin' }
function request(router, { method = 'GET', url = '/', user = admin, body } = {}) {
  return new Promise((resolve, reject) => {
    const result = { status: 200, headers: {}, body: null }
    const res = {
      set(name, value) { result.headers[name] = value; return this },
      vary(name) { result.headers.Vary = name; return this },
      status(value) { result.status = value; return this },
      json(value) { result.body = value; resolve(result); return this },
    }
    router.handle({ method, url, user, body, headers: {} }, res, (error) => error ? reject(error) : resolve({ ...result, status: 404 }))
  })
}

test('todas as rotas negam anônimo, vendedor e outro admin antes do serviço', async () => {
  const service = { list: () => assert.fail('service called'), connect: () => assert.fail('service called'), qr: () => assert.fail('service called'), complete: () => assert.fail('service called') }
  const router = createFzapConnectionsRouter({ service })
  for (const user of [null, { role: 'admin', email: 'outra@example.test' }, { ...admin, role: 'vendedor' }, { role: 'vendedor' }]) {
    for (const [method, url] of [['GET', '/'], ['POST', '/comercial/conectar'], ['GET', '/comercial/qr'], ['POST', '/comercial/concluir-migracao']]) {
      const result = await request(router, { method, url, user })
      assert.equal(result.status, 403)
      assert.equal(result.headers['Cache-Control'], 'no-store, max-age=0')
    }
  }
})

test('DTO normal e QR usam no-store e somente ID da rota chega ao serviço', async () => {
  const calls = []
  const router = createFzapConnectionsRouter({ service: {
    list: async () => ({ configurado: false, conexoes: [] }),
    connect: async (id) => { calls.push(id); return { estado: 'conectando', qrcode: null } },
    qr: async (id) => { calls.push(id); return { estado: 'conectado', qrcode: null } },
    complete: async (id) => { calls.push(id); return { estado: 'conectado', transporte_ativo: 'fzap', qrcode: null } },
  } })
  assert.equal((await request(router)).body.configurado, false)
  assert.equal((await request(router, { method: 'POST', url: '/comercial/conectar', body: { token: 'attacker', url: 'http://169.254.169.254' } })).status, 200)
  assert.equal((await request(router, { url: '/comercial/qr' })).body.estado, 'conectado')
  assert.equal((await request(router, { method: 'POST', url: '/comercial/concluir-migracao' })).body.transporte_ativo, 'fzap')
  assert.deepEqual(calls, ['comercial', 'comercial', 'comercial'])
})

test('erros desconhecidos são 503 sem detalhes e ID inexistente é 404', async () => {
  const router = createFzapConnectionsRouter({ service: {
    list: async () => { throw new Error('Authorization: SECRET_PROVIDER_TOKEN') },
    qr: async () => { throw new FzapConnectionError('NOT_FOUND', 404) },
  } })
  const failed = await request(router)
  assert.equal(failed.status, 503)
  assert.equal(JSON.stringify(failed).includes('SECRET_PROVIDER_TOKEN'), false)
  assert.equal((await request(router, { url: '/missing/qr' })).status, 404)
})

test('não oferece operações logout/disconnect/delete/send', async () => {
  const router = createFzapConnectionsRouter({ service: {} })
  for (const [method, url] of [['DELETE', '/comercial'], ['POST', '/comercial/desconectar'], ['POST', '/comercial/logout'], ['POST', '/comercial/enviar']]) {
    assert.equal((await request(router, { method, url })).status, 404)
  }
})
