// Prova de ponta a ponta com o COMPONENTE WINDOWS DE VERDADE — não uma
// chave gerada em Node, mas o serviço local real (local-equipamento-service/
// servico.mjs) rodando como processo filho de verdade, chamando o CNG real
// desta máquina (TPM se disponível — ver docs/meu-ponto/PROTOCOLO_COMPONENTE_WINDOWS.md
// §0, onde isso foi validado neste ambiente de desenvolvimento específico).
//
// Pulado automaticamente fora do Windows — nunca simula "seria assim no
// Windows", só declara a ausência de validação (pedido explícito da rodada
// de 2026-09-11: se TPM/Windows não estiver disponível, declarar como não
// validado em vez de fingir).
//
// A rota real POST /api/ponto-equipamento/vincular continua bloqueada
// (501) em src/index.js/src/routes/ponto-equipamento.js — nunca alterado
// por este teste. Para provar que o SERVIÇO LOCAL de verdade (HTTP +
// PowerShell + CNG) funciona de ponta a ponta, este teste aponta o serviço
// local para um servidor HTTP de teste minúsculo, criado só aqui, que
// implementa o MESMO contrato daquela rota chamando a mesma função de
// serviço (completarVinculoEquipamento) SEM o gate — é um dublê de teste
// para o protocolo HTTP, não uma alteração da rota real.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import {
  subirServidorDeTeste, pararServidorDeTeste, obterSupabaseDeTeste,
  criarUsuarioDeTeste, habilitarPontoDeTeste, definirPilotoAtivoDeTeste,
  criarEquipamentoDeTeste, limparVinculosCircularesDeTeste,
} from './_setup.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SERVICO_DIR = path.join(__dirname, '..', '..', '..', 'local-equipamento-service')
const EM_WINDOWS = process.platform === 'win32'

let usuario, admin, supabase
let dubleBackend, dubleBackendPorta
let processoServico, servicoPorta, tokenPareamento, configDir
const ORIGEM_LEGITIMA = 'http://localhost:5173'

before(async () => {
  await subirServidorDeTeste()
  supabase = obterSupabaseDeTeste()
  await definirPilotoAtivoDeTeste(true)
  admin = await criarUsuarioDeTeste({ role: 'admin' })
  usuario = await criarUsuarioDeTeste()
  await habilitarPontoDeTeste(usuario.id, true)

  if (!EM_WINDOWS) return

  // Dublê de teste do contrato HTTP de /api/ponto-equipamento/vincular —
  // chama a MESMA função de serviço que a rota real chamaria, sem o gate.
  // A rota real (src/routes/ponto-equipamento.js) nunca é tocada aqui.
  const { completarVinculoEquipamento } = await import('../../../src/lib/ponto/equipamentoService.js')
  dubleBackend = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/api/ponto-equipamento/vincular') {
      res.writeHead(404).end()
      return
    }
    let corpo = ''
    req.on('data', (c) => { corpo += c })
    req.on('end', async () => {
      try {
        const { codigo, chave_publica_jwk, chave_hardware_backed, prova_posse } = JSON.parse(corpo)
        const resultado = await completarVinculoEquipamento({
          codigo, chavePublicaJwk: chave_publica_jwk, chaveHardwareBacked: chave_hardware_backed, provaPosseBase64: prova_posse,
        })
        const texto = JSON.stringify({ equipamento_id: resultado.equipamentoId, desafio_hmac_secret: resultado.desafioHmacSecretBase64 })
        res.writeHead(201, { 'content-type': 'application/json' }).end(texto)
      } catch (err) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ erro: err.message }))
      }
    })
  })
  await new Promise((resolve) => dubleBackend.listen(0, '127.0.0.1', resolve))
  dubleBackendPorta = dubleBackend.address().port
})

after(async () => {
  if (processoServico) {
    processoServico.kill()
    await new Promise((resolve) => processoServico.once('exit', resolve)).catch(() => {})
  }
  if (dubleBackend) await new Promise((resolve) => dubleBackend.close(resolve))
  if (configDir) await fs.rm(configDir, { recursive: true, force: true }).catch(() => {})

  await limparVinculosCircularesDeTeste([usuario.id, admin.id])
  await supabase.from('ponto_marcacoes').delete().eq('usuario_id', usuario.id)
  await supabase.from('ponto_desafios').delete().eq('usuario_id', usuario.id)
  await supabase.from('ponto_equipamento_eventos').delete().eq('usuario_id', usuario.id)
  await supabase.from('ponto_equipamentos').delete().eq('usuario_id', usuario.id)
  await pararServidorDeTeste()
})

