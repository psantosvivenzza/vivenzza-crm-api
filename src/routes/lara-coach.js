// Lara Coach: (1) sugestão de resposta dentro da conversa do CRM e
// (2) avaliação de desempenho das vendedoras. A Lara NUNCA envia nada ao cliente
// por aqui: só devolve texto para a vendedora revisar e usar.
import { Router } from 'express'
import Anthropic from '@anthropic-ai/sdk'
import rateLimit from 'express-rate-limit'
import { supabase } from '../lib/supabase-admin.server.js'
import { adminOnly } from '../middleware/auth.js'
import { PEDIDO_MINIMO, VOLUME_MENSAL_MINIMO, ENTRADA_PERCENTUAL } from '../lib/qualificacaoLead.js'

const router = Router()
// Só admin e vendedora usam o coach (financeiro e demais papéis não).
router.use((req, res, next) =>
  ['admin', 'vendedor'].includes(req.user?.role) ? next() : res.status(403).json({ erro: 'Sem permissão' }))
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const MODELO = 'claude-sonnet-4-6'
const TIMEOUT = 8000

const limiteSugestao = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 40,
  keyGenerator: (req) => `u:${req.user?.id ?? req.ip}`,
  message: { erro: 'Limite de sugestões por hora atingido. Tente novamente em alguns minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
})

const BASE_TECNICAS = `
TÉCNICAS DE VENDA QUE VOCÊ APLICA (venda consultiva por WhatsApp, B2B de beleza profissional):
- Resposta rápida: o primeiro retorno em minutos pesa muito mais que a mensagem perfeita.
- Um objetivo por mensagem e UMA pergunta por vez. Mensagens soltas ("Oi", "Tudo bem?") em sequência desperdiçam atenção: junte numa mensagem com propósito.
- Diagnóstico antes de oferta (ideia do SPIN: Situação, Problema, Implicação, Necessidade): entenda como o salão trabalha hoje, onde dói (margem, resultado, frizz, reposição) e o custo de não resolver, ANTES de falar de produto ou preço.
- Fale de resultado e margem para o cliente, não de característica do produto.
- Objeção de preço: não rebata com desconto. Reconheça, reforce valor/margem, ofereça o próximo passo (amostra, kit inicial, condição de entrada).
- Fechamento assumido com escolha entre duas opções ("prefere começar pelo kit de tratamento ou pelo de alisamento?"), nunca "alguma dúvida?".
- Follow-up: cada contato traz algo novo (resultado, caso, condição) e termina em pergunta fácil de responder. Nunca "só passando pra saber".
- Nunca culpe o cliente. Se algo falhou, assuma, resolva e previna ("daqui pra frente já confirmo a transportadora no pedido").
- Antes de fechar pedido, confirme: itens, forma de entrega/transportadora, forma de pagamento.`

const REGRAS_VIVENZZA = `
MARCA E CONDIÇÃO COMERCIAL (Vivenzza Professional — premium, excelência italiana, alta performance):
- Tom: profissional, caloroso, seguro e direto. Sem gíria exagerada, sem pressão, sem promessa vazia. No máximo 1-2 emojis.
- Primeira compra de distribuidor/revenda: pedido mínimo R$ ${PEDIDO_MINIMO.toLocaleString('pt-BR')}; entrada de ${ENTRADA_PERCENTUAL}% com saldo no cartão ou PIX; boleto só após análise de crédito pelo consultor.
- Lead quente: CNPJ + volume mensal a partir de R$ ${VOLUME_MENSAL_MINIMO.toLocaleString('pt-BR')} + cidade sem distribuidor.
- Nunca prometa território exclusivo, desconto fora da política, prazo não confirmado ou resultado garantido. Em dúvida, diga que vai confirmar.
- Nunca invente dado de produto, preço ou estoque que não esteja na conversa.`

function mascarar(texto) {
  return String(texto ?? '')
    .replace(/\b\d{2}[.\s]?\d{3}[.\s]?\d{3}[/\s]?\d{4}[-\s]?\d{2}\b/g, '[cnpj]')
    .replace(/\+?\d[\d\s().-]{9,}\d/g, '[número]')
    .slice(0, 600)
}

