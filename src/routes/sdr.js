import { Router } from 'express'
import axios from 'axios'
import Anthropic from '@anthropic-ai/sdk'
import { supabase } from '../lib/supabase.js'
import { processWhatsappEvent } from './webhook-handler.js'

const router = Router()

const EVOLUTION_URL = process.env.EVOLUTION_API_URL
const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || 'vivenzza'
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'pNInz6obpgDQGcFmaJgB'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const evolutionApi = axios.create({
  baseURL: EVOLUTION_URL,
  headers: { apikey: EVOLUTION_KEY },
  timeout: 20000,
})

const CATALOGO_PROFISSIONAL = 'https://vkncsyhugotyfwmxpzgq.supabase.co/storage/v1/object/public/Catalogos/catalogo-profissional.pdf'
const CATALOGO_COLORACAO = 'https://vkncsyhugotyfwmxpzgq.supabase.co/storage/v1/object/public/Catalogos/catalogo-coloracao.pdf'
const CATALOGO_HOME_CARE = 'https://vkncsyhugotyfwmxpzgq.supabase.co/storage/v1/object/public/whatsapp-media/catalogo-home-care.pdf'

const ACOES_CATALOGO = ['ENVIAR_CATALOGO_PRO', 'ENVIAR_CATALOGO_HOME', 'ENVIAR_APRESENTACAO_B2B']

// Salão e distribuidor recebem o pacote completo (profissional + coloração + home care);
// consumidor final recebe só o catálogo home care.
function catalogosParaEnviar(tipo_lead) {
  if (tipo_lead === 'salao' || tipo_lead === 'distribuidor') {
    return [
      { url: CATALOGO_PROFISSIONAL, fileName: 'catalogo-profissional.pdf' },
      { url: CATALOGO_COLORACAO, fileName: 'catalogo-coloracao.pdf' },
      { url: CATALOGO_HOME_CARE, fileName: 'catalogo-home-care.pdf' },
    ]
  }
  if (tipo_lead === 'consumidor_final') {
    return [{ url: CATALOGO_HOME_CARE, fileName: 'catalogo-home-care.pdf' }]
  }
  return []
}

const SYSTEM_PROMPT = (estado, tipo_lead, tipo) => `Você é Lara, consultora comercial da Vivenzza Professional, marca premium de cosméticos capilares com excelência italiana. Seu objetivo é qualificar leads e guiá-los até uma venda ou demonstração com nossa equipe.

SEU PERFIL:
- Sofisticada, acolhedora, direta e profissional
- Nunca robótica, sempre humana e elegante
- Conhece profundamente os produtos Vivenzza
- Identifica se o cliente é: salão/cabeleireiro, distribuidor ou consumidor final

PRODUTOS VIVENZZA:
- Amino Repair: restaurador multifuncional, repara força tensora, resistência e nutrição
- Hidratação Profunda: shampoo e condicionador uso diário
- Nutrição Real: nutrição intensa com colágeno vegetal
- Cursos e treinamentos para profissionais

FLUXO:
1. NOVO: apresente-se como Lara da Vivenzza e pergunte como pode ajudar
2. QUALIFICANDO: identifique o perfil — salão, distribuidor ou consumidor
3. SALÃO: pergunte porte → envie catálogo profissional → ofereça demonstração com consultora
4. DISTRIBUIDOR: pergunte região e carteira → envie apresentação B2B → agende call comercial
5. CONSUMIDOR: identifique necessidade → indique produto → direcione para compra
6. Sempre finalize com próximo passo claro

ESTADO ATUAL: ${estado}
TIPO DE LEAD: ${tipo_lead}
TIPO DE MENSAGEM: ${tipo}

REGRAS:
- Respostas curtas estilo WhatsApp (máximo 3 parágrafos)
- Nunca diga que é IA
- Use nome do cliente quando souber
- Sempre termine com pergunta ou call-to-action
- Tom: elegante, próximo, profissional

RESPONDA APENAS EM JSON VÁLIDO, sem texto fora do JSON:
{
  "resposta": "texto aqui",
  "acao": "NENHUMA|ENVIAR_CATALOGO_PRO|ENVIAR_CATALOGO_HOME|ENVIAR_APRESENTACAO_B2B|AGENDAR_DEMO|CRIAR_LEAD",
  "tipo_lead": "indefinido|salao|distribuidor|consumidor_final",
  "proximo_estado": "novo|qualificando|catalogo_enviado|demo_agendada|lead_criado",
  "gerar_audio": true
}`

function parsearRespostaClaude(texto) {
  try {
    return JSON.parse(texto)
  } catch {
    const match = texto.match(/\{[\s\S]*\}/)
    if (match) {
      try { return JSON.parse(match[0]) } catch { /* cai no fallback abaixo */ }
    }
    return {
      resposta: 'Olá! Sou a Lara da Vivenzza Professional. Como posso te ajudar hoje? 😊',
      acao: 'NENHUMA',
      tipo_lead: 'indefinido',
      proximo_estado: 'qualificando',
      gerar_audio: true,
    }
  }
}

