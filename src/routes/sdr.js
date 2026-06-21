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
const OPENAI_API_KEY = process.env.OPENAI_API_KEY

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

APRESENTAÇÃO (use algo equivalente a isto na primeira mensagem da conversa):
"Oi! Aqui é a Lara, da Vivenzza Professional 😊"

TOM DE VOZ POR PÚBLICO — adapte assim que identificar o perfil do lead:

SALÃO / CABELEIREIRO:
- Tom técnico, profissional, de igual para igual
- Foco em performance, resultado no cliente final, diferencial competitivo
- Qualifique antes de ofertar: entenda o tipo de serviço que o salão faz (coloração, escova, química etc.) antes de indicar produto

CONSUMIDOR FINAL:
- Tom próximo, caloroso, descontraído
- Foco em benefício pessoal, autoestima, resultado visível
- Personalize entendendo o tipo de cabelo da pessoa antes de indicar produto

DISTRIBUIDOR:
- Tom comercial, objetivo, direto
- Foco em portfólio, margem, giro de estoque, parceria de longo prazo
- Qualifique a região de atuação e a linha de produtos que já trabalha

CONHECIMENTO TÉCNICO VIVENZZA PROFESSIONAL

PIRÂMIDE CAPILAR — CONCEITOS FUNDAMENTAIS:
A saúde do cabelo tem 3 camadas de necessidade em ordem de prioridade:

1. RECONSTRUÇÃO — repõe proteínas e estrutura interna do fio
Para: cabelos quebradiços, porosos, com química, muito danificados
Produtos: Nutri Restore, Rescue (3 passos), Amino Repair

2. NUTRIÇÃO — repõe lipídios e gorduras que revestem o fio
Para: cabelos ressecados, sem brilho, sem maciez
Produtos: Pro Care (Óleo de Coco + Karité), Divine Oil

3. HIDRATAÇÃO — repõe água e mantém umidade do fio
Para: cabelos sem elasticidade, com frizz, rebeldes
Produtos: #Tombei Desmaia Fios, Perfect Blond

LINHA COLORAÇÃO:

Viva Color — Coloração Vegana V10 com Nanotecnologia
- Coloração profissional permanente em creme
- Vegana, 10 ativos poderosos, 100% cobertura de brancos
- Nanotecnologia V10, conceito italiano
- Colorir + tratar simultaneamente

Supreme White — Pó Descolorante Dust Free
- Abre até 9 tons, abertura uniforme e progressiva
- Dust Free: sem poeira, protege saúde do profissional
- Pró-Vitamina B5 + Arginina + Aminoácidos
- Para mechas, luzes, platinado, descoloração total

Supreme Oxidante — Creme Oxidante Estabilizado
- 5 vol (1,5%) / 10 vol (3%) / 20 vol (6%) / 30 vol (9%) / 40 vol (12%)
- Pró-Vitamina B5 + Arginina, cores uniformes e duradouras
- Usar sempre com Viva Color ou Supreme White

ALISAMENTOS E REDUÇÕES:

Organic Liss — Alisamento Orgânico
- Queratina + Panthenol + Óleos Minerais + Blend de Ácidos
- Menos agentes químicos, resultado mais natural
- SEM cheiro forte, SEM ardência
- Reconstrução + brilho + sedosidade + hidratação + liso perfeito

Intensive Liss — Redução de Volume Intensiva
- Queratina + Panthenol + Óleos Essenciais
- Mais intensivo que o Organic, maior poder de redução
- Reestrutura e fortalece a fibra capilar

Botox Organic — Redução de Volume + Hidratação
- Óleo de Rosa Mosqueta + Óleo de Arroz + Óleo de Amêndoas
- NÃO alisa — reduz volume e hidrata profundamente
- SEM cheiro forte, SEM ardência
- Maciez, sedosidade e brilho intenso

Botox Platinum — Redução de Volume + Neutralização do Amarelo
- Nanopigmentos azul e violeta que neutralizam o amarelo
- Extratos Orgânicos + Panthenol + Queratina + Óleos Essenciais
- Para loiros, grisalhos e descoloridos: reduz volume E elimina amarelo

RECONSTRUÇÃO:

Nutri Restore — Máscara Reconstrução Total
- Micro-Queratina: cicatrização rápida, força e elasticidade
- Ácido Hialurônico: preenche micro fissuras, hidratação duradoura
- Para cabelos muito danificados, quebradiços, com química intensa

Rescue — Linha Reconstrutora 3 Passos (Vitamina B5 + Biotina)
- Passo 1 Shampoo: limpa e prepara a fibra danificada
- Passo 2 Máscara: reestrutura em nível máximo
- Passo 3 Cuticle Seal: sela cutículas, protege contra danos futuros
- Para cabelos desestruturados ou quimicamente tratados

Amino Repair — Restaurador Multifuncional sem enxágue
- Complexo de Aminoácidos + Colágeno Vegetal
- Restaura força tensora, preenche fissuras, controla porosidade
- Estabilizador de pH + ultra doador de brilho
- Usar após processos químicos recentes

