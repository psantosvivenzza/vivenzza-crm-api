// Adaptador Evolution API — único lugar do motor de cobrança que conhece o
// protocolo HTTP real da Evolution (endpoints, formato de payload, header `apikey`).
// dispatchEngine.js e o resto do domínio financeiro só falam a interface normalizada
// exportada aqui (sendText/checkNumber/connectionState + classificarErro), nunca
// axios/Evolution diretamente — implementa o isolamento pedido ("Criar adaptadores
// para impedir que detalhes da Evolution fiquem espalhados pelo domínio financeiro").
//
// Reaproveita a MESMA técnica de confirmação de número + variante de 9º dígito já
// validada em produção por src/lib/evolutionFinanceiro.js — não reimplementa do
// zero, só generaliza para múltiplas instâncias.
import axios from 'axios'
import { paraJidWhatsapp, telefonesEquivalentes, mascararTelefone } from '../telefone.js'

const EVOLUTION_URL_PADRAO = process.env.EVOLUTION_API_URL || 'https://evolution-api-production-6f0a.up.railway.app'

function comNonoDigito(jid) {
  if (jid.length !== 12) return null
  const ddd = jid.slice(2, 4)
  const local = jid.slice(4)
  return `55${ddd}9${local}`
}

// `instancia` é uma linha de whatsapp_instances (id, instance_name, api_base_url,
// api_key_env_var). A API key NUNCA fica na tabela nem é logada — só o NOME da env
// var que a contém, lida em tempo de execução.
function clientPara(instancia) {
  const baseURL = instancia.api_base_url || EVOLUTION_URL_PADRAO
  const apiKey = process.env[instancia.api_key_env_var || 'EVOLUTION_API_KEY']
  return axios.create({ baseURL, headers: { apikey: apiKey }, timeout: 20000 })
}

async function existeNoWhatsapp(client, instanceName, jid) {
  const { data } = await client.post(`/chat/whatsappNumbers/${instanceName}`, { numbers: [jid] })
  return data?.[0]?.exists ? (data[0].jid || jid) : null
}

// FASE C.1 (homologação, 2026-08-11) — taxonomia explícita de falha, pedido
// central da Central Multi-WhatsApp: só uma categoria genuinamente TÉCNICA
// autoriza trocar de instância. Rate limit/auth/número permanente/restrição de
// plataforma NUNCA são tratados como "a instância caiu" — o sistema não foi
// construído para contornar bloqueio ou limitação deliberada do provedor
// (pedido explícito). Categoria desconhecida também NUNCA autoriza failover
// por padrão — o custo de um falso positivo aqui (duas mensagens pro mesmo
// cliente) é maior que o custo de esperar uma reconciliação manual.
export const FAILURE_CATEGORY = Object.freeze({
  TECHNICAL_RETRYABLE: 'TECHNICAL_RETRYABLE',   // instância genuinamente indisponível — failover ok
  TECHNICAL_UNCERTAIN: 'TECHNICAL_UNCERTAIN',   // erro técnico mas ambíguo — não arrisca failover
  RATE_LIMIT: 'RATE_LIMIT',                     // 429 — pausar/backoff, nunca trocar de número
  AUTH: 'AUTH',                                 // 401/403 — problema de credencial, outra instância não resolve
  PERMANENT_RECIPIENT: 'PERMANENT_RECIPIENT',   // número inválido/não existe no WhatsApp
  PLATFORM_RESTRICTION: 'PLATFORM_RESTRICTION', // 4xx não mapeado — pode ser bloqueio/restrição do provedor
  UNKNOWN: 'UNKNOWN',                           // não reconhecido — nunca assumido como técnico
})

