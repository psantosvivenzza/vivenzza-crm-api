import { supabase } from './supabase-admin.server.js'

// Retry controlado pra chamadas RPC de distribuição — achado real (investigação
// de leads órfãos, 2026-09-24): antes disso, qualquer falha transiente da RPC
// (pool de conexão sob rajada de webhooks concorrentes, timeout) virava um erro
// logado + retorno null na hora, sem segunda chance — o lead nascia com
// responsavel_id NULL pra sempre. 3 tentativas com backoff curto é suficiente
// pra absorver uma falha passageira sob pico sem represar chamadas por muito
// tempo (nunca "controlado" vira "infinito").
async function chamarRpcComRetry(fn, { tentativas = 3, atrasoBaseMs = 150 } = {}) {
  let ultimoErro = null
  for (let tentativa = 1; tentativa <= tentativas; tentativa++) {
    const { data, error } = await fn()
    if (!error) return { data, error: null }
    ultimoErro = error
    if (tentativa < tentativas) {
      await new Promise((resolve) => setTimeout(resolve, atrasoBaseMs * tentativa))
    }
  }
  return { data: null, error: ultimoErro }
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
