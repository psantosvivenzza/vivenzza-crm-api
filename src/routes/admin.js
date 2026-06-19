import { Router } from 'express'
import { adminOnly } from '../middleware/auth.js'
import { runBackup } from '../jobs/backup.js'

const router = Router()

// GET /api/admin/backup — executa backup manualmente
// Requer autenticação admin (JWT ou API_SECRET_KEY)
router.get('/backup', adminOnly, async (req, res) => {
  try {
    const resultado = await runBackup()
    res.json({ sucesso: true, ...resultado })
  } catch (err) {
    console.error('[backup] Erro na rota:', err.message)
    res.status(500).json({ erro: err.message })
  }
})

export default router
