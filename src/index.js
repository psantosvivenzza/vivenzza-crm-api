import 'dotenv/config'
import express from 'express'
import { corsMiddleware } from './middleware/cors.js'
import { auth } from './middleware/auth.js'

import leadsRouter from './routes/leads.js'
import contatosRouter from './routes/contatos.js'
import whatsappRouter from './routes/whatsapp.js'
import produtosRouter from './routes/produtos.js'
import pedidosRouter from './routes/pedidos.js'
import tarefasRouter from './routes/tarefas.js'
import dashboardRouter from './routes/dashboard.js'

const app = express()
const PORT = process.env.PORT || 3001

app.use(corsMiddleware)
app.use(express.json())

// Webhook do WhatsApp sem autenticação (chamado pela Evolution API)
app.use('/api/whatsapp/webhook', whatsappRouter)

// Todas as outras rotas exigem autenticação
app.use('/api/leads', auth, leadsRouter)
app.use('/api/contatos', auth, contatosRouter)
app.use('/api/whatsapp', auth, whatsappRouter)
app.use('/api/produtos', auth, produtosRouter)
app.use('/api/pedidos', auth, pedidosRouter)
app.use('/api/tarefas', auth, tarefasRouter)
app.use('/api/dashboard', auth, dashboardRouter)

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// 404
app.use((req, res) => {
  res.status(404).json({ erro: `Rota não encontrada: ${req.method} ${req.path}` })
})

// Handler global de erros
app.use((err, req, res, next) => {
  console.error('[erro]', err.message)
  res.status(500).json({ erro: err.message || 'Erro interno do servidor' })
})

app.listen(PORT, () => {
  console.log(`Vivenzza CRM API rodando na porta ${PORT}`)
})
