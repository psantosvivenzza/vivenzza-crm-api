// Client Evolution API dedicado à instância financeira (vivenzza-financeiro).
// Não reaproveita o client de whatsapp.js de propósito: aquele tem efeitos
// colaterais (marcarVendedorAssumiu, flip de atendimento_humano) que fazem
// sentido pra conversa de venda mas não pra mensagem de cobrança.
import axios from 'axios'
import { paraJidWhatsapp } from './telefone.js'

const EVOLUTION_URL = process.env.EVOLUTION_API_URL || 'https://evolution-api-production-6f0a.up.railway.app'
const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY
const INSTANCE = process.env.FINANCEIRO_WHATSAPP_INSTANCE || 'vivenzza-financeiro'

const evolutionFinanceiroApi = axios.create({
  baseURL: EVOLUTION_URL,
  headers: { apikey: EVOLUTION_KEY },
  timeout: 20000,
})

export async function enviarTextoFinanceiro(numero, texto) {
  const jid = paraJidWhatsapp(numero)
  const { data } = await evolutionFinanceiroApi.post(`/message/sendText/${INSTANCE}`, {
    number: jid,
    text: texto,
  })
  return data
}

export async function statusInstanciaFinanceira() {
  const { data } = await evolutionFinanceiroApi.get(`/instance/connectionState/${INSTANCE}`)
  return data?.instance?.state ?? null
}
