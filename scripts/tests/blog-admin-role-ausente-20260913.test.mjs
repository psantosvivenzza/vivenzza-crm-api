// Achado (2026-09-13): src/index.js montava `/api/blog` só com `auth`
// (`app.use('/api/blog', auth, blogRouter)`), sem `adminOnly` nem qualquer
// checagem de role — diferente de todo o resto dos endpoints de
// "administração de conteúdo/config" do repositório (campanhas, google-ads,
// evolution-health, erp, reativacao, usuarios, todos montados/gateados com
// adminOnly). `src/routes/blog.js` (POST /nuvemshop/publish, POST
// /wordpress/publish) também não faz NENHUMA checagem de papel internamente
// — diferente de automacoes.js, que tem seu próprio `router.use` restringindo
// a um único e-mail. Resultado: qualquer usuário autenticado (vendedor,
// financeiro, papel desconhecido) conseguia publicar posts de verdade no
// blog público da loja (Nuvemshop e/ou WordPress), uma ação de conteúdo
// pública e irreversível (o post fica no ar), sem nenhuma aprovação
// administrativa.
//
// Reproduzido isoladamente antes da correção: montando o router exatamente
// como em src/index.js (`auth, blogRouter`, sem adminOnly), um token de
// vendedor alcançava o handler das duas rotas — POST /nuvemshop/publish
// devolvia 400 (validação de campos obrigatórios, código de negócio, não de
// autorização) e POST /wordpress/publish devolvia 503 (WordPress não
// configurado neste ambiente) — nenhuma delas 403. Corrigido adicionando
// `adminOnly` ao mount em src/index.js (mesmo padrão de
// campanhas/google-ads/evolution-health/erp/reativacao), sem tocar
// src/routes/blog.js.
//
// Nenhuma chamada real à Nuvemshop/WordPress/WhatsApp acontece neste teste:
// todos os corpos são intencionalmente vazios/inválidos, então a checagem de
// autorização (que roda ANTES do handler) é o único código exercitado nos
// casos de vendedor/token ausente; nos casos de admin, o corpo continua
// vazio de propósito — a rota para na própria validação de campos
// obrigatórios (nuvemshop) ou no "não configurado" (wordpress) antes de
// qualquer requisição de rede, provando que o gate deixa admin passar sem
// depender de credenciais reais de Nuvemshop/WordPress neste ambiente.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import jwt from 'jsonwebtoken'
import { PG_USER, PG_PASSWORD, PG_PORT, PG_DATABASE } from '../localdb-config.mjs'

process.env.NODE_ENV = 'test'
process.env.LOCAL_PG_URL = `postgres://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${PG_DATABASE}`
process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-teste'

let supabase, server, porta
let idAdmin, idVendedor, idPapelDesconhecido
let tokenAdmin, tokenVendedor, tokenPapelDesconhecido, tokenSemRole

before(async () => {
  ;({ supabase } = await import('../../src/lib/supabase-admin.server.js'))

  const sufixo = Date.now()
  async function criarUsuarioDeTeste(role, rotulo) {
    const { data, error } = await supabase.from('usuarios')
      .insert({ nome: `${rotulo} (teste blog)`, email: `${rotulo}-${sufixo}@teste-blog.local`, role, ativo: true })
      .select('id').single()
    if (error) throw error
    return data.id
  }
  idAdmin = await criarUsuarioDeTeste('admin', 'admin')
  idVendedor = await criarUsuarioDeTeste('vendedor', 'vendedor')
  idPapelDesconhecido = await criarUsuarioDeTeste('gerente', 'papel-desconhecido')

  tokenAdmin = jwt.sign({ id: idAdmin, email: 'admin@teste.com', role: 'admin' }, process.env.JWT_SECRET)
  tokenVendedor = jwt.sign({ id: idVendedor, email: 'vendedor@teste.com', role: 'vendedor' }, process.env.JWT_SECRET)
  tokenPapelDesconhecido = jwt.sign({ id: idPapelDesconhecido, email: 'gerente@teste.com', role: 'gerente' }, process.env.JWT_SECRET)
  tokenSemRole = jwt.sign({ id: idAdmin, email: 'sem-role@teste.com' }, process.env.JWT_SECRET) // sem claim "role"

  const express = (await import('express')).default
  const { auth, adminOnly } = await import('../../src/middleware/auth.js')
  const blogRouter = (await import('../../src/routes/blog.js')).default

  const app = express()
  app.use(express.json())
  // Montagem IDÊNTICA (mesma ordem de middleware) ao mount corrigido de
  // src/index.js: app.use('/api/blog', auth, adminOnly, blogRouter)
  app.use('/api/blog', auth, adminOnly, blogRouter)

  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  porta = server.address().port
})

