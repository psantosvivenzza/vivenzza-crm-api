// Serviço local de equipamento — protótipo de desenvolvimento, NÃO
// instalado em nenhuma máquina real, sem autostart, sem serviço
// persistente. Rodado manualmente (`node servico.mjs`) e encerrado
// manualmente ao fim de cada sessão de teste. Ver
// docs/meu-ponto/PROTOCOLO_COMPONENTE_WINDOWS.md.
//
// Escuta SÓ em 127.0.0.1 (nunca 0.0.0.0). Camadas de defesa contra um site
// malicioso tentando usar este serviço como "assinador" (nenhuma sozinha é
// suficiente — ver docs/meu-ponto/PROPOSTA_COMPONENTE_EQUIPAMENTO.md §4):
//   1. Loopback-only.
//   2. Allowlist exata de Origin.
//   3. Allowlist exata de Host (defesa adicional contra DNS rebinding e
//      contra clientes fora do navegador que forjam o header Origin).
//   4. Token de pareamento local (gerado a cada início do processo, exibido
//      só no console, exigido em toda rota sensível).
//   5. Verificação da assinatura do BACKEND sobre o desafio (HMAC) antes de
//      sequer considerar assinar — a defesa que não depende de nada do
//      navegador respeitar.
//   6. Confirmação visível ao usuário (caixa de diálogo nativa) antes de
//      assinar de fato.
//
// Nunca expõe a chave privada do equipamento (fica inteiramente dentro do
// CNG — só chamamos powershell para operações específicas, nunca lemos
// material de chave privada em nenhum momento neste processo). Nunca
// recebe nem manuseia JWT/senha do CRM — a única credencial que este
// serviço usa para se cadastrar é o código de vínculo de uso único.
import http from 'node:http'
import crypto from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const PORTA = Number(process.env.PONTO_LOCAL_SERVICO_PORTA || 47365)
const CONFIG_DIR = process.env.PONTO_LOCAL_SERVICO_CONFIG_DIR || path.join(os.tmpdir(), 'meu-ponto-equipamento-local')
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json')
const ORIGENS_PERMITIDAS = (process.env.PONTO_LOCAL_SERVICO_ORIGENS_PERMITIDAS || 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',').map((s) => s.trim()).filter(Boolean)
const AUTO_CONFIRMAR = process.env.PONTO_LOCAL_SERVICO_AUTO_CONFIRMAR === 'true' // SÓ testes automatizados — nunca em uso real.

const PAIRING_TOKEN = crypto.randomBytes(24).toString('base64url')

function importarAssinaturaEquipamento() {
  // Import dinâmico (não top-level) só para poder logar um erro claro se
  // este serviço for movido pra fora do worktree sem essa dependência —
  // hoje ele roda de dentro do repo, reaproveitando o mesmo módulo de
  // primitivas que o backend usa (mesmo formato canônico dos dois lados,
  // sem duplicar lógica de assinatura).
  // pathToFileURL é obrigatório aqui — no Windows, import() com uma string
  // de caminho crua ("C:\...") falha (o loader ESM só aceita URLs
  // file:/data:/node:), erro real encontrado testando isto de verdade
  // nesta máquina, não hipotético.
  return import(pathToFileURL(path.join(__dirname, '..', 'src', 'lib', 'ponto', 'assinaturaEquipamento.js')).href)
}

async function rodarCng(args) {
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(__dirname, 'cng-operacoes.ps1'), ...args,
  ], { encoding: 'utf8', windowsHide: true })
  const linhas = stdout.trim().split('\n')
  const resultado = JSON.parse(linhas[linhas.length - 1])
  if (!resultado.ok) throw new Error(`cng_falhou:${resultado.erro}`)
  return resultado
}

function normalizarHardwareBacked(valor) {
  return String(valor).toLowerCase() === 'true'
}

async function confirmarComUsuario(mensagem) {
  if (AUTO_CONFIRMAR) {
    console.warn('[servico-local] AUTO-CONFIRMAR ATIVO (só testes automatizados) — confirmação real da caixa de diálogo foi pulada.')
    return true
  }
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(__dirname, 'confirmar.ps1'), '-Mensagem', mensagem,
  ], { encoding: 'utf8', windowsHide: true })
  return stdout.trim() === 'sim'
}

