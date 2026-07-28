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

// Telefones vindos de clientes_erp/legado às vezes são pré-2012 (8 dígitos
// locais, sem o 9º dígito que virou obrigatório pra celular no Brasil) —
// gera "5571XXXXXXXX" (12 dígitos) quando o correto seria "557X9XXXXXXX"
// (13). Insere o 9 logo após o DDD pra tentar a variante moderna.
function comNonoDigito(jid) {
  if (jid.length !== 12) return null
  const ddd = jid.slice(2, 4)
  const local = jid.slice(4)
  return `55${ddd}9${local}`
}

async function existeNoWhatsapp(jid) {
  const { data } = await evolutionFinanceiroApi.post(`/chat/whatsappNumbers/${INSTANCE}`, { numbers: [jid] })
  return data?.[0]?.exists ? (data[0].jid || jid) : null
}

// Confirma que o número existe no WhatsApp ANTES de tentar enviar — evita
// mandar pra um JID inválido (a Evolution já rejeita com 400 nesse caso,
// mas só depois de tentar, e a mensagem de erro genérica não dizia o motivo
// real). Se o formato de 8 dígitos falhar, tenta a variante com 9º dígito.
export async function enviarTextoFinanceiro(numero, texto) {
  const jidBase = paraJidWhatsapp(numero)
  let jidValido = await existeNoWhatsapp(jidBase)
  if (!jidValido) {
    const alternativo = comNonoDigito(jidBase)
    if (alternativo) jidValido = await existeNoWhatsapp(alternativo)
  }

  if (!jidValido) {
    throw new Error(`Número ${numero} não está registrado no WhatsApp`)
  }

  const { data } = await evolutionFinanceiroApi.post(`/message/sendText/${INSTANCE}`, {
    number: jidValido,
    text: texto,
  })
  return data
}

export async function statusInstanciaFinanceira() {
  const { data } = await evolutionFinanceiroApi.get(`/instance/connectionState/${INSTANCE}`)
  return data?.instance?.state ?? null
}