function formatarConversa(msgs) {
  return msgs
    .map((m) => `${m.direcao === 'saida' ? 'VENDEDORA/EMPRESA' : 'CLIENTE'}: ${mascarar(m.mensagem)}`)
    .join('\n')
}

function extrairJson(texto) {
  try { return JSON.parse(texto) } catch { /* tenta extrair */ }
  try { return JSON.parse((String(texto).match(/\{[\s\S]*\}/) || [])[0]) } catch { return null }
}

async function podeVerLead(user, lead) {
  if (user.role === 'admin') return true
  return lead.responsavel_id === user.id
}

// POST /api/lara/sugestao { lead_id }
router.post('/sugestao', limiteSugestao, async (req, res) => {
  const leadId = req.body?.lead_id
  if (!leadId || typeof leadId !== 'string') return res.status(400).json({ erro: 'lead_id é obrigatório' })
  try {
    const { data: lead, error } = await supabase
      .from('leads')
      .select('id,nome,empresa,tipo,etapa,cidade,estado,observacoes,responsavel_id,qual_tipo,qual_cnpj,qual_regiao,qual_volume_mensal,qual_nota,qual_faixa')
      .eq('id', leadId).maybeSingle()
    if (error || !lead) return res.status(404).json({ erro: 'Lead não encontrado' })
    if (!(await podeVerLead(req.user, lead))) return res.status(403).json({ erro: 'Sem acesso a este lead' })

    const { data: msgsDesc } = await supabase
      .from('whatsapp_mensagens').select('direcao,mensagem,created_at')
      .eq('lead_id', leadId).order('created_at', { ascending: false }).limit(30)
    const msgs = (msgsDesc ?? []).reverse().filter((m) => m.mensagem)
    if (!msgs.length) return res.json({ diagnostico: 'Ainda não há conversa com este lead.', sugestao: null, proximo_passo: 'Inicie com uma abordagem curta e objetiva.', alerta: null })

    const horas = Math.round((Date.now() - new Date(msgsDesc[0].created_at).getTime()) / 36e5)
    const contexto = `LEAD: ${lead.nome ?? 'sem nome'}${lead.empresa ? ' — ' + lead.empresa : ''}
Etapa no funil: ${lead.etapa} · Tipo: ${lead.qual_tipo ?? lead.tipo ?? 'indefinido'}
Qualificação: CNPJ=${lead.qual_cnpj ?? 'não informado'} · Região=${lead.qual_regiao ?? lead.cidade ?? 'não informada'} · Volume mensal=${lead.qual_volume_mensal ?? 'não informado'} · Nota=${lead.qual_nota ?? 'sem nota'} (${lead.qual_faixa ?? 'sem faixa'})
Última mensagem há ${horas}h, enviada por: ${msgsDesc[0].direcao === 'saida' ? 'nós' : 'o cliente'}
Observações internas: ${mascarar(lead.observacoes) || 'nenhuma'}

CONVERSA (mais antiga → mais recente):
${formatarConversa(msgs)}`

    const resp = await anthropic.messages.create({
      model: MODELO,
      max_tokens: 700,
      system: `Você é a Lara, coach comercial da Vivenzza Professional. Ajuda a vendedora a responder um cliente específico.
${BASE_TECNICAS}
${REGRAS_VIVENZZA}

Responda APENAS com JSON válido:
{
  "diagnostico": "1-2 frases: em que ponto o cliente está e o que ele realmente quer/teme",
  "sugestao": "mensagem pronta para WhatsApp, em português do Brasil, curta (até 3 parágrafos curtos), terminando em UMA pergunta ou próximo passo claro. Se a última mensagem foi nossa e o cliente não respondeu, sugira um follow-up que traga algo novo",
  "proximo_passo": "ação interna recomendada (ex.: ligar, enviar catálogo, pedir CNPJ, passar ao gestor)",
  "alerta": "risco que a vendedora precisa saber (cliente irritado, promessa fora da política, lead bloqueado), ou null"
}`,
      messages: [{ role: 'user', content: contexto }],
    }, { timeout: 30000 })

    const parsed = extrairJson(resp.content?.[0]?.text ?? '')
    if (!parsed?.sugestao && !parsed?.diagnostico) return res.status(502).json({ erro: 'A Lara não conseguiu gerar a sugestão agora. Tente de novo.' })
    console.log(`[lara-coach] sugestao user=${req.user.id} lead=${leadId} msgs=${msgs.length}`)
    return res.json({
      diagnostico: parsed.diagnostico ?? null,
      sugestao: parsed.sugestao ?? null,
      proximo_passo: parsed.proximo_passo ?? null,
      alerta: parsed.alerta ?? null,
    })
  } catch (err) {
    console.error('[lara-coach] erro sugestao:', err?.message)
    return res.status(500).json({ erro: 'Não foi possível gerar a sugestão agora.' })
  }
})

