import { supabase } from './supabase-admin.server.js'
import { criarCircuitBreaker, CircuitBreakerAbertoError } from './circuitBreaker.js'
import { comTimeout } from './promiseTimeout.js'

// Timeout fail-fast por tentativa — achado real do incidente de 2026-09-28
// (Cloudflare 522 no host do Supabase, respostas de 90-300s): sem isto, uma
// única tentativa desta RPC podia ficar pendurada pelo tempo que o Supabase
// levasse, e como chamarRpcComRetry faz até 3 tentativas sequenciais, o pior
// caso passava de 300s por webhook — o processo Node ficava "preso"
// respondendo esse webhook, e o prazo de entrega da Evolution API (que espera
// uma resposta rápida) expirava, gerando os "webhooks expirados" do
// incidente. Mesma ideia de LEADS_QUERY_TIMEOUT_MS (routes/leads.js), mas via
// comTimeout() (src/lib/promiseTimeout.js) em vez de `.abortSignal()`: `fn()`
// aqui é chamado tanto em produção (builder real do supabase-js/postgrest-js)
// quanto em teste (mock simples que devolve só uma Promise crua, sem métodos
// encadeáveis — ver scripts/tests/collection/webhook-leads-race-orfaos-20260924.test.mjs)
// — `.abortSignal()` quebraria o segundo caso.
const DISTRIBUICAO_RPC_TIMEOUT_MS = Number(process.env.DISTRIBUICAO_RPC_TIMEOUT_MS) || 8000

// Circuit breaker — complementa o timeout: sem ele, sob uma degradação real
// e prolongada do Supabase, TODO webhook novo ainda pagaria o timeout
// inteiro (8s) x 3 tentativas = até 24s antes de desistir, empilhando
// webhooks concorrentes contra um backend já afogado. Depois de falhas
// consecutivas, abre e rejeita na hora — devolve responsavel_id nulo rápido
// (mesmo fallback que já existia pra qualquer erro) em vez de segurar a
// resposta do webhook.
const breakerDistribuicao = criarCircuitBreaker({
  chave: 'distribuicao-rpc',
  falhasParaAbrir: Number(process.env.DISTRIBUICAO_BREAKER_FALHAS_PARA_ABRIR) || 5,
  cooldownMs: Number(process.env.DISTRIBUICAO_BREAKER_COOLDOWN_MS) || 15000,
  cooldownMaxMs: Number(process.env.DISTRIBUICAO_BREAKER_COOLDOWN_MAX_MS) || 120000,
})

// Retry controlado pra chamadas RPC de distribuição — achado real (investigação
// de leads órfãos, 2026-09-24): antes disso, qualquer falha transiente da RPC
// (pool de conexão sob rajada de webhooks concorrentes, timeout) virava um erro
// logado + retorno null na hora, sem segunda chance — o lead nascia com
// responsavel_id NULL pra sempre. 3 tentativas com backoff curto é suficiente
// pra absorver uma falha passageira sob pico sem represar chamadas por muito
// tempo (nunca "controlado" vira "infinito").
//
// O circuit breaker envolve o LOOP inteiro, não cada tentativa isolada: uma
// vez aberto, as 3 tentativas nem começam — rejeita direto (ver comentário
// acima). Cada tentativa individual passa por comTimeout(), então nenhuma
// trava mais que DISTRIBUICAO_RPC_TIMEOUT_MS.
async function chamarRpcComRetry(fn, { tentativas = 3, atrasoBaseMs = 150 } = {}) {
  try {
    return await breakerDistribuicao.executar(async () => {
      let ultimoErro = null
      for (let tentativa = 1; tentativa <= tentativas; tentativa++) {
        const { data, error } = await comTimeout(fn(), DISTRIBUICAO_RPC_TIMEOUT_MS, 'RPC de distribuição excedeu o tempo limite')
          .catch((erroTimeout) => ({ data: null, error: { message: erroTimeout.message, name: erroTimeout.name } }))
        if (!error) return { data, error: null }
        ultimoErro = error
        if (tentativa < tentativas) {
          await new Promise((resolve) => setTimeout(resolve, atrasoBaseMs * tentativa))
        }
      }
      // Todas as tentativas falharam — conta como falha pro circuit breaker
      // (abre depois de falhas CONSECUTIVAS entre chamadas), mas devolve o
      // formato {data, error} de sempre pro chamador, não lança — quem chama
      // (proximoVendedor/criarOuObterLeadWhatsapp) já trata error != null
      // como "sem distribuição automática" e segue o fluxo sem travar o
      // webhook.
      throw Object.assign(new Error(ultimoErro?.message || 'RPC de distribuição falhou após todas as tentativas'), { supabaseError: ultimoErro })
    })
  } catch (err) {
    if (err instanceof CircuitBreakerAbertoError) {
      return { data: null, error: { message: err.message, code: 'CIRCUIT_OPEN' } }
    }
    return { data: null, error: err.supabaseError ?? { message: err.message } }
  }
}

// Rodízio atômico entre vendedores ativos — ver função proximo_vendedor_atomic()
// no Postgres (lock FOR UPDATE em distribuicao_leads.id=1, evita race condition
// entre chamadas concorrentes). Usado por qualquer fluxo de criação de lead que
// precise de distribuição automática (webhook do WhatsApp, formulário público).
export async function proximoVendedor() {
  const { data, error } = await chamarRpcComRetry(() => supabase.rpc('proximo_vendedor_atomic'))
  if (error) {
    console.error('[distribuicao] proximoVendedor RPC erro (após retries):', error.message)
    return null
  }
  return data?.[0] ?? null
}

// Cria um lead novo de WhatsApp OU devolve o lead existente pro mesmo telefone,
// de forma atômica (função Postgres com advisory lock escopado ao telefone
// canônico — ver supabase/migrations/20260101000074_criar_lead_whatsapp_atomic.sql).
// Corrige o bug real de duplicação (achado 2026-09-24): duas mensagens do mesmo
// contato chegando quase juntas (rajada de reconexão da Evolution API) faziam
// cada chamada concorrente do antigo fluxo (SELECT separado + INSERT separado,
// sem lock nenhum) achar "nenhum lead ainda" e criar um lead duplicado. Nunca
// reatribui responsavel_id de um lead que já existia — `criado: false` no
// retorno indica que outra chamada concorrente venceu a corrida e este lead já
// existia antes desta chamada.
export async function criarOuObterLeadWhatsapp({ candidatos, telefone, nome, origem, campanhaOrigem, ctwaClid }) {
  const { data, error } = await chamarRpcComRetry(() => supabase.rpc('criar_lead_whatsapp_atomic', {
    p_candidatos: candidatos,
    p_telefone: telefone,
    p_nome: nome,
    p_origem: origem,
    p_campanha_origem: campanhaOrigem,
    p_ctwa_clid: ctwaClid,
  }))
  if (error) {
    console.error('[distribuicao] criarOuObterLeadWhatsapp RPC erro (após retries):', error.message)
    return null
  }
  return data?.[0] ?? null
}
