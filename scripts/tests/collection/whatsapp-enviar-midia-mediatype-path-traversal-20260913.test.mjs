// 2026-09-13 — achado real (auditoria de uploads de arquivo): POST
// /api/whatsapp/enviar-midia (src/routes/whatsapp.js) monta o path de destino
// no Supabase Storage assim:
//
//   const storagePath = `${mediatype || 'document'}/${evolutionId}_${safeFile}`
//
// `fileName` (→ safeFile) É sanitizado (`.replace(/[^a-zA-Z0-9._-]/g, '_')`),
// mas `mediatype` — também vindo direto de req.body, sem validação nenhuma —
// NÃO É. `mediatype` vira o PRIMEIRO segmento do path (a "pasta"), então
// qualquer usuário autenticado (a rota só exige `auth`, nenhum papel
// específico — vendedor inclusive) pode escapar do prefixo esperado
// (image/video/audio/document) dentro do bucket "whatsapp-media" mandando,
// por exemplo, mediatype: "../../catalogos-internos".
//
// Este teste prova o comportamento ADVERSARIALMENTE por instrumentação real:
// substitui supabase.storage por um interceptor que grava o path exato que o
// código de produção passaria pro Supabase Storage de verdade (sem nunca
// tocar em Supabase real nem em disco) — não é uma reimplementação da lógica,
// é o código de produção rodando de ponta a ponta via HTTP.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import jwt from 'jsonwebtoken'
import express from 'express'
import { PG_USER, PG_PASSWORD, PG_PORT, PG_DATABASE } from '../../localdb-config.mjs'

process.env.NODE_ENV = 'test'
process.env.LOCAL_PG_URL = `postgres://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${PG_DATABASE}`
process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-teste'
process.env.EVOLUTION_API_KEY = 'fake-key-teste'

let supabase, server, porta, fakeEvolutionServer
let tokenVendedor

// Fake mínimo da Evolution API — só o endpoint que /enviar-midia chama
// (POST /message/sendMedia/:instance). Não reaproveita scripts/tests/fakes/
// fakeEvolution.js de propósito: aquele fake é compartilhado por toda a
// suíte de cobrança e não implementa sendMedia — criar um servidor dedicado
// aqui evita qualquer alteração em infraestrutura de teste compartilhada.
function criarFakeEvolutionSendMedia() {
  return http.createServer((req, res) => {
    if (req.method === 'POST' && req.url.startsWith('/message/sendMedia/')) {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ key: { id: `fake-media-msg-${Date.now()}` } }))
      return
    }
    res.statusCode = 404
    res.end()
  })
}

before(async () => {
  fakeEvolutionServer = criarFakeEvolutionSendMedia()
  await new Promise((resolve) => fakeEvolutionServer.listen(0, '127.0.0.1', resolve))
  process.env.EVOLUTION_API_URL = `http://127.0.0.1:${fakeEvolutionServer.address().port}`

  // Dynamic import DEPOIS de setar LOCAL_PG_URL/EVOLUTION_API_URL — ambos são
  // lidos na primeira vez que cada módulo é importado (mesma convenção usada
  // em notas-entrada-controle-acesso.test.mjs e _setup.mjs).
  ;({ supabase } = await import('../../../src/lib/supabase-admin.server.js'))
  const { auth } = await import('../../../src/middleware/auth.js')
  const whatsappRouter = (await import('../../../src/routes/whatsapp.js')).default

  const app = express()
  app.use(express.json({ limit: '20mb' }))
  app.use('/api/whatsapp', auth, whatsappRouter) // mesmo mount de src/index.js
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  porta = server.address().port

  // Papel mais baixo possível (vendedor) — a rota não exige nenhum papel
  // específico, então o pior caso já é "qualquer usuário autenticado".
  tokenVendedor = jwt.sign({ id: 'vendedor-teste', email: 'vendedor@teste.com', role: 'vendedor' }, process.env.JWT_SECRET)
})

after(async () => {
  server?.close()
  await new Promise((resolve) => fakeEvolutionServer.close(resolve))
  // Mesmo achado documentado em sdr-registrar-saida-erro.test.mjs: importar
  // src/routes/whatsapp.js puxa src/routes/sdr.js, que registra um
  // setInterval de 15min sem .unref() (limpeza de ultimoProcessamentoPorTelefone)
  // — fora do escopo desta PR (domínio de rate-limit do SDR, não de upload de
  // arquivo). Sem isso, o processo do `node --test` nunca encerra sozinho.
  // Todas as asserções já rodaram antes deste ponto — a pequena espera abaixo
  // só dá tempo do reporter do node:test terminar de escrever no stdout antes
  // do process.exit() (mesmo achado de sdr-registrar-saida-erro.test.mjs).
  await new Promise((resolve) => setTimeout(resolve, 200))
  process.exit(process.exitCode ?? 0)
})