async function lerConfig() {
  try {
    const conteudo = await fs.readFile(CONFIG_PATH, 'utf8')
    return JSON.parse(conteudo)
  } catch {
    return null
  }
}

async function escreverConfig(config) {
  await fs.mkdir(CONFIG_DIR, { recursive: true })
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8')
}

function enviarJson(res, status, corpo) {
  const texto = JSON.stringify(corpo)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(texto) })
  res.end(texto)
}

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let dados = ''
    req.on('data', (c) => { dados += c; if (dados.length > 1_000_000) req.destroy() })
    req.on('end', () => {
      if (!dados) return resolve({})
      try { resolve(JSON.parse(dados)) } catch { reject(new Error('json_invalido')) }
    })
    req.on('error', reject)
  })
}

// Camadas 2-4 de defesa — aplicadas a toda rota, exceto pareamento (token)
// em /status (uma checagem de disponibilidade não deveria exigir já ter
// sido pareado; Origin/Host continuam obrigatórios mesmo ali).
function validarOrigemEHost(req, res) {
  const origin = req.headers.origin
  if (!origin || !ORIGENS_PERMITIDAS.includes(origin)) {
    enviarJson(res, 403, { erro: 'Origem não autorizada.' })
    return false
  }
  const hostEsperado = `127.0.0.1:${PORTA}`
  if (req.headers.host !== hostEsperado) {
    enviarJson(res, 403, { erro: 'Host inesperado.' })
    return false
  }
  res.setHeader('access-control-allow-origin', origin)
  res.setHeader('vary', 'Origin')
  return true
}

function validarPareamento(req, res) {
  const token = req.headers['x-ponto-pairing-token']
  if (token !== PAIRING_TOKEN) {
    enviarJson(res, 401, { erro: 'Token de pareamento inválido.' })
    return false
  }
  return true
}

async function tratarCadastrar(req, res) {
  const corpo = await lerCorpo(req)
  const { codigoVinculo, crmApiBaseUrl } = corpo
  if (!codigoVinculo || !crmApiBaseUrl) {
    return enviarJson(res, 400, { erro: 'codigoVinculo e crmApiBaseUrl são obrigatórios.' })
  }

  const nomeChave = `MeuPonto_${crypto.randomUUID()}`
  const criada = await rodarCng(['-Acao', 'criar-chave', '-NomeChave', nomeChave])
  const hardwareBacked = normalizarHardwareBacked(criada.hardwareBacked)

  const payloadProva = Buffer.from(`meu-ponto-prova-posse|${codigoVinculo}`, 'utf8').toString('base64')
  const assinadaProva = await rodarCng(['-Acao', 'assinar', '-NomeChave', nomeChave, '-HardwareBacked', String(hardwareBacked), '-DadosBase64', payloadProva])

  let respostaBackend
  try {
    respostaBackend = await fetch(new URL('/api/ponto-equipamento/vincular', crmApiBaseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        codigo: codigoVinculo,
        chave_publica_jwk: criada.chavePublicaJwk,
        chave_hardware_backed: hardwareBacked,
        prova_posse: assinadaProva.assinaturaBase64,
      }),
    })
  } catch (err) {
    await rodarCng(['-Acao', 'remover-chave', '-NomeChave', nomeChave, '-HardwareBacked', String(hardwareBacked)]).catch(() => {})
    return enviarJson(res, 502, { erro: `Não foi possível contatar o backend: ${err.message}` })
  }

  const corpoResposta = await respostaBackend.json().catch(() => ({}))
  if (!respostaBackend.ok) {
    // Cadastro não completou no backend — remove a chave local órfã, nunca
    // deixa uma chave "pendurada" sem equipamento registrado de verdade.
    await rodarCng(['-Acao', 'remover-chave', '-NomeChave', nomeChave, '-HardwareBacked', String(hardwareBacked)]).catch(() => {})
    return enviarJson(res, respostaBackend.status, corpoResposta)
  }

  await escreverConfig({
    equipamentoId: corpoResposta.equipamento_id,
    desafioHmacSecretBase64: corpoResposta.desafio_hmac_secret,
    chaveNome: nomeChave,
    chaveHardwareBacked: hardwareBacked,
    crmApiBaseUrl,
  })

  enviarJson(res, 201, { equipamentoId: corpoResposta.equipamento_id, chaveHardwareBacked: hardwareBacked })
}

