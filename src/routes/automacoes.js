import { Router } from 'express'
import axios from 'axios'
import { createWhatsappProviderClient, whatsappTransportFor } from '../lib/whatsappProviderClient.js'
import { supabase } from '../lib/supabase-admin.server.js'
import { buildAutomationCapabilities, readAutomationEvidence } from '../lib/automationCapabilities.js'
import { verificarFrescorSync } from '../lib/collection/financialSyncGuard.js'
import { setAutomationConfig, AutomationWriteError } from '../lib/automationConfigWrite.js'
import { operationalKeys, setOperationalAutomation } from '../lib/operationalAutomationControls.js'
import { operationalReadiness } from '../lib/operationalReadiness.js'
import { describeAutomationModel } from '../lib/automationModelStatus.js'
import { settleAutomationChecks } from '../lib/automationDiagnostics.js'

const router = Router()

const EVOLUTION_URL = process.env.EVOLUTION_API_URL
const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || 'vivenzza'
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY

const SUPER_ADMIN_EMAIL = 'psantos@vivenzzaprofessional.com.br'

const evolutionApi = createWhatsappProviderClient({
  baseURL: EVOLUTION_URL,
  headers: { apikey: EVOLUTION_KEY },
  timeout: 10000,
})

// Área sensível (liga/desliga a IA, reconecta o WhatsApp) — restrita a um único
// usuário, não ao role "admin" geral (outros admins não devem ver/acionar isso).
router.use((req, res, next) => {
  if (req.user?.email !== SUPER_ADMIN_EMAIL || req.user?.role !== 'admin') {
    return res.status(403).json({ erro: 'Acesso restrito.' })
  }
  next()
})

async function getConfig() {
  const { data, error } = await supabase.from('automacoes_config').select('*').eq('id', 1).single().abortSignal(AbortSignal.timeout(10000))
  if (error || !data) throw new Error('Configuração das automações indisponível.')
  return data
}
const sessionReady = async name => {
  if(await whatsappTransportFor(name)!=='fzap')return false
  const {data}=await evolutionApi.get('/instance/connectionState/'+encodeURIComponent(name))
  return data?.instance?.state==='open'
}

