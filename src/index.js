import 'dotenv/config'
import path from 'path'
import { fileURLToPath } from 'url'
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
import { webhookAuth } from './middleware/webhookAuth.js'
import produtosRouter from './routes/produtos.js'
import pedidosRouter from './routes/pedidos.js'
import tarefasRouter from './routes/tarefas.js'
import dashboardRouter from './routes/dashboard.js'
import estoqueRouter from './routes/estoque.js'
import notasEntradaRouter from './routes/notas-entrada.js'
import financeiroRouter from './routes/financeiro.js'
import nfeRouter from './routes/nfe.js'
import nfeEntradasRouter from './routes/nfe-entradas.js'
import fornecedoresRouter from './routes/fornecedores.js'
import comissoesRouter from './routes/comissoes.js'
import cfopsRouter from './routes/cfops.js'
import relatoriosRouter from './routes/relatorios.js'
import adminRouter from './routes/admin.js'
import sdrRouter from './routes/sdr.js'
import campanhasRouter from './routes/campanhas.js'
import googleAdsRouter from './routes/google-ads.js'
import ligacoesRouter from './routes/ligacoes.js'
import automacoesRouter from './routes/automacoes.js'
import reativacaoRouter from './routes/reativacao.js'
import erpRouter from './routes/erp.js'
import clientesErpRouter from './routes/clientes-erp.js'
import publicLeadsRouter from './routes/public-leads.js'
import publicAlertRouter from './routes/public-alert.js'
import nuvemshopOAuthRouter from './routes/nuvemshop-oauth.js'
import blogRouter from './routes/blog.js'
import avaliacoesRouter from './routes/avaliacoes.js'
import avaliacoesAdminRouter from './routes/avaliacoes-admin.js'
import googleReviewsRouter from './routes/google-reviews.js'
import agingRouter from './routes/aging.js'
import cobrancasRouter from './routes/cobrancas.js'
import notificationsRouter from './routes/notifications.js'
import cron from 'node-cron'
import { runBackup } from './jobs/backup.js'
import { runMetaReport } from './jobs/meta-report.js'
import { runMetaBudgetGuard } from './jobs/meta-budget-guard.js'
import { runHandoffAlerta } from './jobs/handoff-alerta.js'
import { runEvolutionHealthCheck } from './jobs/evolution-health.js'
import { executarReguaCobranca } from './jobs/cobranca-whatsapp.js'
import { runMonitoramentoResposta } from './jobs/monitoramento-resposta.js'
import { reconciliarNfePendentes } from './jobs/reconciliar-nfe.js'
import { runSincronizacaoDistribuicaoDFe } from './jobs/nfe-distribuicao-sync.js'
import { runPaymentReconciliationSweep } from './jobs/payment-reconciliation-sweep.js'
import { runPromiseExpirySweep } from './jobs/promise-expiry-sweep.js'
import evolutionHealthRouter from './routes/evolution-health.js'
// FASE B.1 (homologação, shadow mínimo) — SOMENTE observação read-only de
// Recovery Score/Priority Score/Next Best Action, nunca despacha nada.
// nba_shadow_mode/score_shadow_mode nascem OFF nesta migration; ligar é uma
// ação humana separada e posterior. Ver docs/cobranca-ai/DEPLOY_PLAN_MINIMAL.md.
import { runCollectionShadow } from './jobs/collection-shadow.js'
import { runNbaShadowRetentionCleanup } from './jobs/nba-shadow-retention-cleanup.js'
import collectionShadowStatusRouter from './routes/collection-shadow-status.js'
// FASE B.2 (homologação) — API de leitura para a visualização do ERP (Aging
// Report + Cobranças → Inteligência/Próximas Ações). Só GET, nunca recalcula
// score/executa NBA.
import collectionShadowReportsRouter from './routes/collection-shadow-reports.js'
import collectionWhatsappMonitorRouter from './routes/collection-whatsapp-monitor.js'
// 2026-08-27 — fila operacional "Revisão de Contatos": clientes com telefone
// confirmado PERMANENT_RECIPIENT pelo provider, pra o Financeiro corrigir o
// cadastro no NetVision. Só GET, nada persistido além do que já existe
// (collection_do_not_contact/collection_dispatch_attempts).
import collectionContactReviewRouter from './routes/collection-contact-review.js'
// IA WhatsApp MVP (2026-08-12) — só GET, mostra sugestões de IA (shadow,
// nenhuma enviada de verdade) pro operador revisar. Ver src/lib/collection/ai/.
import aiSuggestionsRouter from './routes/ai-suggestions.js'
// Worker local Ollama (2026-08-12) — auth própria (aiWorkerAuth), nunca JWT
// de usuário comum. Ver src/lib/collection/ai/jobQueue.js.
import aiWorkerRouter from './routes/ai-worker.js'
import { aiWorkerAuth } from './middleware/aiWorkerAuth.js'