// Variações de DDD com/sem o 9º dígito, para casar com o mesmo número já cadastrado em leads
function candidatosTelefone(telefone) {
  const semPrefixo = telefone.replace(/^55/, '')
  const com9 = semPrefixo.length === 10 ? semPrefixo.slice(0, 2) + '9' + semPrefixo.slice(2) : null
  const sem9 = semPrefixo.length === 11 ? semPrefixo.slice(0, 2) + semPrefixo.slice(3) : null
  return [telefone, semPrefixo, com9, sem9].filter(Boolean)
}

// Registra cada envio da Lara em whatsapp_mensagens, no mesmo formato usado por
// /api/whatsapp/enviar* — sem isso, a conversa que a vendedora vê no Pipeline/WhatsApp
// fica incompleta (só apareceriam as mensagens do cliente, nunca as respostas da Lara).
async function registrarMensagemSaida({ telefone, mensagem, evolutionId, mediaTipo = null, mediaUrl = null }) {
  try {
    const candidatos = candidatosTelefone(telefone)
    const { data: leads } = await supabase.from('leads').select('id').in('telefone', candidatos).limit(1)
    await supabase.from('whatsapp_mensagens').insert({
      lead_id: leads?.[0]?.id ?? null,
      mensagem,
      direcao: 'saida',
      telefone,
      status: 'enviado',
      evolution_id: evolutionId,
      media_tipo: mediaTipo,
      media_url: mediaUrl,
    })
  } catch (err) {
    console.error('[sdr] erro ao registrar mensagem de saída:', err.message)
  }
}

// GET /api/sdr/estado/:telefone — estado atual da conversa
router.get('/estado/:telefone', async (req, res) => {
  try {
    const { telefone } = req.params
    const { data, error } = await supabase
      .from('sdr_conversas')
      .select('*')
      .eq('telefone', telefone)
      .single()

    if (error || !data) {
      return res.json({ estado: 'novo', historico: [], tipo_lead: 'indefinido', nome_cliente: null })
    }
    res.json(data)
  } catch {
    res.json({ estado: 'novo', historico: [], tipo_lead: 'indefinido', nome_cliente: null })
  }
})