function iniciarServicoLocal() {
  return new Promise((resolve, reject) => {
    servicoPorta = 47000 + Math.floor(Math.random() * 900)
    configDir = path.join(os.tmpdir(), `meu-ponto-teste-servico-${crypto.randomBytes(4).toString('hex')}`)
    processoServico = spawn('node', ['servico.mjs'], {
      cwd: SERVICO_DIR,
      env: {
        ...process.env,
        PONTO_LOCAL_SERVICO_PORTA: String(servicoPorta),
        PONTO_LOCAL_SERVICO_CONFIG_DIR: configDir,
        PONTO_LOCAL_SERVICO_ORIGENS_PERMITIDAS: ORIGEM_LEGITIMA,
        PONTO_LOCAL_SERVICO_AUTO_CONFIRMAR: 'true', // só este teste automatizado — nunca em uso real (ver servico.mjs)
      },
      windowsHide: true,
    })
    let saida = ''
    const timeout = setTimeout(() => reject(new Error('timeout esperando o serviço local subir')), 15000)
    processoServico.stdout.on('data', (c) => {
      saida += c.toString()
      const m = saida.match(/token de pareamento.*?:\s*(\S+)/)
      if (m && saida.includes('escutando em')) {
        clearTimeout(timeout)
        tokenPareamento = m[1]
        resolve()
      }
    })
    processoServico.stderr.on('data', (c) => process.stderr.write(`[servico-local stderr] ${c}`))
    processoServico.on('error', reject)
  })
}