// CORREÇÃO 2026-08-27 — achado real em produção: `registrarFalhaEnvio()`
// (whatsappInstances.js, incrementa consecutive_failures/aciona cooldown da
// INSTÂNCIA) era chamado incondicionalmente pra QUALQUER falha, inclusive
// PERMANENT_RECIPIENT ("número não registrado no WhatsApp"). Um lote de
// destinatários com telefone ruim — problema do DADO, não da instância —
// derrubou vivenzza-financeiro e vivenzza-financeiro-reserva-01 em cooldown
// no mesmo dia (11 falhas seguidas de reserva-01, todas permanent_recipient,
// nenhuma técnica), bloqueando envios pra números BONS só porque a fila
// calhou de ter vários números ruins em sequência.
//
// `affectsInstanceHealth` separa explicitamente "isso prova que ESTA
// instância está com problema" de "isso é sobre o destinatário/mensagem,
// não sobre a instância" — só a primeira categoria deveria consumir o
// circuit breaker por instância. Decisão categoria a categoria, documentada
// porque nem toda escolha é óbvia pelo nome:
//
// - TECHNICAL_RETRYABLE/TECHNICAL_UNCERTAIN (timeout, ECONNREFUSED, 5xx):
//   true — a instância genuinamente não respondeu ou respondeu com erro de
//   servidor. Sinal real de saúde da instância, comportamento inalterado.
// - RATE_LIMIT (429): true — o provedor está limitando ESTA instância
//   especificamente; é exatamente o tipo de sinal que o cooldown existe
//   pra conter (evita continuar martelando uma instância já sob rate
//   limit). Comportamento inalterado.
// - AUTH (401/403): true — decisão deliberada. Credencial é uma
//   característica DA instância (api_key_env_var por linha em
//   whatsapp_instances), não do destinatário — 401/403 repetido é sinal
//   real de "esta instância específica precisa de atenção" (token
//   revogado/expirado, desconexão exigindo novo QR), então continua
//   contribuindo pro circuit breaker. Comportamento inalterado.
// - PERMANENT_RECIPIENT (número não registrado): false — NOVO. Prova que o
//   telefone é ruim, não que a instância é ruim. Continua sendo registrado
//   como tentativa real (rate limit global, PR #49) e continua acionando o
//   bloqueio individual do telefone (DNC, PR #48) — só para de contaminar a
//   saúde da instância.
// - PLATFORM_RESTRICTION (4xx não mapeado, ex: número banido/reportado):
//   false — NOVO, mesmo raciocínio do PERMANENT_RECIPIENT: a evidência
//   disponível aponta pro destinatário/mensagem específica, não pra
//   instância como um todo. Continua sem failover (nunca foi elegível).
// - UNKNOWN (não reconhecido): false — NOVO. Já era tratado como "nunca
//   autoriza failover" pelo mesmo motivo (falso positivo custa caro); pela
//   mesma lógica, não tem evidência suficiente pra culpar a instância
//   também — assumir isso por padrão puniria a instância por um erro que
//   pode não ser dela.
const FALHA_TECNICA_RETRYABLE = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'ECONNABORTED', 'ECONNRESET', 'EHOSTUNREACH', 'ENOTFOUND'])

export function classifyEvolutionFailure(err) {
  if (err?.numeroInvalido) {
    return { category: FAILURE_CATEGORY.PERMANENT_RECIPIENT, failureKind: 'permanent_recipient', failoverEligible: false, affectsInstanceHealth: false, mensagem: err.message }
  }

  // Erro de transporte (nenhuma resposta HTTP chegou) — a instância de fato não
  // respondeu, candidato real e único a failover automático.
  if (FALHA_TECNICA_RETRYABLE.has(err.code)) {
    return { category: FAILURE_CATEGORY.TECHNICAL_RETRYABLE, failureKind: 'instance_unavailable', failoverEligible: true, affectsInstanceHealth: true, mensagem: err.message }
  }

  const status = err.response?.status
  if (status === 429) {
    return { category: FAILURE_CATEGORY.RATE_LIMIT, failureKind: 'rate_limit', failoverEligible: false, affectsInstanceHealth: true, mensagem: 'Rate limit (429) — pausar/backoff, nunca trocar de instância pra contornar' }
  }
  if (status === 401 || status === 403) {
    return { category: FAILURE_CATEGORY.AUTH, failureKind: 'auth', failoverEligible: false, affectsInstanceHealth: true, mensagem: err.response?.data?.message || err.message }
  }
  if (status && status >= 500) {
    return { category: FAILURE_CATEGORY.TECHNICAL_RETRYABLE, failureKind: 'instance_unavailable', failoverEligible: true, affectsInstanceHealth: true, mensagem: err.message }
  }
  if (status && status >= 400) {
    // 4xx fora dos códigos explicitamente mapeados acima — pode ser restrição
    // de plataforma (ex: número banido/reportado). Nunca assumido como
    // "só a instância caiu" por padrão — só failover eligible explicitamente.
    return { category: FAILURE_CATEGORY.PLATFORM_RESTRICTION, failureKind: 'platform_restriction', failoverEligible: false, affectsInstanceHealth: false, mensagem: err.response?.data?.message || err.message }
  }

  return { category: FAILURE_CATEGORY.UNKNOWN, failureKind: 'unknown', failoverEligible: false, affectsInstanceHealth: false, mensagem: err.message }
}

// Nome antigo mantido como alias — nenhum chamador existente quebra, mas todo
// código novo (e o próprio dispatchEngine.js) usa classifyEvolutionFailure().
export const classificarErro = classifyEvolutionFailure