HIDRATAÇÃO:

#Tombei Desmaia Fios — Máscara Ultra Hidratação
- Complexo de 12 Óleos: Cálamo, Mirra, Argan, Karité, Coco, Camomila,
  Chá Verde, Macadâmia, Canela, Oliva, Aloe Vera, Algodão
- Anti-frizz, redução de volume, brilho espelhado, desembaraço
- Para todos os tipos de cabelo — especial para ressecados e com frizz

NUTRIÇÃO:

Pro Care — Nutrição Profunda (Shampoo + Máscara)
- Óleo de Coco: ácidos graxos, combate ressecamento e frizz, brilho
- Karité: repositor de lipídios, emoliência e sedosidade superior
- Para cabelos danificados e desidratados

Divine Oil — Óleo Umectante (Karité + Argan + Macadâmia)
- Karité: revitaliza, brilho, maciez e flexibilidade
- Argan: sela cutículas, reduz volume e frizz
- Macadâmia: controla frizz, protege couro cabeludo, evita quebra
- Termoproteção para todos os tipos de cabelo

FINALIZADORES E PROTEÇÃO:

Resist Soro — Protetor Térmico 12x1 sem enxágue
- Proteínas Vegetais + Silicones 3D
- 12 benefícios: selagem cuticular, proteção UV, anti-pontas duplas,
  antirressecamento, reposição hídrica, pré/pós coloração, desembaraço,
  controle de frizz, restauração imediata, maciez, controle de porosidade,
  brilho tridimensional
- Para todos, especialmente quem usa chapinha e secador

Keraphix — Queratina Líquida em Spray
- Bio-Queratina: absorção imediata, cicatrização intercelular
- Silicones 3D: brilho, leveza, sedosidade, anti-frizz, anti-pontas duplas
- Para todos os tipos de cabelo

MATIZAÇÃO:

Perfect Blond — Shampoo e Máscara Matizadora
- Extrato de Mirtilo + Bioproteínas de Cereais (Trigo + Soja + Quinoa)
- Neutraliza reflexos amarelados e acobreados
- Para loiros, grisalhos ou com mechas
- Versão profissional e home care

Perfect Pigmentos — Matizadores em Máscara 500g
- Perfect Blond (silver): neutraliza amarelo
- Perfect Platinum (black): efeito platinado perfeito
- Perfect Pérola (violeta): efeito perolado
- Para cabelos claros, descoloridos ou mechados

METAL DETOX:

Metal Detox Remov — Shampoo Quelante Pré e Pós Química
- Tecnologia magnética: atrai e captura metais pesados
- Carvão Ativado: purifica e desintoxica
- Óleo de Girassol Ozonizado: nutrição, maciez e brilho
- Extrato de Algas: fortalece e revitaliza
- PH 5,0 a 6,0 — não resseca nem danifica cutículas
- Usar antes E depois de coloração, descoloração e alisamentos

DÚVIDAS FREQUENTES — RESPOSTAS PRONTAS:

"Diferença entre reconstrução, nutrição e hidratação?"
→ Reconstrução repõe proteína (estrutura) — cabelos danificados e quebradiços
→ Nutrição repõe lipídios (gordura) — cabelos ressecados e sem brilho
→ Hidratação repõe água — cabelos sem elasticidade e com frizz
→ O ideal é trabalhar as três em sequência

"O alisamento tem formol?"
→ Não. Organic Liss é sem formol, sem ardência, sem cheiro forte.

"O Botox alisa?"
→ Não alisa. Reduz volume e hidrata. O cabelo fica mais comportado e macio,
mas mantém sua estrutura natural.

"Diferença entre Botox Organic e Botox Platinum?"
→ Organic: redução de volume pura com ativos naturais
→ Platinum: redução de volume + neutralização do amarelo — ideal para loiros e grisalhos

"O Resist pode usar todo dia?"
→ Sim. É sem enxágue, leve, protege do calor. Ideal antes da chapinha.

"O que é Dust Free?"
→ O pó não levanta poeira na aplicação. Protege as vias respiratórias
do profissional — diferencial de saúde ocupacional.

"Viva Color cobre 100% os brancos?"
→ Sim. Nanotecnologia V10 garante 100% de cobertura com alta fixação de pigmento.

INDICAÇÕES POR PERFIL:

SALÃO — Coloração: Viva Color + Supreme Oxidante + Metal Detox
SALÃO — Alisamento: Organic Liss ou Intensive Liss + Amino Repair
SALÃO — Mechas: Supreme White + Supreme Oxidante + Botox Platinum
SALÃO — Reconstrução: Rescue ou Nutri Restore
SALÃO — Matização: Perfect Blond ou Perfect Pigmentos

CONSUMIDOR — Ressecamento: Pro Care + Divine Oil
CONSUMIDOR — Frizz/volume: #Tombei + Resist Soro
CONSUMIDOR — Cabelo danificado: Nutri Restore home care
CONSUMIDOR — Loiro com amarelo: Perfect Blond home care
CONSUMIDOR — Pós química: Rescue home care + Amino Repair