function chamarServicoLocal(caminho, { method = 'GET', body, origin = ORIGEM_LEGITIMA, semToken = false } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null
    const headers = { origin, host: `127.0.0.1:${servicoPorta}` }
    if (!semToken) headers['x-ponto-pairing-token'] = tokenPareamento
    if (payload) headers['content-type'] = 'application/json'
    const req = http.request({ host: '127.0.0.1', port: servicoPorta, method, path: caminho, headers }, (res) => {
      let dados = ''
      res.on('data', (c) => { dados += c })
      res.on('end', () => resolve({ status: res.statusCode, body: dados ? JSON.parse(dados) : null }))
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

test('componente Windows real: serviço local sobe e responde /status', { skip: !EM_WINDOWS && 'requer Windows — não validado neste ambiente' }, async () => {
  await iniciarServicoLocal()
  assert.ok(tokenPareamento, 'deveria ter capturado um token de pareamento real do stdout do serviço')
  const res = await chamarServicoLocal('/status', { semToken: true })
  assert.equal(res.status, 200)
  assert.equal(res.body.pareado, false)
})

test('componente Windows real: Origin não permitida é rejeitada pelo serviço local', { skip: !EM_WINDOWS && 'requer Windows' }, async () => {
  const res = await chamarServicoLocal('/status', { origin: 'https://site-malicioso.example', semToken: true })
  assert.equal(res.status, 403)
})

test('componente Windows real: token de pareamento errado é rejeitado em rota sensível', { skip: !EM_WINDOWS && 'requer Windows' }, async () => {
  const equipamentoId = await criarEquipamentoDeTeste({ usuarioId: usuario.id, cadastradoPor: admin.id })
  const res = await new Promise((resolve, reject) => {
    const payload = JSON.stringify({ codigoVinculo: 'irrelevante', crmApiBaseUrl: `http://127.0.0.1:${dubleBackendPorta}` })
    const req = http.request({
      host: '127.0.0.1', port: servicoPorta, method: 'POST', path: '/cadastrar',
      headers: { origin: ORIGEM_LEGITIMA, host: `127.0.0.1:${servicoPorta}`, 'content-type': 'application/json', 'x-ponto-pairing-token': 'token-errado-de-proposito' },
    }, (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d) })) })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
  assert.equal(res.status, 401)
})

test('componente Windows real: cadastro completo via CNG real (TPM se disponível) + registro de marcação assinada aceito pelo backend real', { skip: !EM_WINDOWS && 'requer Windows' }, async () => {
  const { iniciarVinculoEquipamento, emitirDesafio, registrarMarcacaoAssinada } = await import('../../../src/lib/ponto/equipamentoService.js')
  const { calcularHashConteudo } = await import('../../../src/lib/ponto/assinaturaEquipamento.js')

  const equipamentoId = await criarEquipamentoDeTeste({ usuarioId: usuario.id, cadastradoPor: admin.id })
  const vinculo = await iniciarVinculoEquipamento({ equipamentoId, criadoPor: admin.id })

  const cadastro = await chamarServicoLocal('/cadastrar', {
    method: 'POST',
    body: { codigoVinculo: vinculo.codigo, crmApiBaseUrl: `http://127.0.0.1:${dubleBackendPorta}` },
  })
  assert.equal(cadastro.status, 201, JSON.stringify(cadastro.body))
  assert.equal(cadastro.body.equipamentoId, equipamentoId)
  console.log(`[teste] chaveHardwareBacked real desta máquina: ${cadastro.body.chaveHardwareBacked}`)

  const { data: equipRow } = await supabase.from('ponto_equipamentos').select('modo, chave_publica_jwk, chave_hardware_backed').eq('id', equipamentoId).single()
  assert.equal(equipRow.modo, 'producao')
  assert.ok(equipRow.chave_publica_jwk)

  // Fluxo real de marcação: desafio emitido pelo backend real, assinado
  // pelo serviço local real (CNG), verificado e persistido pelo backend
  // real (mesma função ponto_registrar_marcacao_assinada testada no resto
  // da suíte) — nenhuma etapa aqui é simulada.
  const foto = await supabase.from('ponto_fotos').insert({
    usuario_id: usuario.id, storage_path: `teste/${crypto.randomUUID()}.jpg`, mime_type: 'image/jpeg', tamanho_bytes: 200, capturada_em: new Date().toISOString(),
  }).select('id').single()

  const hash = calcularHashConteudo(Buffer.from('foto-real-do-teste-windows'))
  const desafio = await emitirDesafio({ usuarioId: usuario.id, equipamentoId, tipo: 'entrada', hashConteudo: hash })
  const operacaoId = crypto.randomUUID()

  const assinatura = await chamarServicoLocal('/assinar-marcacao', {
    method: 'POST',
    body: {
      nonce: desafio.nonce, equipamentoId, usuarioId: usuario.id, operacaoId, tipo: 'entrada',
      hashConteudo: hash, expiraEm: desafio.expira_em, assinaturaServidor: desafio.assinatura_servidor,
    },
  })
  assert.equal(assinatura.status, 200, JSON.stringify(assinatura.body))
  assert.ok(assinatura.body.assinatura)

  const resultado = await registrarMarcacaoAssinada({
    usuarioId: usuario.id, equipamentoId, nonce: desafio.nonce, operacaoId, tipo: 'entrada', hashConteudo: hash,
    assinaturaBase64: assinatura.body.assinatura, fotoId: foto.data.id, ip: '127.0.0.1',
  })
  assert.equal(resultado.resultado, 'registrada_agora')

  const { data: marcacao } = await supabase.from('ponto_marcacoes').select('equipamento_id, origem').eq('id', resultado.marcacao_id).single()
  assert.equal(marcacao.equipamento_id, equipamentoId)
  assert.equal(marcacao.origem, 'normal')
})

test('componente Windows real: desafio com assinatura de servidor adulterada é recusado pelo serviço local (camada 5)', { skip: !EM_WINDOWS && 'requer Windows' }, async () => {
  const { emitirDesafio } = await import('../../../src/lib/ponto/equipamentoService.js')
  const { calcularHashConteudo } = await import('../../../src/lib/ponto/assinaturaEquipamento.js')

  // Reaproveita o equipamento já cadastrado no teste anterior (mesmo config
  // do serviço local).
  const { data: equip } = await supabase.from('ponto_equipamentos').select('id').eq('usuario_id', usuario.id).eq('modo', 'producao').single()
  const hash = calcularHashConteudo(Buffer.from('foto-adulterada'))
  const desafio = await emitirDesafio({ usuarioId: usuario.id, equipamentoId: equip.id, tipo: 'entrada', hashConteudo: hash })

  const res = await chamarServicoLocal('/assinar-marcacao', {
    method: 'POST',
    body: {
      nonce: desafio.nonce, equipamentoId: equip.id, usuarioId: usuario.id, operacaoId: crypto.randomUUID(), tipo: 'entrada',
      hashConteudo: hash, expiraEm: desafio.expira_em, assinaturaServidor: 'ff'.repeat(32), // HMAC forjado/errado
    },
  })
  assert.equal(res.status, 401)
})
