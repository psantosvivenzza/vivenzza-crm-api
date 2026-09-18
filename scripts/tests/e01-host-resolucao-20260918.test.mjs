// Resolução do host do NetVision. O que estes testes protegem é a diferença
// entre "sync perdeu uma janela e recupera" e "sync aponta para o endereço
// errado com cara de configurado" — o segundo é bem pior.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ARQUIVO_CACHE = path.join(__dirname, '..', '..', '.localdev', 'e01-host-cache.json')

function limparCache() {
  try { fs.unlinkSync(ARQUIVO_CACHE) } catch { /* já não existe */ }
}
function escreverCache(conteudo) {
  fs.mkdirSync(path.dirname(ARQUIVO_CACHE), { recursive: true })
  fs.writeFileSync(ARQUIVO_CACHE, JSON.stringify(conteudo))
}

// Import tardio e com cache-busting: o módulo lê process.env a cada chamada,
// mas o arquivo de cache é lido do disco, então cada teste monta o estado.
async function carregar() {
  return import(`../../src/lib/e01Host.js?t=${Math.random()}`)
}

const HOST_INEXISTENTE = 'nao-existe-este-host-vivenzza-teste'

test('host que já é IP literal é devolvido como está', async () => {
  limparCache()
  const { resolverHostE01 } = await carregar()
  process.env.E01_HOST = '127.0.0.1'
  delete process.env.E01_HOST_IP
  assert.equal(await resolverHostE01(), '127.0.0.1')
})

test('resolução bem-sucedida grava o IP no cache', async () => {
  limparCache()
  const { resolverHostE01 } = await carregar()
  process.env.E01_HOST = '127.0.0.1'
  await resolverHostE01()
  const cache = JSON.parse(fs.readFileSync(ARQUIVO_CACHE, 'utf8'))
  assert.equal(cache.host, '127.0.0.1')
  assert.equal(cache.ip, '127.0.0.1')
})

test('nome que não resolve cai no cache ANTES da reserva fixa', async () => {
  escreverCache({ host: HOST_INEXISTENTE, ip: '192.168.1.200', em: new Date().toISOString() })
  const { resolverHostE01 } = await carregar()
  process.env.E01_HOST = HOST_INEXISTENTE
  process.env.E01_HOST_IP = '192.168.1.108'
  assert.equal(
    await resolverHostE01(), '192.168.1.200',
    'o último IP que funcionou é mais recente que a reserva do .env — é ele que acompanha troca de DHCP'
  )
})

test('sem cache, o nome que não resolve cai na reserva do .env', async () => {
  limparCache()
  const { resolverHostE01 } = await carregar()
  process.env.E01_HOST = HOST_INEXISTENTE
  process.env.E01_HOST_IP = '192.168.1.108'
  assert.equal(await resolverHostE01(), '192.168.1.108')
})

test('cache gravado para OUTRO host não é usado', async () => {
  escreverCache({ host: 'outra-maquina-qualquer', ip: '10.0.0.9', em: new Date().toISOString() })
  const { resolverHostE01 } = await carregar()
  process.env.E01_HOST = HOST_INEXISTENTE
  process.env.E01_HOST_IP = '192.168.1.108'
  assert.equal(await resolverHostE01(), '192.168.1.108', 'cache é por nome de host, não global')
})

test('sem cache e sem reserva, o erro original sobe (não some)', async () => {
  limparCache()
  const { resolverHostE01 } = await carregar()
  process.env.E01_HOST = HOST_INEXISTENTE
  delete process.env.E01_HOST_IP
  await assert.rejects(() => resolverHostE01(), /ENOTFOUND|EAI_AGAIN|getaddrinfo/)
})

test('cache corrompido não derruba a resolução', async () => {
  fs.mkdirSync(path.dirname(ARQUIVO_CACHE), { recursive: true })
  fs.writeFileSync(ARQUIVO_CACHE, 'isto nao e json')
  const { resolverHostE01 } = await carregar()
  process.env.E01_HOST = HOST_INEXISTENTE
  process.env.E01_HOST_IP = '192.168.1.108'
  assert.equal(await resolverHostE01(), '192.168.1.108')
})

test('configE01 devolve a config inteira com o host já resolvido', async () => {
  limparCache()
  const { configE01 } = await carregar()
  process.env.E01_HOST = '127.0.0.1'
  process.env.E01_PORT = '5432'
  process.env.E01_USER = 'u'
  process.env.E01_PASSWORD = 'p'
  process.env.E01_DATABASE = 'e01'
  const cfg = await configE01({ max: 3 })
  assert.equal(cfg.host, '127.0.0.1')
  assert.equal(cfg.database, 'e01')
  assert.equal(cfg.max, 3)
  assert.equal(cfg.connectionTimeoutMillis, 8000)
})

test.after(() => { limparCache(); void os })
