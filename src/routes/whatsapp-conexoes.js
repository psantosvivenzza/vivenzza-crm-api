import { Router } from 'express'
import { createFzapConnectionsService, FzapConnectionError } from '../lib/fzapConnections.js'

const SUPER_ADMIN_EMAIL = 'psantos@vivenzzaprofessional.com.br'

export function createFzapConnectionsRouter({ service = createFzapConnectionsService() } = {}) {
  const router = Router()
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, max-age=0')
    res.set('Pragma', 'no-cache')
    res.set('Expires', '0')
    res.vary('Authorization')
    if (req.user?.email !== SUPER_ADMIN_EMAIL || req.user?.role !== 'admin') {
      return res.status(403).json({ erro: 'Acesso restrito.' })
    }
    next()
  })
  const send = (operation) => async (req, res) => {
    try {
      res.json(await operation(req))
    } catch (error) {
      if (error instanceof FzapConnectionError) return res.status(error.status).json({ erro: error.message })
      res.status(503).json({ erro: 'Não foi possível consultar a FZAP. Tente novamente em instantes.' })
    }
  }
  router.get('/', send(() => service.list()))
  router.post('/:id/conectar', send((req) => service.connect(req.params.id)))
  router.post('/:id/concluir-migracao', send((req) => service.complete(req.params.id)))
  router.get('/:id/qr', send((req) => service.qr(req.params.id)))
  return router
}

export default createFzapConnectionsRouter()