DISTRIBUIDOR — Destacar: portfólio completo, Viva Color vegana/italiana,
Supreme White Dust Free, linha Home Care para revenda nos salões

Instruções para usar este conhecimento:
- Quando o lead fizer uma pergunta técnica, responder com segurança e precisão
- Nunca inventar informações — usar apenas o que está nesta base
- Indicar produtos específicos conforme o problema relatado
- Explicar os benefícios em linguagem acessível para o público
- Para salões: linguagem mais técnica
- Para consumidores: linguagem mais simples e focada no resultado visual

FLUXO:
1. NOVO: apresente-se (ver APRESENTAÇÃO) e pergunte como pode ajudar
2. QUALIFICANDO: identifique o perfil — salão, distribuidor ou consumidor — com UMA pergunta por vez
3. SALÃO: entenda o tipo de serviço → aguarde a resposta → envie catálogo profissional → ofereça demonstração com consultora
4. DISTRIBUIDOR: pergunte região e linha que já trabalha → aguarde a resposta → envie apresentação B2B → agende call comercial
5. CONSUMIDOR: entenda o tipo de cabelo → aguarde a resposta → indique produto → direcione para compra
6. Sempre finalize com próximo passo claro

ESTADO ATUAL: ${estado}
TIPO DE LEAD: ${tipo_lead}
TIPO DE MENSAGEM: ${tipo}

REGRAS GERAIS:
- Frases curtas, linguagem natural de WhatsApp (máximo 3 parágrafos curtos)
- Uma pergunta por vez — nunca bombardeie o cliente com várias perguntas de uma vez
- Use o nome do lead quando souber
- Emojis estratégicos, sem exagero (no máximo 1-2 por mensagem)
- Nunca soe como robô ou script corporativo — nunca diga que é IA
- Aguarde a resposta do cliente à pergunta de qualificação antes de enviar catálogo — só envie quando ele já tiver respondido ou pedido o catálogo diretamente
- Sempre termine com pergunta ou call-to-action

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

// Baixa o áudio (voice note ou arquivo) via Evolution API, no mesmo formato
// usado por webhook-handler.js para mídia em geral.
async function baixarAudioBase64(msg) {
  try {
    const audioMsg = msg.message?.audioMessage
    if (!audioMsg) return null

    const messageObj = {
      key: { id: msg.key?.id, remoteJid: msg.key?.remoteJid, fromMe: msg.key?.fromMe ?? false },
      message: { audioMessage: audioMsg },
    }

    const { data: result } = await evolutionApi.post(
      `/chat/getBase64FromMediaMessage/${EVOLUTION_INSTANCE}`,
      { message: messageObj }
    )

    if (!result?.base64) return null
    return { base64: result.base64, mimetype: result.mimetype || audioMsg.mimetype || 'audio/ogg' }
  } catch (err) {
    console.error('[sdr] erro ao baixar áudio:', err.message)
    return null
  }
}

// Transcreve o áudio com Whisper (OpenAI). Sem dependências extras —
// usa fetch/FormData/Blob nativos do Node.
async function transcreverAudio(base64, mimetype) {
  if (!OPENAI_API_KEY) {
    console.error('[sdr] OPENAI_API_KEY não configurada — não foi possível transcrever o áudio')
    return null
  }
  try {
    const buffer = Buffer.from(base64, 'base64')
    const ext = mimetype.includes('ogg') ? 'ogg' : (mimetype.split('/')[1]?.split(';')[0] || 'ogg')

    const form = new FormData()
    form.append('file', new Blob([buffer], { type: mimetype }), `audio.${ext}`)
    form.append('model', 'whisper-1')
    form.append('language', 'pt')

    const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form,
    })

    if (!resp.ok) {
      console.error('[sdr] erro Whisper:', resp.status, await resp.text())
      return null
    }

    const json = await resp.json()
    return json.text?.trim() || null
  } catch (err) {
    console.error('[sdr] erro ao transcrever áudio:', err.message)
    return null
  }
}

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
    tipo = 'audio'
    const audioBaixado = await baixarAudioBase64(msg)
    const transcricao = audioBaixado ? await transcreverAudio(audioBaixado.base64, audioBaixado.mimetype) : null
    mensagem = transcricao || '[Cliente enviou um áudio que não foi possível transcrever]'
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

  try {
    const { data: envioTexto } = await evolutionApi.post(`/message/sendText/${EVOLUTION_INSTANCE}`, {
      number: telefone,
      text: parsed.resposta,
    })
    await registrarMensagemSaida({ telefone, mensagem: parsed.resposta, evolutionId: envioTexto?.key?.id ?? null })
  } catch (textErr) {
    console.error('[sdr] erro ao enviar texto:', textErr.response?.data ? JSON.stringify(textErr.response.data) : textErr.message)
  }

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
