import { Router } from 'express'
import axios from 'axios'
import { supabase } from '../lib/supabase.js'

const router = Router()

const EVOLUTION_URL = process.env.EVOLUTION_API_URL
const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || 'vivenzza'
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY

const SUPER_ADMIN_EMAIL = 'psantos@vivenzzaprofessional.com.br'

const evolutionApi = axios.create({
  baseURL: EVOLUTION_URL,
  headers: { apikey: EVOLUTION_KEY },
  timeout: 10000,
})

// Área sensível (liga/desliga a IA, reconecta o WhatsApp) — restrita a um único
// usuário, não ao role "admin" geral (outros admins não devem ver/acionar isso).
router.use((req, res, next) => {
  if (req.user?.email !== SUPER_ADMIN_EMAIL) {
    return res.status(403).json({ erro: 'Acesso restrito.' })
  }
  next()
})

async function getConfig() {
  const { data } = await supabase.from('automacoes_config').select('*').eq('id', 1).single()
  return data || { sdr_ativo: true, voz_ativa: true }
}

// GET /api/automacoes/status — agrega o status dos 4 serviços numa única chamada
router.get('/status', async (req, res) => {
  try {
    const config = await getConfig()
    const hoje = new Date()
    const inicioDia = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate()).toISOString()

    const [sdrInfo, evolutionEstado, elevenlabsInfo, anthropicOk] = await Promise.allSettled([
      (async () => {
        const { count } = await supabase
          .from('sdr_conversas')
          .select('id', { count: 'exact', head: true })
          .gte('ultimo_contato', inicioDia)
        const { data: ultima } = await supabase
          .from('sdr_conversas')
          .select('ultimo_contato')
          .order('ultimo_contato', { ascending: false })
          .limit(1)
          .maybeSingle()
        return { leads_atendidos_hoje: count ?? 0, ultima_atividade: ultima?.ultimo_contato ?? null }
      })(),
      (async () => {
        const { data } = await evolutionApi.get(`/instance/connectionState/${EVOLUTION_INSTANCE}`)
        return data?.instance?.state ?? data?.state ?? null
      })(),
      (async () => {
        const { data } = await axios.get('https://api.elevenlabs.io/v1/user/subscription', {
          headers: { 'xi-api-key': ELEVENLABS_KEY },
          timeout: 10000,
        })
        return data
      })(),
      axios.get('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        timeout: 10000,
      }),
    ])

    const sdrValue = sdrInfo.status === 'fulfilled' ? sdrInfo.value : { leads_atendidos_hoje: 0, ultima_atividade: null }
    const evoEstado = evolutionEstado.status === 'fulfilled' ? evolutionEstado.value : null
    const elevenValue = elevenlabsInfo.status === 'fulfilled' ? elevenlabsInfo.value : null

    res.json({
      sdr: {
        // O processo respondendo essa requisição já é a prova de que o serviço está
        // no ar — "online" aqui reflete isso; "atenção" é quando o admin pausou a Lara.
        status: config.sdr_ativo ? 'online' : 'atencao',
        ativo: config.sdr_ativo,
        leads_atendidos_hoje: sdrValue.leads_atendidos_hoje,
        ultima_atividade: sdrValue.ultima_atividade,
      },
      evolution: {
        status: evoEstado === 'open' ? 'online' : evolutionEstado.status === 'fulfilled' ? 'atencao' : 'offline',
        estado: evoEstado,
        conectado: evoEstado === 'open',
        url: EVOLUTION_URL,
        instancia: EVOLUTION_INSTANCE,
      },
      elevenlabs: {
        status: !config.voz_ativa ? 'atencao' : elevenlabsInfo.status === 'fulfilled' ? 'online' : 'offline',
        ativo: config.voz_ativa,
        creditos_usados: elevenValue?.character_count ?? null,
        creditos_limite: elevenValue?.character_limit ?? null,
        // Detalhe do erro só quando a chamada falhou — sem isso, "offline" não dizia
        // se era chave errada, sem permissão, rate limit, etc, e cada diagnóstico
        // exigia entrar no Railway pra ver o log.
        erro: elevenlabsInfo.status === 'rejected'
          ? (elevenlabsInfo.reason?.response?.data?.detail?.message || elevenlabsInfo.reason?.message)
          : null,
      },
      anthropic: {
        status: anthropicOk.status === 'fulfilled' ? 'online' : 'offline',
      },
      atualizado_em: new Date().toISOString(),
    })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// POST /api/automacoes/sdr/toggle — pausa/retoma a Lara por completo (também usado
// pelo botão "Desativar Lara completamente" do card da Anthropic — é o mesmo interruptor).
router.post('/sdr/toggle', async (req, res) => {
  try {
    const config = await getConfig()
    const { data, error } = await supabase
      .from('automacoes_config')
      .update({ sdr_ativo: !config.sdr_ativo, atualizado_em: new Date().toISOString() })
      .eq('id', 1)
      .select()
      .single()
    if (error) throw error
    res.json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// POST /api/automacoes/voz/toggle — liga/desliga geração de áudio (Lara responde só texto)
router.post('/voz/toggle', async (req, res) => {
  try {
    const config = await getConfig()
    const { data, error } = await supabase
      .from('automacoes_config')
      .update({ voz_ativa: !config.voz_ativa, atualizado_em: new Date().toISOString() })
      .eq('id', 1)
      .select()
      .single()
    if (error) throw error
    res.json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// POST /api/automacoes/evolution/reconectar — devolve QR code se a instância estiver desconectada
router.post('/evolution/reconectar', async (req, res) => {
  try {
    const { data } = await evolutionApi.get(`/instance/connect/${EVOLUTION_INSTANCE}`)
    res.json({
      qrcode: data?.base64 ?? data?.qrcode?.base64 ?? null,
      estado: data?.instance?.state ?? null,
    })
  } catch (err) {
    res.status(500).json({ erro: err.response?.data?.message || err.message })
  }
})

export default router