// POST /api/lara/avaliar-conversa { lead_id } - avalia como a vendedora conduziu ESTE atendimento (admin)
router.post('/avaliar-conversa', adminOnly, limiteSugestao, async (req, res) => {
  const leadId = req.body?.lead_id
  if (!leadId || typeof leadId !== 'string') return res.status(400).json({ erro: 'lead_id é obrigatório' })
  try {
    const { data: lead, error } = await supabase
      .from('leads')
      .select('id,nome,empresa,tipo,etapa,cidade,estado,observacoes,responsavel_id,qual_tipo,qual_cnpj,qual_regiao,qual_volume_mensal,qual_nota,qual_faixa')
      .eq('id', leadId).maybeSingle()
    if (error || !lead) return res.status(404).json({ erro: 'Lead não encontrado' })

    let vendedora = null
    if (lead.responsavel_id) {
      const { data: p } = await supabase.from('usuarios').select('nome').eq('id', lead.responsavel_id).maybeSingle()
      vendedora = p?.nome ?? null
    }

    const { data: msgsDesc } = await supabase
      .from('whatsapp_mensagens').select('direcao,mensagem,created_at')
      .eq('lead_id', leadId).order('created_at', { ascending: false }).limit(60)
    const msgs = (msgsDesc ?? []).reverse().filter((m) => m.mensagem)
    const doCliente = msgs.filter((m) => m.direcao === 'entrada').length
    const nossas = msgs.filter((m) => m.direcao === 'saida').length
    if (doCliente < 1 || nossas < 1) {
      return res.status(422).json({ erro: 'Ainda não há conversa suficiente (precisa de mensagens do cliente e da equipe) para avaliar.' })
    }

    // Métricas objetivas: tempo até a equipe responder cada mensagem do cliente.
    const esperas = []
    let aberta = null
    for (const m of msgs) {
      const t = new Date(m.created_at).getTime()
      if (m.direcao === 'entrada') { if (aberta === null) aberta = t }
      else if (aberta !== null) { esperas.push((t - aberta) / 60000); aberta = null }
    }
    const pendenteMin = aberta !== null ? Math.round((Date.now() - aberta) / 60000) : null
    const mediana = esperas.length ? [...esperas].sort((a, b) => a - b)[Math.floor(esperas.length / 2)] : null
    const maior = esperas.length ? Math.max(...esperas) : null
    const fmt = (min) => (min == null ? 'n/d' : min < 60 ? `${Math.round(min)} min` : `${(min / 60).toFixed(1)} h`)

    const linhas = msgs.map((m) => {
      const hora = new Date(m.created_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
      return `[${hora}] ${m.direcao === 'saida' ? 'EQUIPE' : 'CLIENTE'}: ${mascarar(m.mensagem)}`
    }).join('\n')

    const contexto = `LEAD: etapa no funil ${lead.etapa} · tipo ${lead.qual_tipo ?? lead.tipo ?? 'indefinido'} · nota de qualificação ${lead.qual_nota ?? 'sem nota'} (${lead.qual_faixa ?? 'sem faixa'}) · volume mensal ${lead.qual_volume_mensal ?? 'não informado'}
Vendedora responsável: ${vendedora ?? 'não definida'}
MÉTRICAS DESTA CONVERSA: ${msgs.length} mensagens (${doCliente} do cliente, ${nossas} da equipe); tempo mediano para a equipe responder ${fmt(mediana)}; maior espera do cliente ${fmt(maior)}; ${pendenteMin !== null ? `cliente aguardando resposta há ${fmt(pendenteMin)}` : 'sem mensagem do cliente pendente'}

CONVERSA (mais antiga → mais recente, horário de Brasília):
${linhas}`

    const resp = await anthropic.messages.create({
      model: MODELO,
      max_tokens: 1400,
      system: `Você é a Lara, diretora comercial da Vivenzza Professional avaliando UM atendimento por WhatsApp para o gestor. Seja justa, específica e construtiva: sem humilhar e sem elogio vazio.
${BASE_TECNICAS}
${REGRAS_VIVENZZA}

REGRAS DA AVALIAÇÃO:
- Mensagens da EQUIPE longas, cheias de emoji, com cupom, PDF de promoção ou texto padrão são disparo/automação/Lara: não conte como esforço personalizado da vendedora, apenas como contexto.
- Mensagens de saída durante a noite ou fim de semana podem ser da Lara (IA), não da vendedora.
- Avalie: rapidez, diagnóstico das necessidades, condução para o próximo passo, tratamento de objeções, clareza da condição comercial (pedido mínimo, entrada de 40%), tom e profissionalismo, follow-up.
- Cite trechos curtos reais. Se a conversa for curta demais para julgar algum ponto, diga isso em vez de inventar.
- Nunca exponha telefones ou nomes de clientes.

Responda APENAS com JSON válido:
{
  "nota": 0-100,
  "classificacao": "excelente | boa | regular | fraca",
  "resumo": "2-3 frases diretas sobre como a vendedora se portou",
  "pontos_fortes": ["..."],
  "pontos_de_melhoria": ["..."],
  "momento_critico": {"trecho": "mensagem curta real ou null", "o_que_deveria_ter_feito": "..."},
  "proximo_passo": "o que fazer agora com este lead"
}`,
      messages: [{ role: 'user', content: contexto }],
    }, { timeout: 45000 })

    const a = extrairJson(resp.content?.[0]?.text ?? '')
    if (!a || typeof a.nota !== 'number') return res.status(502).json({ erro: 'A Lara não conseguiu concluir a avaliação. Tente de novo.' })
    console.log(`[lara-coach] avaliar-conversa user=${req.user.id} lead=${leadId} msgs=${msgs.length}`)
    return res.json({
      avaliacao: a,
      vendedora,
      metricas: { mensagens: msgs.length, mediana_resposta_min: mediana == null ? null : Math.round(mediana), maior_espera_min: maior == null ? null : Math.round(maior), aguardando_min: pendenteMin },
    })
  } catch (err) {
    console.error('[lara-coach] erro avaliar-conversa:', err?.message)
    return res.status(500).json({ erro: 'Não foi possível avaliar agora.' })
  }
})

// GET /api/lara/avaliacao-vendedores?dias=30 — métricas + última análise salva (admin)
router.get('/avaliacao-vendedores', adminOnly, async (req, res) => {
  const dias = Math.min(90, Math.max(7, Number(req.query.dias) || 30))
  try {
    const { data: metricas, error } = await supabase.rpc('lara_metricas_vendedores', { p_dias: dias })
    if (error) throw error
    const ids = (metricas ?? []).map((m) => m.vendedor_id)
    const { data: analises } = ids.length
      ? await supabase.from('lara_avaliacoes_vendedor').select('vendedor_id,periodo_dias,analise,criado_em')
          .in('vendedor_id', ids).not('analise', 'is', null).order('criado_em', { ascending: false }).limit(50)
      : { data: [] }
    const ultima = new Map()
    for (const a of analises ?? []) if (!ultima.has(a.vendedor_id)) ultima.set(a.vendedor_id, a)
    return res.json({
      dias,
      vendedores: (metricas ?? []).map((m) => ({ ...m, ultima_analise: ultima.get(m.vendedor_id) ?? null })),
    })
  } catch (err) {
    console.error('[lara-coach] erro avaliacao:', err?.message)
    return res.status(500).json({ erro: 'Não foi possível carregar a avaliação.' })
  }
})

// POST /api/lara/avaliacao-vendedores/analisar { vendedor_id, dias } — análise qualitativa (admin)
router.post('/avaliacao-vendedores/analisar', adminOnly, async (req, res) => {
  const vendedorId = req.body?.vendedor_id
  const dias = Math.min(90, Math.max(7, Number(req.body?.dias) || 30))
  if (!vendedorId) return res.status(400).json({ erro: 'vendedor_id é obrigatório' })
  try {
    const { data: metricas } = await supabase.rpc('lara_metricas_vendedores', { p_dias: dias })
    const m = (metricas ?? []).find((x) => x.vendedor_id === vendedorId)
    if (!m) return res.status(404).json({ erro: 'Sem dados desta vendedora no período' })

    const desde = new Date(Date.now() - dias * 864e5).toISOString()
    const { data: leads } = await supabase.from('leads').select('id,etapa')
      .eq('responsavel_id', vendedorId).gte('ultima_mensagem_em', desde)
      .order('ultima_mensagem_em', { ascending: false }).limit(60)

    const conversas = []
    for (const l of leads ?? []) {
      if (conversas.length >= 10) break
      const { data: msgs } = await supabase.from('whatsapp_mensagens').select('direcao,mensagem,created_at')
        .eq('lead_id', l.id).gte('created_at', desde).order('created_at', { ascending: false }).limit(16)
      const util = (msgs ?? []).reverse().filter((x) => x.mensagem)
      const temCliente = util.some((x) => x.direcao === 'entrada')
      const temNos = util.some((x) => x.direcao === 'saida')
      if (util.length >= 5 && temCliente && temNos) conversas.push({ etapa: l.etapa, texto: formatarConversa(util) })
    }
    if (!conversas.length) return res.status(422).json({ erro: 'Conversas insuficientes para analisar.' })

    const resp = await anthropic.messages.create({
      model: MODELO,
      max_tokens: 1800,
      system: `Você é a Lara, diretora comercial da Vivenzza Professional avaliando o atendimento de uma vendedora por WhatsApp. Seja justa, específica e construtiva — sem humilhar, sem elogio vazio.
${BASE_TECNICAS}
${REGRAS_VIVENZZA}

REGRAS DA AVALIAÇÃO:
- Mensagens longas com emojis, cupom, "EU QUERO", PDF de promoção e textos idênticos em várias conversas são disparos automáticos ou campanhas: NÃO avalie como desempenho da vendedora.
- Julgue só o que a vendedora escreveu de forma personalizada. Cite exemplos curtos reais da amostra.
- A amostra é pequena: diga isso e não generalize além do que os exemplos mostram.
- Nunca exponha nomes ou telefones de clientes.

Responda APENAS com JSON válido:
{
  "nota_geral": 0-100,
  "resumo": "2-3 frases",
  "pontos_fortes": ["..."],
  "pontos_de_melhoria": ["..."],
  "exemplos": [{"situacao":"...","o_que_foi_dito":"trecho curto","como_melhorar":"resposta sugerida"}],
  "plano_da_semana": ["3 ações práticas e mensuráveis"]
}`,
      messages: [{
        role: 'user',
        content: `Vendedora: ${m.vendedor_nome}. Período: últimos ${dias} dias.
Métricas (horário comercial): tempo mediano de resposta ${m.resp_mediana_min ?? 'n/d'} min; ${m.pct_resp_15min ?? 'n/d'}% respondidas em até 15 min; ${m.sem_resposta_24h} conversas com o cliente esperando há mais de 24h; ${m.pct_msgs_curtas ?? 'n/d'}% das mensagens enviadas têm menos de 12 caracteres; ${m.leads_fechados} leads fechados; ${m.conversas} conversas.

AMOSTRA DE CONVERSAS:
${conversas.map((c, i) => `--- Conversa ${i + 1} (etapa atual: ${c.etapa}) ---\n${c.texto}`).join('\n\n')}`,
      }],
    }, { timeout: 90000 })

    const analise = extrairJson(resp.content?.[0]?.text ?? '')
    if (!analise?.nota_geral) return res.status(502).json({ erro: 'A Lara não conseguiu concluir a análise. Tente de novo.' })
    analise.amostra = conversas.length
    await supabase.from('lara_avaliacoes_vendedor').insert({
      vendedor_id: vendedorId, periodo_dias: dias, metricas: m, analise, criado_por: req.user.id,
    })
    console.log(`[lara-coach] analise vendedor=${vendedorId} conversas=${conversas.length}`)
    return res.json({ analise, metricas: m })
  } catch (err) {
    console.error('[lara-coach] erro analisar:', err?.message)
    return res.status(500).json({ erro: 'Não foi possível analisar agora.' })
  }
})

export default router