function chamar(method, path, { token = tokenVendedor, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { authorization: `Bearer ${token}` }
    if (body) headers['content-type'] = 'application/json'
    const req = http.request({ host: '127.0.0.1', port: porta, method, path, headers }, (res) => {
      let chunks = ''
      res.on('data', (c) => { chunks += c })
      res.on('end', () => resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null }))
    })
    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

// Interceptor real de supabase.storage — troca o objeto do MESMO `supabase`
// importado por whatsapp.js (módulos ES são singletons) por um que só
// REGISTRA o path recebido, nunca escreve em Supabase real nem em disco.
// Prova por instrumentação, não por inferência, exatamente qual storagePath
// o código de produção calculou.
function instalarInterceptorStorage() {
  const chamadasUpload = []
  const storageOriginal = supabase.storage
  supabase.storage = {
    from(bucket) {
      return {
        async upload(path) {
          chamadasUpload.push({ bucket, path })
          return { data: { path }, error: null }
        },
        getPublicUrl(path) {
          return { data: { publicUrl: `http://fake-storage.local/${bucket}/${path}` } }
        },
      }
    },
  }
  return {
    chamadasUpload,
    remover() { supabase.storage = storageOriginal },
  }
}

test('POST /api/whatsapp/enviar-midia — mediatype controlado pelo cliente não pode escapar do prefixo de pasta no Storage', async (tSuite) => {
  await tSuite.test('achado: mediatype com ".." chega intacto no path de destino do Supabase Storage (sem sanitização/allowlist)', async () => {
    const interceptor = instalarInterceptorStorage()
    try {
      const mediaBase64 = Buffer.from('conteudo-sintetico-de-teste').toString('base64')
      const r = await chamar('POST', '/api/whatsapp/enviar-midia', {
        body: {
          numero: '5551999998888',
          media: mediaBase64,
          mediatype: '../../catalogos-internos', // payload adversarial — não é image/video/audio/document
          mimetype: 'application/pdf',
          fileName: 'boleto.pdf',
        },
      })

      assert.equal(r.status, 200, `esperava 200 (rota deve seguir normalmente); resposta: ${JSON.stringify(r.body)}`)
      assert.equal(interceptor.chamadasUpload.length, 1, 'esperava exatamente 1 chamada a supabase.storage.from(...).upload(...)')

      const { bucket, path } = interceptor.chamadasUpload[0]
      assert.equal(bucket, 'whatsapp-media')

      // Este é o achado: nenhuma validação impede que "mediatype" escape do
      // prefixo esperado (image|video|audio|document) dentro do bucket.
      assert.ok(
        !path.includes('..') && /^(image|video|audio|document)\//.test(path),
        `path de storage deveria ficar dentro de uma pasta conhecida (image|video|audio|document), sem "..", mas veio: "${path}"`,
      )
    } finally {
      interceptor.remover()
    }
  })

  await tSuite.test('regressão: mediatype válido (document) continua gravando no prefixo correto, nome de arquivo continua sanitizado', async () => {
    const interceptor = instalarInterceptorStorage()
    try {
      const mediaBase64 = Buffer.from('conteudo-sintetico-de-teste-2').toString('base64')
      const r = await chamar('POST', '/api/whatsapp/enviar-midia', {
        body: {
          numero: '5551999998888',
          media: mediaBase64,
          mediatype: 'document',
          mimetype: 'application/pdf',
          fileName: '../../etc/passwd.pdf', // fileName malicioso — já era sanitizado antes desta correção
          caption: 'nota fiscal',
        },
      })

      assert.equal(r.status, 200, `esperava 200; resposta: ${JSON.stringify(r.body)}`)
      assert.equal(interceptor.chamadasUpload.length, 1)
      const { bucket, path } = interceptor.chamadasUpload[0]
      assert.equal(bucket, 'whatsapp-media')
      assert.match(path, /^document\//, 'mediatype válido deve continuar gravando em document/')
      // safeFile já trocava "/" por "_" antes desta correção (não é o achado desta
      // PR) — confirma que esse comportamento pré-existente continua intacto: só
      // pode haver 1 separador de pasta no path inteiro (o do mediatype).
      assert.equal(path.split('/').length, 2, 'nome de arquivo sanitizado não pode reintroduzir separador de pasta')
    } finally {
      interceptor.remover()
    }
  })

  await tSuite.test('regressão: mediatype ausente continua usando o default "document" (comportamento anterior preservado)', async () => {
    const interceptor = instalarInterceptorStorage()
    try {
      const mediaBase64 = Buffer.from('conteudo-sintetico-de-teste-3').toString('base64')
      const r = await chamar('POST', '/api/whatsapp/enviar-midia', {
        body: {
          numero: '5551999998888',
          media: mediaBase64,
          fileName: 'arquivo.bin',
        },
      })

      assert.equal(r.status, 200, `esperava 200; resposta: ${JSON.stringify(r.body)}`)
      assert.equal(interceptor.chamadasUpload.length, 1)
      assert.match(interceptor.chamadasUpload[0].path, /^document\//)
    } finally {
      interceptor.remover()
    }
  })
})