// Retorna { ok: true, providerMessageId } ou lança um erro já classificável via
// classificarErro(). Número inválido lança com `.numeroInvalido = true` — o
// dispatchEngine trata isso como falha DEFINITIVA (não tenta próxima instância,
// pois o problema é o dado, não a instância).
// PASSO 34/9 — trava central de homologação: com COLLECTION_TEST_MODE=true,
// NENHUMA mensagem sai para um número fora da allowlist, não importa o que o
// resto do código decida — validação server-side, não confia em nenhuma
// checagem de UI/frontend. `COLLECTION_TEST_PHONE_ALLOWLIST` é uma lista
// separada por vírgula de números de teste explicitamente autorizados.
// FASE C.3A (homologação) — allowlist ausente/vazia sempre bloqueia TUDO
// (fail-closed): allowlist=[] faz .some() retornar false pra qualquer
// número, sem exceção nem caminho de erro possível (leitura síncrona de
// env var não lança).
function verificarAllowlistDeTeste(numero) {
  if (process.env.COLLECTION_TEST_MODE !== 'true') return
  const allowlist = (process.env.COLLECTION_TEST_PHONE_ALLOWLIST || '').split(',').map((n) => n.trim()).filter(Boolean)
  // Comparação por IDENTIDADE real do número (candidatosTelefone), não por
  // substring/endsWith — evita falso-positivo de um allowlist sem DDD
  // batendo com qualquer número de qualquer DDD terminado nos mesmos dígitos.
  const permitido = allowlist.some((permitidoNum) => telefonesEquivalentes(numero, permitidoNum))
  if (!permitido) {
    const erro = new Error(
      `COLLECTION_TEST_MODE=true: número ${mascararTelefone(numero)} não está em COLLECTION_TEST_PHONE_ALLOWLIST — envio bloqueado. ` +
      `Isso é intencional: em homologação, nenhuma mensagem pode sair para um número fora da allowlist, mesmo que haja bug no código chamador.`
    )
    erro.bloqueadoPorTestMode = true
    throw erro
  }
}

// PASSO 10 (homologação) — permite testar failover contra Evolution REAL sem
// desconectar um número de verdade: com COLLECTION_TEST_MODE=true e
// FORCE_EVOLUTION_FAILURE_FOR_TEST listando o(s) instance_name(s) (ou "*" para
// todas), enviarTexto() falha de forma controlada ANTES de qualquer chamada
// HTTP real para essa instância — o dispatchEngine trata como falha técnica
// explícita e tenta a próxima instância saudável, exatamente como aconteceria
// com uma desconexão real. Só tem efeito com COLLECTION_TEST_MODE=true — nunca
// pode ser ligado sem querer em produção.
function verificarFalhaForcadaDeTeste(instancia) {
  if (process.env.COLLECTION_TEST_MODE !== 'true') return
  const lista = (process.env.FORCE_EVOLUTION_FAILURE_FOR_TEST || '').trim()
  if (!lista) return
  const instancias = lista.split(',').map((n) => n.trim())
  if (instancias.includes('*') || instancias.includes(instancia.instance_name)) {
    const erro = new Error(`FORCE_EVOLUTION_FAILURE_FOR_TEST: falha simulada para ${instancia.instance_name} (COLLECTION_TEST_MODE=true) — nenhuma chamada HTTP real foi feita.`)
    erro.response = { status: 503 }
    throw erro
  }
}

export async function enviarTexto(instancia, numero, texto) {
  verificarAllowlistDeTeste(numero)
  verificarFalhaForcadaDeTeste(instancia)
  const client = clientPara(instancia)
  const jidBase = paraJidWhatsapp(numero)

  let jidValido = await existeNoWhatsapp(client, instancia.instance_name, jidBase)
  if (!jidValido) {
    const alternativo = comNonoDigito(jidBase)
    if (alternativo) jidValido = await existeNoWhatsapp(client, instancia.instance_name, alternativo)
  }
  if (!jidValido) {
    const erro = new Error(`Número ${numero} não está registrado no WhatsApp`)
    erro.numeroInvalido = true
    throw erro
  }

  const { data } = await client.post(`/message/sendText/${instancia.instance_name}`, { number: jidValido, text: texto })
  return { ok: true, providerMessageId: data?.key?.id ?? data?.id ?? null, raw: data }
}

export async function consultarEstadoConexao(instancia) {
  const client = clientPara(instancia)
  const { data } = await client.get(`/instance/connectionState/${instancia.instance_name}`)
  return data?.instance?.state ?? data?.state ?? 'unknown'
}

// Normaliza o ACK de mensagem recebido via webhook (evento `messages.update`) para
// o vocabulário interno de status de tentativa. Baseado no mapeamento já usado por
// src/routes/webhook-handler.js (mapStatus) — reaproveita a mesma tabela de códigos
// Baileys (1-5 numérico ou string PENDING/SERVER_ACK/DELIVERY_ACK/READ/PLAYED).
const MAPA_STATUS_EVOLUTION = {
  1: 'sent', PENDING: 'sent',
  2: 'sent', SERVER_ACK: 'sent',
  3: 'delivered', DELIVERY_ACK: 'delivered',
  4: 'read', READ: 'read',
  5: 'read', PLAYED: 'read',
}

export function normalizarStatusAck(statusBruto) {
  return MAPA_STATUS_EVOLUTION[statusBruto] ?? null
}