async function tratarAssinarMarcacao(req, res) {
  const corpo = await lerCorpo(req)
  const { nonce, equipamentoId, usuarioId, operacaoId, tipo, hashConteudo, expiraEm, assinaturaServidor } = corpo
  if (!nonce || !equipamentoId || !usuarioId || !operacaoId || !tipo || !hashConteudo || !expiraEm || !assinaturaServidor) {
    return enviarJson(res, 400, { erro: 'Campos obrigatórios ausentes.' })
  }

  const config = await lerConfig()
  if (!config || config.equipamentoId !== equipamentoId) {
    return enviarJson(res, 409, { erro: 'Este serviço local não está cadastrado para o equipamento informado.' })
  }

  const { verificarAssinaturaDesafio, payloadAssinaturaEquipamento } = await importarAssinaturaEquipamento()

  // Camada 5 — a defesa que não depende do navegador respeitar nada: só
  // consideramos assinar um desafio cuja autenticidade o próprio backend
  // provou com um segredo que um site malicioso nunca teria.
  const desafioAutentico = verificarAssinaturaDesafio({
    segredoHmacBase64: config.desafioHmacSecretBase64,
    nonce, equipamentoId, usuarioId, tipo, hashConteudo, expiraEmISO: expiraEm,
    assinaturaHex: assinaturaServidor,
  })
  if (!desafioAutentico) {
    return enviarJson(res, 401, { erro: 'Desafio não confere com a assinatura do backend — recusado.' })
  }
  if (new Date(expiraEm).getTime() < Date.now()) {
    return enviarJson(res, 410, { erro: 'Desafio expirado.' })
  }

  const confirmado = await confirmarComUsuario(
    `Uma marcação de ponto (${tipo}) está pedindo a assinatura deste equipamento.\n\nConfirmar?`
  )
  if (!confirmado) {
    return enviarJson(res, 403, { erro: 'Assinatura recusada pelo usuário.' })
  }

  const payload = payloadAssinaturaEquipamento({ nonce, equipamentoId, usuarioId, operacaoId, tipo, hashConteudo })
  const assinado = await rodarCng([
    '-Acao', 'assinar', '-NomeChave', config.chaveNome, '-HardwareBacked', String(config.chaveHardwareBacked),
    '-DadosBase64', payload.toString('base64'),
  ])

  enviarJson(res, 200, { assinatura: assinado.assinaturaBase64 })
}

const servidor = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/status') {
      if (!validarOrigemEHost(req, res)) return
      const config = await lerConfig()
      return enviarJson(res, 200, { ok: true, pareado: Boolean(config) })
    }
    if (req.method === 'POST' && req.url === '/cadastrar') {
      if (!validarOrigemEHost(req, res)) return
      if (!validarPareamento(req, res)) return
      return await tratarCadastrar(req, res)
    }
    if (req.method === 'POST' && req.url === '/assinar-marcacao') {
      if (!validarOrigemEHost(req, res)) return
      if (!validarPareamento(req, res)) return
      return await tratarAssinarMarcacao(req, res)
    }
    // Sem endpoint genérico de "assine qualquer coisa" — de propósito (ver
    // proposta §4): só existem as duas rotas de negócio acima, cada uma
    // com um formato de payload fixo e verificação própria.
    enviarJson(res, 404, { erro: 'Rota não encontrada.' })
  } catch (err) {
    enviarJson(res, 500, { erro: `Falha interna: ${err.message}` })
  }
})

servidor.listen(PORTA, '127.0.0.1', () => {
  console.log(`[servico-local] escutando em http://127.0.0.1:${PORTA} (loopback apenas)`)
  console.log(`[servico-local] token de pareamento (cole no CRM uma única vez): ${PAIRING_TOKEN}`)
  console.log(`[servico-local] config em: ${CONFIG_PATH}`)
  console.log('[servico-local] processo TEMPORÁRIO — Ctrl+C encerra; não há autostart nem serviço persistente.')
})

export { PAIRING_TOKEN, PORTA, CONFIG_PATH }