const app = express()
const PORT = process.env.PORT || 3001
const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Railway fica atrás de 1 hop de proxy — sem isso, req.ip vê sempre o IP
// interno do proxy, e todo rate-limit por IP (leads, alerta, avaliações)
// acaba contando "todo mundo" como o mesmo IP.
app.set('trust proxy', 1)

app.use(corsMiddleware)
app.use(express.json({ limit: '50mb' }))

// Widgets estáticos (avaliações da loja, Google Reviews) pro tema Nuvemshop
// carregar via <script src=".../widgets/xxx.js">
app.use('/widgets', express.static(path.join(__dirname, '..', 'public', 'widgets'), { maxAge: '1h' }))

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

// Webhook do WhatsApp — autenticado via x-webhook-token (S1-2)
app.post('/api/whatsapp/webhook', webhookAuth, handleWebhook)

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

// Alertas de rotinas automatizadas (ex: monitoramento de campanhas) — autenticado
// via header x-alert-token (ALERT_WEBHOOK_TOKEN), não via API_SECRET_KEY. Destino
// do WhatsApp é fixo no próprio route handler, não vem do corpo da requisição.
const publicAlertLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  message: { erro: 'Muitas tentativas. Aguarde.' },
  standardHeaders: true,
  legacyHeaders: false,
})
app.use('/api/public/alerta-whatsapp', publicAlertLimit, publicAlertRouter)

// SDR digital (Lara) — sem autenticação, a Evolution API chama direto
app.use('/api/sdr', sdrRouter)

// Callback OAuth Nuvemshop — sem autenticação, é a própria Nuvemshop quem chama
app.use('/api/nuvemshop', nuvemshopOAuthRouter)

// Avaliações da loja — formulário público (rate limit próprio na rota POST)
// e listagem pública das aprovadas
app.use('/api/avaliacoes', avaliacoesRouter)

// Avaliações do Google — nota geral + 5 mais recentes, cache diário
app.use('/api/google-reviews', googleReviewsRouter)

// Login — sem autenticação
app.use('/api/auth', authRouter)

// Todas as outras rotas exigem autenticação
app.use('/api/usuarios', auth, usuariosRouter)
app.use('/api/leads', auth, leadsRouter)
app.use('/api/contatos', auth, contatosRouter)
app.use('/api/whatsapp', auth, whatsappRouter)
app.use('/api/produtos', auth, produtosRouter)
app.use('/api/pedidos', auth, pedidosRouter)
app.use('/api/clientes-erp', auth, clientesErpRouter)
app.use('/api/tarefas', auth, tarefasRouter)
app.use('/api/dashboard', auth, dashboardRouter)
app.use('/api/estoque', auth, estoqueRouter)
app.use('/api/notas-entrada', auth, notasEntradaRouter)
// Precisa vir ANTES de '/api/financeiro' — senão financeiroRouter (que tem
// GET /:id) intercepta "/aging" como se fosse um id de conta, e a Postgres
// rejeita "aging" como uuid inválido antes da requisição chegar no agingRouter.
app.use('/api/financeiro/aging', auth, adminOnly, agingRouter)
app.use('/api/financeiro', auth, financeiroRouter)
app.use('/api/nfe', auth, nfeRouter)
app.use('/api/nfe-entradas', auth, nfeEntradasRouter)
app.use('/api/fornecedores', auth, fornecedoresRouter)
app.use('/api/comissoes', auth, comissoesRouter)
app.use('/api/cfops', auth, cfopsRouter)
app.use('/api/relatorios', auth, relatoriosRouter)
app.use('/api/admin', auth, adminRouter)
app.use('/api/admin/campanhas', auth, adminOnly, campanhasRouter)
app.use('/api/admin/google-ads', auth, adminOnly, googleAdsRouter)
app.use('/api/admin/evolution-health', auth, adminOnly, evolutionHealthRouter)
app.use('/api/ligacoes', auth, ligacoesRouter)
app.use('/api/automacoes', auth, automacoesRouter)
app.use('/api/reativacao', auth, adminOnly, reativacaoRouter)
app.use('/api/admin/erp', auth, adminOnly, erpRouter)
app.use('/api/blog', auth, blogRouter)
app.use('/api/admin/avaliacoes', auth, avaliacoesAdminRouter)
app.use('/api/cobrancas', auth, adminOnly, cobrancasRouter)
app.use('/api/notifications', auth, notificationsRouter)
// FASE B.1 (homologação) — shadow mínimo, só leitura + PATCH de 3 flags
// próprias (nba_shadow_mode/score_shadow_mode/shadow_max_customers). Nenhuma
// outra rota do motor v2 é montada nesta fase.
app.use('/api/collection-shadow-status', auth, adminOnly, collectionShadowStatusRouter)
app.use('/api/collection-shadow', auth, adminOnly, collectionShadowReportsRouter)
app.use('/api/ai-suggestions', auth, adminOnly, aiSuggestionsRouter)
app.use('/api/ai-worker', aiWorkerAuth, aiWorkerRouter)