// POST /api/sdr/estado — salvar estado da conversa
router.post('/estado', async (req, res) => {
  try {
    const { telefone, estado, tipo_lead, historico, nome_cliente } = req.body
    const { data, error } = await supabase
      .from('sdr_conversas')
      .upsert({
        telefone,
        estado,
        tipo_lead,
        historico: historico || [],
        nome_cliente,
        ultimo_contato: new Date().toISOString(),
      }, { onConflict: 'telefone' })
      .select()

    if (error) throw error
    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Fluxo da Lara (IA) — só atua em mensagens novas recebidas (não-fromMe).
// Retorna { telefone, parsed } quando responde, ou null quando não há o que fazer
// (evento irrelevante, mensagem de status, eco da própria Lara, etc).
async function processarLara(event) {
  if (event.event !== 'messages.upsert') return null

  const msg = Array.isArray(event.data) ? event.data[0] : event.data
  if (!msg || msg.key?.fromMe) return null

  const telefone = msg.key?.remoteJid?.replace('@s.whatsapp.net', '').replace('@lid', '')
  if (!telefone) return null

  const messageType = msg.message?.messageType || Object.keys(msg.message || {})[0] || 'conversation'
  let mensagem = ''
  let tipo = 'texto'

  if (messageType === 'conversation') {
    mensagem = msg.message?.conversation || ''
  } else if (messageType === 'extendedTextMessage') {
    mensagem = msg.message?.extendedTextMessage?.text || ''
  } else if (messageType === 'audioMessage') {
    mensagem = '[Cliente enviou um áudio]'
    tipo = 'audio'
  } else if (messageType === 'imageMessage') {
    mensagem = msg.message?.imageMessage?.caption || '[Cliente enviou uma imagem]'
    tipo = 'imagem'
  } else if (messageType === 'documentMessage') {
    mensagem = '[Cliente enviou um documento]'
    tipo = 'documento'
  } else {
    mensagem = '[Mensagem recebida]'
  }

  if (!mensagem.trim()) return null

  const { data: conversa } = await supabase
    .from('sdr_conversas')
    .select('*')
    .eq('telefone', telefone)
    .single()

  const estado = conversa?.estado || 'novo'
  const tipo_lead = conversa?.tipo_lead || 'indefinido'
  const historico = conversa?.historico || []

  historico.push({ role: 'user', content: mensagem, tipo, timestamp: new Date().toISOString() })
  const historicoRecente = historico.slice(-10)

  const claudeResponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: SYSTEM_PROMPT(estado, tipo_lead, tipo),
    messages: historicoRecente.map(h => ({
      role: h.role === 'user' ? 'user' : 'assistant',
      content: h.content,
    })),
  })

  const parsed = parsearRespostaClaude(claudeResponse.content[0]?.text || '')

  historicoRecente.push({ role: 'assistant', content: parsed.resposta, timestamp: new Date().toISOString() })

  await supabase.from('sdr_conversas').upsert({
    telefone,
    estado: parsed.proximo_estado,
    tipo_lead: parsed.tipo_lead,
    historico: historicoRecente,
    ultimo_contato: new Date().toISOString(),
  }, { onConflict: 'telefone' })

  const { data: envioTexto } = await evolutionApi.post(`/message/sendText/${EVOLUTION_INSTANCE}`, {
    number: telefone,
    text: parsed.resposta,
  })
  await registrarMensagemSaida({ telefone, mensagem: parsed.resposta, evolutionId: envioTexto?.key?.id ?? null })

  if (parsed.gerar_audio && ELEVENLABS_KEY) {
    try {
      const audioResponse = await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
        {
          text: parsed.resposta,
          model_id: 'eleven_multilingual_v2',
          voice_settings: { stability: 0.5, similarity_boost: 0.8 },
        },
        { headers: { 'xi-api-key': ELEVENLABS_KEY }, responseType: 'arraybuffer' }
      )

      const audioBase64 = Buffer.from(audioResponse.data).toString('base64')
      const { data: envioAudio } = await evolutionApi.post(`/message/sendMedia/${EVOLUTION_INSTANCE}`, {
        number: telefone,
        mediatype: 'audio',
        media: audioBase64,
        fileName: 'lara-vivenzza.mp3',
      })

      const evolutionIdAudio = envioAudio?.key?.id ?? null
      let audioUrl = null
      try {
        const path = `audio/${evolutionIdAudio || Date.now()}.mp3`
        const { error: uploadError } = await supabase.storage
          .from('whatsapp-media')
          .upload(path, Buffer.from(audioBase64, 'base64'), { contentType: 'audio/mpeg', upsert: true })
        if (!uploadError) {
          audioUrl = supabase.storage.from('whatsapp-media').getPublicUrl(path).data.publicUrl
        }
      } catch { /* upload de cópia do áudio é best-effort, não bloqueia o envio */ }

      await registrarMensagemSaida({ telefone, mensagem: '[áudio]', evolutionId: evolutionIdAudio, mediaTipo: 'audio', mediaUrl: audioUrl })
    } catch (audioErr) {
      console.error('[sdr] erro ao gerar áudio:', audioErr.message)
    }
  }

  if (ACOES_CATALOGO.includes(parsed.acao)) {
    for (const cat of catalogosParaEnviar(parsed.tipo_lead)) {
      try {
        const { data: envioCat } = await evolutionApi.post(`/message/sendMedia/${EVOLUTION_INSTANCE}`, {
          number: telefone,
          mediatype: 'document',
          media: cat.url,
          fileName: cat.fileName,
        })
        await registrarMensagemSaida({
          telefone,
          mensagem: `[arquivo: ${cat.fileName}]`,
          evolutionId: envioCat?.key?.id ?? null,
          mediaTipo: 'document',
          mediaUrl: cat.url,
        })
      } catch (catErr) {
        console.error('[sdr] erro ao enviar catálogo:', cat.fileName, '|', catErr.message)
      }
    }
  }

  return { telefone, parsed }
}

// POST /api/sdr/webhook — recebe TODOS os eventos da Evolution API.
// Fluxo mesclado: a Lara responde automaticamente E o handler humano original
// (leads no Pipeline, histórico no chat das vendedoras) continua processando
// o mesmo payload normalmente — inclusive os eventos fromMe/status, que a
// Lara ignora mas o fluxo humano precisa para manter o chat fiel ao WhatsApp real.
router.post('/webhook', async (req, res) => {
  res.json({ status: 'received' }) // responde imediatamente ao Evolution

  let resultadoLara = null
  try {
    resultadoLara = await processarLara(req.body)
  } catch (err) {
    console.error('[sdr] erro no fluxo Lara:', err.message)
  }

  try {
    await processWhatsappEvent(req.body)
  } catch (err) {
    console.error('[sdr] erro ao repassar para o fluxo humano:', err.message)
  }

  // Tagueia o lead (já criado pelo fluxo humano acima) com o perfil identificado
  // pela Lara, sem sobrescrever um "tipo" já preenchido manualmente.
  if (resultadoLara?.parsed?.tipo_lead && resultadoLara.parsed.tipo_lead !== 'indefinido') {
    try {
      const candidatos = candidatosTelefone(resultadoLara.telefone)
      await supabase
        .from('leads')
        .update({ tipo: resultadoLara.parsed.tipo_lead })
        .in('telefone', candidatos)
        .is('tipo', null)
    } catch (tagErr) {
      console.error('[sdr] erro ao taguear lead:', tagErr.message)
    }
  }
})

export default router
