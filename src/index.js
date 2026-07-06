import 'dotenv/config'
import express from 'express'
import rateLimit from 'express-rate-limit'
import { corsMiddleware } from './middleware/cors.js'
import { auth, adminOnly } from './middleware/auth.js'

import authRouter from './routes/auth.js'
import usuariosRouter from './routes/usuarios.js'
import leadsRouter from './routes/leads.js'
import contatosRouter from './routes/contatos.js'
import whatsappRouter from './routes/whatsapp.js'
import handleWebhook from './routes/webhook-handler.js'
import produtosRouter from './routes/produtos.js'
import pedidosRouter from './routes/pedidos.js'
import tarefasRouter from './routes/tarefas.js'
import dashboardRouter from './routes/dashboard.js'
import estoqueRouter from './routes/estoque.js'
import financeiroRouter from './routes/financeiro.js'
import nfeRouter from './routes/nfe.js'
import relatoriosRouter from './routes/relatorios.js'
import adminRouter from './routes/admin.js'
import sdrRouter from './routes/sdr.js'
import campanhasRouter from './routes/campanhas.js'
import googleAdsRouter from './routes/google-ads.js'
import ligacoesRouter from './routes/ligacoes.js'
import automacoesRouter from './routes/automacoes.js'
import reativacaoRouter from './routes/reativacao.js'
import publicLeadsRouter from './routes/public-leads.js'
import cron from 'node-cron'
import { runBackup } from './jobs/backup.js'
import { runMetaReport } from './jobs/meta-report.js'
import { runHandoffAlerta } from './jobs/handoff-alerta.js'
import { runEvolutionHealthCheck } from './jobs/evolution-health.js'
import evolutionHealthRouter from './routes/evolution-health.js'

const app = express()
const PORT = process.env.PORT || 3001

app.use(corsMiddleware)
app.use(express.json({ limit: '50mb' }))

// Loga requisições que passam de 2s — sem isso, uma lentidão intermitente só aparece
// como média/p99 agregado no painel do Railway, sem dizer qual rota é a culpada.
app.use((req, res, next) => {
  const inicio = Date.now()
  res.on('finish', () => {
    const duracao = Date.now() - inicio
    if (duracao > 2000) {
      console.warn(`[lento] ${req.method} ${req.path} levou ${duracao}ms`)
    }
  })
  next()
})

// Webhook do WhatsApp — sem autenticação, registrado como rota direta
app.post('/api/whatsapp/webhook', handleWebhook)

// Rate limit na rota pública: máx 10 submissões por IP a cada 15 min
const publicLeadsLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { erro: 'Muitas tentativas. Aguarde alguns minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
})

// Leads de landing pages — sem autenticação
app.use('/api/public/leads', publicLeadsLimit, publicLeadsRouter)

// SDR digital (Lara) — sem autenticação, a Evolution API chama direto
app.use('/api/sdr', sdrRouter)

// Login — sem autenticação
app.use('/api/auth', authRouter)

// Todas as outras rotas exigem autenticação
app.use('/api/usuarios', auth, usuariosRouter)
app.use('/api/leads', auth, leadsRouter)
app.use('/api/contatos', auth, contatosRouter)
app.use('/api/whatsapp', auth, whatsappRouter)
app.use('/api/produtos', auth, produtosRouter)
app.use('/api/pedidos', auth, pedidosRouter)
app.use('/api/tarefas', auth, tarefasRouter)
app.use('/api/dashboard', auth, dashboardRouter)
app.use('/api/estoque', auth, estoqueRouter)
app.use('/api/financeiro', auth, financeiroRouter)
app.use('/api/nfe', auth, nfeRouter)
app.use('/api/relatorios', auth, relatoriosRouter)
app.use('/api/admin', auth, adminRouter)
app.use('/api/admin/campanhas', auth, adminOnly, campanhasRouter)
app.use('/api/admin/google-ads', auth, adminOnly, googleAdsRouter)
app.use('/api/admin/evolution-health', auth, adminOnly, evolutionHealthRouter)
app.use('/api/ligacoes', auth, ligacoesRouter)
app.use('/api/automacoes', auth, automacoesRouter)
app.use('/api/reativacao', auth, adminOnly, reativacaoRouter)

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// Disparo manual do relatório Meta Ads (antes do 404 para ser alcançada)
app.post('/api/admin/meta-report', async (req, res) => {
  const { authorization } = req.headers
  if (authorization !== `Bearer ${process.env.API_SECRET_KEY}`) {
    return res.status(401).json({ erro: 'Não autorizado' })
  }
  try {
    const daysAgo = Number(req.query.daysAgo) || 1
    const resultado = await runMetaReport({ daysAgo })
    res.json({ ok: true, ...resultado })
  } catch (err) {
    const detail = err.response?.data ?? err.message
    console.error('[meta-report manual] Erro:', JSON.stringify(detail))
    res.status(500).json({ erro: err.message, detail })
  }
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

// Backup automático diário às 02:00 BRT (05:00 UTC)
cron.schedule('0 5 * * *', async () => {
  try {
    await runBackup()
  } catch (err) {
    console.error('[cron backup] Erro:', err.message)
  }
})

// Relatório Meta Ads diário às 07:00 BRT (10:00 UTC)
cron.schedule('0 10 * * *', async () => {
  try {
    await runMetaReport()
  } catch (err) {
    console.error('[cron meta-report] Erro:', err.message)
  }
})

// Alerta de handoff abandonado — a cada hora, verifica leads com atendimento_humano=true
// sem mensagem de saída há 48h (alerta para vendedora) ou 72h (escala para Peterson)
cron.schedule('0 * * * *', async () => {
  try {
    await runHandoffAlerta()
  } catch (err) {
    console.error('[cron handoff-alerta] Erro:', err.message)
  }
})

// Monitoramento de saúde da Evolution API — a cada 15 min
cron.schedule('*/15 * * * *', async () => {
  try {
    await runEvolutionHealthCheck()
  } catch (err) {
    console.error('[cron evolution-health] Erro:', err.message)
  }
})