// FASE C.1 (homologação) — painel Financeiro → Cobranças → WhatsApps. Só GET,
// nenhuma escrita — CRUD de instâncias (criar/desabilitar/reabilitar,
// src/routes/whatsapp-instances.js) fica FORA desta fase por pedido explícito
// de reduzir risco (fica pra C.2, com flag+test mode). Cron/orquestrador novo
// (dispatchEngine.js) não é registrado em nenhum job aqui nesta fase — o
// sender legado (executarReguaCobranca) continua sendo o único caminho real.
app.use('/api/collection-whatsapp', auth, adminOnly, collectionWhatsappMonitorRouter)
app.use('/api/collection-contact-review', auth, adminOnly, collectionContactReviewRouter)

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

// Hard cap de spend do Meta Ads — a cada 5 min, sempre pulado enquanto
// automacoes_config.meta_budget_guard_enabled=false (default). Ver
// PLANO_HARD_CAP_META_ADS.md e src/jobs/meta-budget-guard.js.
cron.schedule('*/5 * * * *', async () => {
  try {
    await runMetaBudgetGuard()
  } catch (err) {
    console.error('[cron meta-budget-guard] Erro:', err.message)
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

// Régua de cobrança WhatsApp — a cada 15 min, das 08h às 17h59 BRT (11h-20h59
// UTC), seg-sex. CORREÇÃO URGENTE 2026-07-30: antes disparava tudo de uma vez às
// 08h, o que gerou uma rajada de ~50 mensagens e suspendeu o número. Agora o job
// em si (executarReguaCobranca) é quem controla os limites reais — máx. 30/dia,
// máx. 10/hora, 1 por telefone por dia, intervalo de 45-90s entre envios, e só
// dispara dentro de 08h-17h BRT — este agendamento só define a cadência de
// "ticks"; o job decide a cada tick se ainda pode enviar algo. Desligada por
// padrão (automacoes_config.cobranca_whatsapp_ativa=false) até ser ativada
// explicitamente pela tela de Cobranças.
cron.schedule('*/15 11-20 * * 1-5', async () => {
  try {
    await executarReguaCobranca()
  } catch (err) {
    console.error('[cron cobranca-whatsapp] Erro:', err.message)
  }
})

// 2026-09-01 — sweep de pagamento tardio (paymentGuard.varrerTitulosPendentesEcancelarQuitados,
// via payment-reconciliation-sweep.js). A cada 15 min, mesma cadência da régua
// — cancela dispatch/ligação/promessa órfãos quando o título deixou de ser
// cobrável (pago/cancelado/em revisão) depois de já ter automação pendente.
// Idempotente a nível de dado (transições condicionais no banco, ver
// paymentGuard.js) E a nível de scheduler (noOverlap:true — se uma execução
// ainda estiver rodando quando o próximo tick chegar, o tick é pulado, nunca
// roda em paralelo consigo mesmo). Roda o dia todo, não só na janela
// 08h-17h, porque a baixa financeira pode chegar a qualquer hora — só
// reconciliação interna, nunca envia WhatsApp/liga.
cron.schedule('*/15 * * * *', async () => {
  try {
    await runPaymentReconciliationSweep()
  } catch (err) {
    console.error('[cron payment-reconciliation-sweep] Erro:', err.message)
  }
}, { name: 'payment-reconciliation-sweep', noOverlap: true })

// 2026-09-01 — processamento de promessas vencidas (promises.processarPromessasVencidas,
// via promise-expiry-sweep.js). 1x/dia, 07:50 horário de Brasília — antes da
// janela da régua (08h BRT), pra que um título com promessa vencida ontem já
// esteja liberado (promessaAtivaPara() volta a retornar null) no primeiro
// tick do dia. Timezone explícito (America/Sao_Paulo) — não depende do fuso
// do host (Railway); "hoje" pra processarPromessasVencidas() já é sempre BRT
// (hojeBrtISO(), collectionContactPolicy.js), então o cron precisa dessa
// mesma referência de fuso pra não disparar horas cedo/tarde. Só marca
// 'quebrada' — nunca envia mensagem/liga, o próximo ciclo normal da régua
// decide o que fazer. noOverlap:true pelo mesmo motivo do sweep acima.
cron.schedule('50 7 * * *', async () => {
  try {
    await runPromiseExpirySweep()
  } catch (err) {
    console.error('[cron promise-expiry-sweep] Erro:', err.message)
  }
}, { name: 'promise-expiry-sweep', timezone: 'America/Sao_Paulo', noOverlap: true })

// FASE B.1 (homologação) — CollectionShadowObserver. No-op enquanto
// nba_shadow_mode/score_shadow_mode (automacoes_config) estiverem false
// (padrão da migration). 100% read-only para o cliente — nunca envia
// WhatsApp, nunca liga, nunca altera título/pagamento/promessa real; só
// calcula e registra Recovery Score/Priority Score/Next Best Action em
// tabelas shadow dedicadas. Ver docs/cobranca-ai/DEPLOY_PLAN_MINIMAL.md.
cron.schedule('*/20 * * * *', async () => {
  try {
    await runCollectionShadow()
  } catch (err) {
    console.error('[cron collection-shadow] Erro:', err.message)
  }
})

// 2026-08-15 — retenção do nba_shadow_log (automacoes_config.
// nba_shadow_log_retention_days, default 90). Deliberadamente 1x/dia, nunca
// junto do ciclo de 20min acima — rodar toda hora apagaria dado recém
// gravado antes de alguém comparar régua atual x NBA. Só DELETE em
// nba_shadow_log (cleanupNbaShadowLog), nunca em nenhuma outra tabela.
cron.schedule('0 6 * * *', async () => {
  try {
    await runNbaShadowRetentionCleanup()
  } catch (err) {
    console.error('[cron nba-shadow-retention-cleanup] Erro:', err.message)
  }
})

// Monitoramento de SLA de resposta no WhatsApp — a cada 1 min, escalona notificação
// in-app quando o cliente fica sem resposta: 15min (vendedor), 30min (vendedor+admins),
// 2h (admins, crítico). Fase 3 do atendimento avançado.
cron.schedule('* * * * *', async () => {
  try {
    await runMonitoramentoResposta()
  } catch (err) {
    console.error('[cron monitoramento-resposta] Erro:', err.message)
  }
})

// Reconciliação de NF-e presas em 'enviada' (timeout/queda antes de gravar o
// resultado da SEFAZ) — a cada 5 min. Diferente do e01, a SEFAZ é alcançável
// pela internet normal, então isso roda no Railway sem problema.
cron.schedule('*/5 * * * *', async () => {
  try {
    await reconciliarNfePendentes()
  } catch (err) {
    console.error('[cron reconciliar-nfe] Erro:', err.message)
  }
})

// Sincronização automática com a SEFAZ (Distribuição DF-e) — Fase B, ligada
// no cron em 03/08 a pedido do Peterson ("pode ativar e quando tiver o
// certificado novo só mudamos"). SEGURO hoje: a trava de negócio
// `configuracoes_fiscais.entrada_sync_ativa` está `false` — o job lê essa
// flag primeiro (decidirCicloDeSincronizacao) e pula o ciclo sem tentar
// nada na SEFAZ enquanto estiver desligada, só logando "ciclo pulado".
// Mesmo se alguém religar a flag antes do certificado, o pior cenário é
// só logar erro por ciclo (consultarDistribuicaoDFe ainda é um stub que
// lança erro de propósito) — o job já trata isso em try/catch, não
// derruba a aplicação nem repete além do intervalo normal do cron.
// Quando o certificado novo chegar: implementar consultarDistribuicaoDFe
// de verdade, testar em homologação, e só então ligar
// entrada_sync_ativa=true em configuracoes_fiscais — nenhuma mudança de
// código extra é necessária além disso.
cron.schedule('*/5 * * * *', async () => {
  try {
    await runSincronizacaoDistribuicaoDFe()
  } catch (err) {
    console.error('[cron nfe-distribuicao-sync] Erro:', err.message)
  }
})

// NÃO há cron.schedule aqui para a sincronização de pedidos com o legado (e01).
// Diferente dos outros jobs desta lista, o e01 (NetVision/ES_Pedidos) só é
// alcançável a partir de uma máquina na mesma rede do DESKTOP-Q6O54R1 — o
// Railway não tem rota até lá (mesma limitação documentada em
// scripts/sync-estoque-e01.js). Um cron aqui só geraria ECONNREFUSED a cada
// execução. A sincronização roda localmente: `node scripts/sync-pedidos-legado.mjs`
// (manual ou agendado via Task Scheduler do Windows na máquina com acesso ao e01).
