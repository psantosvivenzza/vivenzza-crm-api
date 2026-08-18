// CORREÇÃO 2026-08-18 — fonte canônica de "tentativa REAL ao provider": uma
// chamada HTTP de fato feita à Evolution (checagem de existência do número
// e/ou envio), sucesso ou falha. Fecha o gap comprovado (auditoria da
// correção "telefone inválido com múltiplos títulos", PR #48): até aqui,
// TODO contador de rate limit (globalSendLimit.js, whatsappInstances.js,
// cobranca-whatsapp.js) só contava SUCESSO (cobrancas_whatsapp/status
// sent-delivered-read) — uma rajada de falhas (número inválido, timeout,
// 429, etc) nunca consumia nenhum teto, mesmo cada uma sendo uma chamada
// real contra a infraestrutura do provedor.
//
// Fonte: collection_dispatch_attempts, TODOS os status (sending/sent/
// delivered/read/failed/expired/cancelled). Cada linha é exatamente 1
// chamada real ao provider — dispatchEngine.js/registrarTentativa() insere
// a linha IMEDIATAMENTE ANTES de chamar enviarTexto() (evolutionAdapter.js),
// nunca depois. Nenhum guard que bloqueia ANTES do provider (DNC,
// paymentGuard, promessa, sync stale, telefone bloqueado no dia,
// idempotência de título) chega a criar uma linha aqui — já são 0 por
// construção do código, sem filtro extra necessário.
//
// Nunca soma com cobrancas_whatsapp: um envio bem-sucedido do motor v2
// grava as DUAS tabelas pelo MESMO evento (collection_dispatch_attempts via
// dispatchEngine.js, cobrancas_whatsapp via cobranca-whatsapp.js logo após
// enviarCobrancaComRoteamento retornar 'sent') — somar as duas contaria o
// mesmo envio 2x. Por isso a escolha de fonte é EXCLUSIVA por motor, nunca
// aditiva entre as duas tabelas.
//
// GAP CONHECIDO, DELIBERADAMENTE NÃO FECHADO (fora de escopo): com
// multi_whatsapp=false (motor legado, evolutionFinanceiro.js), não existe
// NENHUMA tabela de tentativa — o módulo é um cliente HTTP puro, sem
// dependência de banco por desenho ("Não reaproveita o client de
// whatsapp.js de propósito"). Sem essa infraestrutura, a única fonte
// disponível continua sendo cobrancas_whatsapp (só sucesso) — MESMO
// comportamento de sempre, sem regressão, mas sem fechar o gap E/B/D/E do
// pedido original pro motor legado. Instrumentar evolutionFinanceiro.js com
// um registro de tentativa é uma mudança maior (adiciona I/O de banco a um
// módulo que hoje não tem nenhum) e não diretamente relacionada a este PR —
// avaliar em PR dedicado se o motor legado voltar a ser usado (hoje
// multi_whatsapp=true em produção, motor v2 é quem roda de fato).
//
// `origem` (opcional) filtra por collection_dispatches.origem
// ('cron'|'manual'|'nba') — usado pelo teto histórico específico de cron em
// cobranca-whatsapp.js; ausente, conta TODAS as origens (teto global).
import { supabase } from '../supabase-admin.server.js'
import { obterConfigCobranca } from './featureFlags.js'

export async function contarTentativasReaisDesde({ desde, origem = null }) {
  const config = await obterConfigCobranca()

  if (config.multi_whatsapp !== true) {
    let query = supabase.from('cobrancas_whatsapp').select('id', { count: 'exact', head: true }).gte('data_envio', desde)
    if (origem) query = query.eq('origem', origem)
    const { count, error } = await query
    if (error) throw error
    return count ?? 0
  }

  // purpose='collection' exclui internal_test (homologação, nunca é
  // cobrança de verdade) — mesmo filtro já usado por
  // whatsappInstances.js/contarEnviosReaisHojePorInstancia.
  let queryDispatches = supabase.from('collection_dispatches').select('id').eq('purpose', 'collection').gte('criado_em', desde)
  if (origem) queryDispatches = queryDispatches.eq('origem', origem)
  const { data: dispatches, error: erroDispatches } = await queryDispatches
  if (erroDispatches) throw erroDispatches
  const idsRelevantes = new Set((dispatches ?? []).map((d) => d.id))
  if (!idsRelevantes.size) return 0

  // criado_em (não enviado_em/falhou_em, que ficam NULL até o desfecho
  // final) — sempre populado no INSERT, no exato instante da tentativa.
  const { data: tentativas, error: erroTentativas } = await supabase
    .from('collection_dispatch_attempts')
    .select('id, dispatch_id')
    .gte('criado_em', desde)
  if (erroTentativas) throw erroTentativas

  let total = 0
  for (const t of tentativas ?? []) {
    if (idsRelevantes.has(t.dispatch_id)) total++
  }
  return total
}