after(async () => {
  server?.close()
  await supabase.from('usuarios').delete().in('id', [idAdmin, idVendedor, idPapelDesconhecido])
})

function post(path, { token, body = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }
    if (token) headers.authorization = `Bearer ${token}`
    const req = http.request({ host: '127.0.0.1', port: porta, method: 'POST', path, headers }, (res) => {
      let chunks = ''
      res.on('data', (c) => { chunks += c })
      res.on('end', () => resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null }))
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

test('sem token — 401 nas duas rotas de publicação', async () => {
  assert.equal((await post('/api/blog/nuvemshop/publish')).status, 401)
  assert.equal((await post('/api/blog/wordpress/publish')).status, 401)
})

test('vendedor autenticado — 403 nas duas rotas (o achado: antes da correção, chegava no handler)', async () => {
  const r1 = await post('/api/blog/nuvemshop/publish', { token: tokenVendedor })
  assert.equal(r1.status, 403, JSON.stringify(r1.body))
  assert.match(r1.body.erro, /administradores/)

  const r2 = await post('/api/blog/wordpress/publish', { token: tokenVendedor })
  assert.equal(r2.status, 403, JSON.stringify(r2.body))
  assert.match(r2.body.erro, /administradores/)
})

test('papel desconhecido e token sem claim "role" — 403 (fail-closed, allowlist de adminOnly)', async () => {
  for (const [rotulo, token] of [['papel desconhecido (gerente)', tokenPapelDesconhecido], ['token sem claim "role"', tokenSemRole]]) {
    const r1 = await post('/api/blog/nuvemshop/publish', { token })
    assert.equal(r1.status, 403, `${rotulo} em nuvemshop/publish: esperava 403, veio ${r1.status}`)
    const r2 = await post('/api/blog/wordpress/publish', { token })
    assert.equal(r2.status, 403, `${rotulo} em wordpress/publish: esperava 403, veio ${r2.status}`)
  }
})

test('admin — gate deixa passar pro handler (não 403); corpo vazio de propósito, zero chamada de rede real', async () => {
  const r1 = await post('/api/blog/nuvemshop/publish', { token: tokenAdmin })
  assert.notEqual(r1.status, 403, `admin não pode ser bloqueado — corpo: ${JSON.stringify(r1.body)}`)
  assert.equal(r1.status, 400, JSON.stringify(r1.body))
  assert.match(r1.body.erro, /titulo.*conteudo_html|obrigat/)

  const r2 = await post('/api/blog/wordpress/publish', { token: tokenAdmin })
  assert.notEqual(r2.status, 403, `admin não pode ser bloqueado — corpo: ${JSON.stringify(r2.body)}`)
  assert.equal(r2.status, 503, JSON.stringify(r2.body))
  assert.match(r2.body.erro, /WordPress/)
})

// Achado da revisão adversarial (2026-09-13): os 4 testes acima montam seu
// próprio app Express repetindo `auth, adminOnly, blogRouter` — o mesmo
// padrão usado no resto da suíte (ex.: avaliacoes-admin-role-ausente), já
// que importar src/index.js de verdade dispara app.listen + vários
// cron.schedule + dependências externas. Isso prova que o MIDDLEWARE
// funciona, mas não prova que src/index.js de fato usa esse middleware no
// mount de produção: revertendo só a linha do mount em src/index.js (tirando
// `adminOnly`) os 4 testes acima continuam verdes, porque nunca leem esse
// arquivo. Este teste fecha esse gap com uma asserção estática mínima,
// específica desta correção.
test('src/index.js monta /api/blog com adminOnly (guarda contra regressão da correção)', async () => {
  const { readFileSync } = await import('node:fs')
  const conteudo = readFileSync(new URL('../../src/index.js', import.meta.url), 'utf8')
  const linhaMount = conteudo.split('\n').find((l) => l.includes("app.use('/api/blog'"))
  assert.ok(linhaMount, 'mount de /api/blog não encontrado em src/index.js')
  assert.match(
    linhaMount,
    /adminOnly/,
    `mount de /api/blog em src/index.js não inclui adminOnly (regressão da correção desta PR): ${linhaMount}`
  )
})
