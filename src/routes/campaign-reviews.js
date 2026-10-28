import { Router, json } from 'express'
import { auth, adminOnly } from '../middleware/auth.js'
import { CampaignApprovalError } from '../lib/campaignApproval.js'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MANUAL_KEYS = 'accountId|action|after|before|campaignId|objective|observationSummary|platform|reason'
// Quebra de linha/tab permitidas em texto livre; demais caracteres de controle não.
const hasControl = (v) => typeof v === 'string' ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)
  : v && typeof v === 'object' ? Object.values(v).some(hasControl) : false
// Modos: 'synthetic' (preview com fixture e adapter sintético), 'review' (decisão
// persistida, sem execução) e, sem workflow, 503 fail-closed.
export function createCampaignReviewRouter({ workflow = null, simulation = null, intake = null } = {}) {
  const router = Router()
  const mode = !workflow ? 'disabled' : simulation ? 'synthetic' : 'review'
  // Execução só existe na composição sintética com adapter declarado.
  const canExecute = mode === 'synthetic' && workflow.capabilities?.execute === true && typeof workflow.execute === 'function'
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next() })
  router.use(auth, adminOnly, json({ limit: '24kb' }))
  router.use((req, res, next) => {
    // Static integration keys must never represent a named human approval.
    if (req.authMethod !== 'jwt' || typeof req.user.id !== 'string' || !req.user.id.trim() || req.user.id === 'api-user') return res.status(403).json({ code: 'SESSAO_HUMANA_OBRIGATORIA' })
    if (!workflow) return res.status(503).json({ code: 'REVISAO_NAO_CONFIGURADA', erro: 'Revisão de propostas ainda não configurada.' })
    next()
  })
  const handle = (fn) => async (req, res) => {
    try { await fn(req, res) } catch (error) {
      const code = error instanceof CampaignApprovalError ? error.code : 'REVISAO_INDISPONIVEL'
      const status = code === 'PROPOSTA_NAO_ENCONTRADA' ? 404 : code === 'REVISAO_INDISPONIVEL' ? 503 : 409
      res.status(status).json({ code, erro: 'A operação não foi confirmada. Atualize o histórico antes de tentar outra ação.' })
    }
  }
  router.get('/', handle(async (req, res) => {
    const proposals = await workflow.list(req.user)
    res.json({ mode, capabilities: { execute: canExecute, intake: !!intake }, consultadoEm: new Date().toISOString(), proposals })
  }))
  // Only the isolated preview composition injects a server-owned fixture creator.
  router.post('/simulacoes', handle(async (req, res) => {
    if (!simulation) return res.status(403).json({ code: 'SIMULACAO_INDISPONIVEL' })
    if (!req.body || Object.keys(req.body).length !== 1 || !['meta', 'google'].includes(req.body.platform)) return res.status(400).json({ code: 'SIMULACAO_INVALIDA' })
    res.status(201).json(await simulation(req.body.platform, req.user))
  }))
  // Registro manual: origem/fonte/observação/validade são do servidor; o corpo não pode declará-las.
  router.post('/propostas', handle(async (req, res) => {
    if (!intake) return res.status(403).json({ code: 'REGISTRO_MANUAL_INDISPONIVEL' })
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).sort().join('|') !== MANUAL_KEYS
      || typeof req.body.observationSummary !== 'string' || !req.body.observationSummary.trim() || req.body.observationSummary.length > 2000
      || hasControl(req.body)) return res.status(400).json({ code: 'PEDIDO_INVALIDO' })
    res.status(201).json(await intake(req.body, req.user))
  }))
  router.param('id', (req, res, next, id) => uuid.test(id) ? next() : res.status(400).json({ code: 'ID_INVALIDO' }))
  router.get('/:id', handle(async (req, res) => res.json(await workflow.get(req.params.id, req.user))))
  for (const action of ['aprovar', 'rejeitar', 'executar']) router.post(`/:id/${action}`, handle(async (req, res) => {
    // Recusa antes de tocar workflow/store: estado, revisão e histórico ficam intactos.
    if (action === 'executar' && !canExecute) return res.status(409).json({ code: 'EXECUCAO_DESABILITADA_MODO_REVISAO', erro: 'Modo somente revisão: nenhuma alteração é aplicada em anúncios.' })
    const expected = action === 'rejeitar' ? ['hash', 'reason'] : ['hash']
    if (!req.body || Object.keys(req.body).sort().join('|') !== expected.sort().join('|') || typeof req.body.hash !== 'string' || !/^[a-f0-9]{64}$/.test(req.body.hash)
      || (action === 'rejeitar' && (typeof req.body.reason !== 'string' || !req.body.reason.trim() || req.body.reason.length > 1000 || /[\u0000-\u001f\u007f]/.test(req.body.reason)))) return res.status(400).json({ code: 'PEDIDO_INVALIDO' })
    const method = { aprovar: 'approve', rejeitar: 'reject', executar: 'execute' }[action]
    const args = [req.params.id, req.body.hash, ...(action === 'rejeitar' ? [req.body.reason.trim()] : []), req.user]
    res.json(await workflow[method](...args))
  }))
  router.use((error, _req, res, _next) => {
    const parser = ['entity.too.large', 'entity.parse.failed'].includes(error.type)
    res.status(parser ? error.type === 'entity.too.large' ? 413 : 400 : 503).json({ code: parser ? 'PEDIDO_INVALIDO' : 'REVISAO_INDISPONIVEL' })
  })
  return router
}