// GET /api/automacoes/status — agrega o status dos 4 serviços numa única chamada
router.get('/status', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store')
    const config = await getConfig()
    const hoje = new Date()
    const diaBrt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(hoje)
    const inicioDia = `${diaBrt}T03:00:00.000Z`

    const [sdrInfo, evolutionEstado, elevenlabsInfo, anthropicOk, operationalEvidence] = await settleAutomationChecks([
      (async () => {
        const { count, error: countError } = await supabase
          .from('sdr_conversas')
          .select('id', { count: 'exact', head: true })
          .gte('ultimo_contato', inicioDia)
          .abortSignal(AbortSignal.timeout(10000))
        const { data: ultima, error: latestError } = await supabase
          .from('sdr_conversas')
          .select('ultimo_contato')
          .order('ultimo_contato', { ascending: false })
          .limit(1)
          .maybeSingle()
          .abortSignal(AbortSignal.timeout(10000))
        if (countError || latestError) throw new Error('Atividade indisponível')
        return { leads_atendidos_hoje: count ?? 0, ultima_atividade: ultima?.ultimo_contato ?? null }
      })(),
      (async () => {
        const { data } = await evolutionApi.get(`/instance/connectionState/${EVOLUTION_INSTANCE}`)
        return { estado: data?.instance?.state ?? data?.state ?? null, provedor: await whatsappTransportFor(EVOLUTION_INSTANCE) }
      })(),
      (async () => {
        const { data } = await axios.get('https://api.elevenlabs.io/v1/user/subscription', {
          headers: { 'xi-api-key': ELEVENLABS_KEY },
          timeout: 10000,
        })
        return data
      })(),
      axios.get('https://api.anthropic.com/v1/models', { params:{limit:1000},
        headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        timeout: 10000,
      }),
      readAutomationEvidence({ db: supabase, syncGuard: verificarFrescorSync, directionCheck: async () => {
        const name='vivenzza-notificacoes-direcao'
        const owner=await whatsappTransportFor(name)
        const {data}=await evolutionApi.get('/instance/connectionState/'+encodeURIComponent(name))
        return {owner,connected:data?.instance?.state==='open'}
      } }),
    ])

    const sdrValue = sdrInfo.status === 'fulfilled' ? sdrInfo.value : { leads_atendidos_hoje: null, ultima_atividade: null }
    const evoEstado = evolutionEstado.status === 'fulfilled' ? evolutionEstado.value.estado : null
    const elevenValue = elevenlabsInfo.status === 'fulfilled' ? elevenlabsInfo.value : null

    const model = describeAutomationModel(anthropicOk)
    const evidence = { ...(operationalEvidence.status === 'fulfilled' ? operationalEvidence.value : {}), sdr: sdrValue }
    evidence.model = model
    evidence.commercial = {known:evolutionEstado.status==='fulfilled',connected:evoEstado==='open'}
    evidence.operational = await operationalReadiness({db:supabase,config,env:process.env,evidence,modelReady:model.pronto,sessionReady})
    res.json({
      capacidades: buildAutomationCapabilities({ config, env: process.env, now: hoje, evidence }),
      versao_config: config.atualizado_em ?? null,
      sdr: {
        // Ativo reflete o controle; online exige modelo e canal confirmados.
        status: config.sdr_ativo && model.pronto && evoEstado==='open' ? 'online' : 'atencao',
        ativo: config.sdr_ativo,
        leads_atendidos_hoje: sdrValue.leads_atendidos_hoje,
        ultima_atividade: sdrValue.ultima_atividade,
      },
      evolution: {
        status: evoEstado === 'open' ? 'online' : evolutionEstado.status === 'fulfilled' ? 'atencao' : 'offline',
        estado: evoEstado,
        provedor: evolutionEstado.status === 'fulfilled' ? evolutionEstado.value.provedor : 'indeterminado',
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
        erro: elevenlabsInfo.status === 'rejected' ? 'Não foi possível consultar o serviço de voz.' : null,
      },
      anthropic: {
        status: model.pronto ? 'online' : 'offline',
        ...model,
      },
      atualizado_em: new Date().toISOString(),
    })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// Explicit desired state and database CAS; stale tabs cannot invert a switch.
router.patch('/config/:key', async (req, res) => {
  try {
    if(operationalKeys.has(req.params.key)) return res.json(await setOperationalAutomation({db:supabase,key:req.params.key,body:req.body,expectedInstance:process.env.SDR_SITE_INSTANCE||null,checkReady:async key=>{
      const [configuration,diagnostics,models]=await settleAutomationChecks([
        getConfig(),readAutomationEvidence({db:supabase,syncGuard:verificarFrescorSync}),
        axios.get('https://api.anthropic.com/v1/models',{params:{limit:1000},headers:{'x-api-key':ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},timeout:10000}),
      ])
      if(configuration.status!=='fulfilled')throw Object.assign(Error('Configuração indisponível. Atualize a consulta.'),{status:503})
      const config=configuration.value,evidence=diagnostics.status==='fulfilled'?diagnostics.value:{}
      const modelReady=models.status==='fulfilled'&&models.value.data?.data?.some(m=>m.id==='claude-sonnet-4-6')===true
      return (await operationalReadiness({db:supabase,config,env:process.env,evidence,modelReady,sessionReady}))[key]?.pode_habilitar===true
    }}))
    res.json(await setAutomationConfig({ db: supabase, key: req.params.key, body: req.body, canEnable: async key => {
    if (key !== 'financeiro-regua') return false
    const config = await getConfig()
    const evidence = await readAutomationEvidence({ db: supabase, syncGuard: verificarFrescorSync })
    return buildAutomationCapabilities({ config: { ...config, cobranca_whatsapp_ativa: true }, env: process.env, evidence }).find(c => c.id === key)?.estado === 'habilitado'
  } })) }
  catch (error) { const known=error instanceof AutomationWriteError || [400,409,503].includes(error.status);res.status(known ? error.status : 503).json({ erro: known ? error.message : 'Configuração indisponível.' }) }
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
