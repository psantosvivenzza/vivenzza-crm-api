// IA WhatsApp MVP — fila de jobs pro worker local. O BACKEND decide tudo
// antes de enfileirar: qual mensagem, qual contexto, qual prompt exato. O
// worker (rodando fora do Railway, na máquina com Ollama) só executa
// inferência sobre o que já está pronto aqui.
import { supabase } from '../../supabase-admin.server.js'
import { carregarContextoCliente } from './collectionContext.js'
import { CLASSIFY_SYSTEM_PROMPT } from './intentClassifier.js'
import { construirPromptGeracao } from './replySuggestion.js'

const LEASE_MINUTES = 5

export async function enfileirarJob({ contasFinanceirasId, clienteTelefone, mensagemCliente }) {
  const contexto = await carregarContextoCliente({ contasFinanceirasId })
  const generateSystemPrompt = construirPromptGeracao({ contexto })

  const { data, error } = await supabase.from('ai_jobs').insert({
    contas_financeiras_id: contasFinanceirasId,
    cliente_telefone: clienteTelefone,
    mensagem_cliente: mensagemCliente,
    classify_system_prompt: CLASSIFY_SYSTEM_PROMPT,
    generate_system_prompt: generateSystemPrompt,
    status: 'pending',
  }).select().single()
  if (error) throw error
  return data
}

// Lease com expiração — se o worker cair no meio, o job volta a ficar
// elegível depois de LEASE_MINUTES em vez de ficar preso pra sempre em
// 'leased'. Sempre pega o mais antigo primeiro (FIFO).
//
// Nota: duas queries separadas (pending, depois leased-expirado) em vez de
// um único `.or(...)` — o compat client local do Postgres (testes) não
// implementa esse método do query builder do Supabase-js.
export async function proximoJobDisponivel() {
  const agora = new Date().toISOString()

  const { data: pendentes, error: erroPendentes } = await supabase
    .from('ai_jobs').select('*').eq('status', 'pending').order('criado_em', { ascending: true }).limit(1)
  if (erroPendentes) throw erroPendentes

  let candidato = pendentes?.[0]
  if (!candidato) {
    const { data: expirados, error: erroExpirados } = await supabase
      .from('ai_jobs').select('*').eq('status', 'leased').lt('lease_expires_at', agora).order('criado_em', { ascending: true }).limit(1)
    if (erroExpirados) throw erroExpirados
    candidato = expirados?.[0]
  }
  if (!candidato) return null

  const leaseExpiraEm = new Date(Date.now() + LEASE_MINUTES * 60 * 1000).toISOString()
  const { data: leasedJob, error: erroLease } = await supabase
    .from('ai_jobs')
    .update({ status: 'leased', leased_at: agora, lease_expires_at: leaseExpiraEm, atualizado_em: agora })
    .eq('id', candidato.id)
    .eq('status', candidato.status) // corrida: só confirma o lease se ninguém mais pegou primeiro
    .select()
    .maybeSingle()
  if (erroLease) throw erroLease
  return leasedJob // null se outra chamada concorrente venceu a corrida
}

export async function marcarJobConcluido(jobId, { suggestionId, rawClassifyResponse, rawGenerateResponse }) {
  const { error } = await supabase.from('ai_jobs').update({
    status: 'done',
    suggestion_id: suggestionId,
    raw_classify_response: rawClassifyResponse,
    raw_generate_response: rawGenerateResponse,
    atualizado_em: new Date().toISOString(),
  }).eq('id', jobId)
  if (error) throw error
}

export async function marcarJobFalhou(jobId, { erro, rawClassifyResponse, rawGenerateResponse }) {
  const { error } = await supabase.from('ai_jobs').update({
    status: 'failed',
    erro,
    raw_classify_response: rawClassifyResponse ?? null,
    raw_generate_response: rawGenerateResponse ?? null,
    atualizado_em: new Date().toISOString(),
  }).eq('id', jobId)
  if (error) throw error
}

export async function buscarJob(jobId) {
  const { data, error } = await supabase.from('ai_jobs').select('*').eq('id', jobId).maybeSingle()
  if (error) throw error
  return data
}
