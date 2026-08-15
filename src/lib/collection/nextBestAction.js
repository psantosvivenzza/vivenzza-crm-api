// FASE 5 — NextBestCollectionAction. Decide QUAL ação tomar para um título, com
// reason_codes explícitos — nunca "caixa preta". A régua D-3..D+60 continua sendo a
// CAMADA BASE (calcula a etapa/elegibilidade); o NBA decide o CANAL considerando
// dias + valor + recuperabilidade + prioridade + resposta + promessa + tentativas —
// só quando `next_best_action=true` (senão o chamador usa direto WHATSAPP/régua,
// comportamento idêntico ao pré-reforma).
//
// Saída sempre inclui reason_codes (ex: ['HIGH_VALUE','BROKEN_PROMISE']) — nunca
// decide silenciosamente.
import { supabase } from '../supabase-admin.server.js'
import { calcularEtapa } from '../reguaCobranca.js'
import { diasAtrasoDe } from './collectionContactPolicy.js'
import { promessaAtivaPara } from './promises.js'
import { ultimoRecoveryScore } from './recoveryScore.js'
import { ultimoPriorityScore } from './priorityScore.js'
import { obterConfigCobranca } from './featureFlags.js'
import { buscarRegistroDoNotContact } from './doNotContactGuard.js'

export const ACAO = Object.freeze({
  NO_ACTION: 'NO_ACTION',
  WHATSAPP: 'WHATSAPP',
  AI_WHATSAPP: 'AI_WHATSAPP',
  AI_CALL: 'AI_CALL',
  HUMAN_CALL: 'HUMAN_CALL',
  WAIT_PROMISE: 'WAIT_PROMISE',
  PAYMENT_CHECK: 'PAYMENT_CHECK',
  HUMAN_REVIEW: 'HUMAN_REVIEW',
})

// FASE B.5 (homologação, 2026-08-11) — pedido explícito: parar de misturar
// CANAL (o meio: WhatsApp/ligação/revisão) com EXECUTOR (quem age: automação
// determinística/IA/humano). `acao` (ACAO acima) continua existindo para
// compatibilidade com todo código já escrito contra ela (dispatch, logs,
// relatórios) — mas passa a ser DERIVADA de canal+executor, nunca decidida
// direto. Isso deixa explícito, por exemplo, que HUMAN_CALL e AI_CALL são o
// MESMO canal (CALL) com executor diferente — hoje pareciam ações
// desconectadas.
export const CANAL = Object.freeze({
  NONE: 'NONE',
  WHATSAPP: 'WHATSAPP',
  CALL: 'CALL',
  REVIEW: 'REVIEW',
})

export const EXECUTOR = Object.freeze({
  NONE: 'NONE',
  AUTOMATION: 'AUTOMATION',
  AI: 'AI',
  HUMAN: 'HUMAN',
})

// Cobre as 5 combinações que a árvore de decisão hoje produz. WAIT_PROMISE e
// PAYMENT_CHECK não são canal+executor no mesmo sentido (não escolhem UM meio
// de contato — WAIT_PROMISE é "não fazer nada agora, de propósito", à espera
// de uma data já combinada) — carregarContextoNba() os define diretamente,
// sem passar por esta tabela.
const TABELA_ACAO = {
  [CANAL.NONE]: { [EXECUTOR.NONE]: ACAO.NO_ACTION },
  [CANAL.WHATSAPP]: { [EXECUTOR.AUTOMATION]: ACAO.WHATSAPP, [EXECUTOR.AI]: ACAO.AI_WHATSAPP },
  [CANAL.CALL]: { [EXECUTOR.AI]: ACAO.AI_CALL, [EXECUTOR.HUMAN]: ACAO.HUMAN_CALL },
  [CANAL.REVIEW]: { [EXECUTOR.HUMAN]: ACAO.HUMAN_REVIEW },
}

export function derivarAcao(channel, handler) {
  const acao = TABELA_ACAO[channel]?.[handler]
  if (!acao) throw new Error(`Combinação channel=${channel}/handler=${handler} não mapeada em TABELA_ACAO`)
  return acao
}

// 2026-08-15 — leitura extraída para doNotContactGuard.js (mesma query,
// reusada agora também pelo guard do caminho real de envio) — comportamento
// deste shadow preservado 100%: silenciosamente trata erro de consulta como
// "não está em opt-out" (fail-open), igual a antes. O guard real usa a MESMA
// função de leitura mas fail-closed (bloqueia em caso de erro) — ver
// doNotContactGuard.js/estaEmDoNotContact.
async function estaEmOptOut(clienteTelefone) {
  if (!clienteTelefone) return false
  const { data } = await buscarRegistroDoNotContact(clienteTelefone)
  return (data?.length ?? 0) > 0
}

async function houvePromessaQuebrada(contasFinanceirasId) {
  const { data } = await supabase
    .from('collection_promises')
    .select('id')
    .eq('contas_financeiras_id', contasFinanceirasId)
    .eq('status', 'quebrada')
    .limit(1)
  return (data?.length ?? 0) > 0
}

// FASE B.4 (homologação) — extraído de decidirProximaAcao() pra ser reusado por
// nextBestActionShadow.js (NBA shadow canal-agnóstico) SEM duplicar os
// early-exits/leituras de banco em dois lugares que poderiam divergir sobre
// QUEM é elegível pra cobrança. `decidirProximaAcao()` abaixo é só um caso
// específico disto (config REAL) — comportamento/saída 100% inalterados.
// `recovery`/`priority` opcionais (FASE B.5) — quando fornecidos, pulam
// ultimoRecoveryScore()/ultimoPriorityScore() (leitura do último score
// PERSISTIDO) e usam o valor recebido direto. Existe pra simulação de
// carteira inteira (scripts/analysis) poder calcular score em memória com
// calcularRecoveryScore()/calcularPriorityScore() SEM persistir nada e ainda
// assim alimentar a árvore de decisão real — sem isso, qualquer conta sem
// score já salvo simplesmente cairia nos ramos "sem score" (recovery/priority
// null), o que mascararia a carteira inteira atrás de UMA amostra de 50 já
// pontuada. Chamada normal (decidirProximaAcao/avaliarNbaShadow em produção)
// não passa nada aqui — comportamento 100% igual a antes.
export async function carregarContextoNba(contasFinanceirasId, { recovery: recoveryInjetado, priority: priorityInjetado } = {}) {
  const { data: titulo, error } = await supabase
    .from('contas_financeiras')
    .select('*')
    .eq('id', contasFinanceirasId)
    .single()
  if (error) throw error

  const saldo = Number(titulo.valor || 0) - Number(titulo.valor_pago || 0)
  if (saldo <= 0) return { encerrado: { acao: ACAO.NO_ACTION, channel: CANAL.NONE, handler: EXECUTOR.NONE, reason_codes: ['TITULO_QUITADO'] } }
  if (titulo.status === 'cancelada') return { encerrado: { acao: ACAO.NO_ACTION, channel: CANAL.NONE, handler: EXECUTOR.NONE, reason_codes: ['TITULO_CANCELADO'] } }
  if (titulo.em_revisao_financeira) return { encerrado: { acao: ACAO.HUMAN_REVIEW, channel: CANAL.REVIEW, handler: EXECUTOR.HUMAN, reason_codes: ['EM_REVISAO_FINANCEIRA'] } }

  if (await estaEmOptOut(titulo.telefone_cobranca)) {
    return { encerrado: { acao: ACAO.NO_ACTION, channel: CANAL.NONE, handler: EXECUTOR.NONE, reason_codes: ['OPT_OUT'] } }
  }

  const promessa = await promessaAtivaPara(contasFinanceirasId)
  if (promessa) return { encerrado: { acao: ACAO.WAIT_PROMISE, channel: CANAL.NONE, handler: EXECUTOR.AUTOMATION, reason_codes: ['PROMESSA_ATIVA'], promessa } }

  const diasAtraso = diasAtrasoDe(titulo.vencimento)
  const etapa = calcularEtapa(diasAtraso)
  if (etapa === null) return { encerrado: { acao: ACAO.NO_ACTION, channel: CANAL.NONE, handler: EXECUTOR.NONE, reason_codes: ['FORA_DA_REGUA'] } }

  if (!titulo.telefone_cobranca) return { encerrado: { acao: ACAO.HUMAN_REVIEW, channel: CANAL.REVIEW, handler: EXECUTOR.HUMAN, reason_codes: ['SEM_TELEFONE'] } }

  const [recoveryLido, priorityLido, teveQuebra] = await Promise.all([
    recoveryInjetado !== undefined ? Promise.resolve(recoveryInjetado) : ultimoRecoveryScore(contasFinanceirasId),
    priorityInjetado !== undefined ? Promise.resolve(priorityInjetado) : ultimoPriorityScore(contasFinanceirasId),
    houvePromessaQuebrada(contasFinanceirasId),
  ])
  const recovery = recoveryLido
  const priority = priorityLido

  const reasonCodes = []
  if (priority?.score >= 70) reasonCodes.push('HIGH_PRIORITY')
  if (priority?.componentes?.valor_divida?.valor >= priority?.componentes?.valor_divida?.maximo * 0.7) reasonCodes.push('HIGH_VALUE')
  if (teveQuebra) reasonCodes.push('BROKEN_PROMISE')
  if (recovery?.score >= 70) reasonCodes.push('HIGH_RECOVERABILITY')
  if (recovery?.score != null && recovery.score < 30) reasonCodes.push('LOW_RECOVERABILITY')
  if (etapa >= 7) reasonCodes.push('LATE_STAGE')
  if (!reasonCodes.length) reasonCodes.push('ROTINA_REGUA')

  return { encerrado: null, recovery, priority, teveQuebra, etapa, diasAtraso, reasonCodes, titulo }
}

// Árvore de decisão determinística — nenhuma parte é aprendida/inferida por IA.
// `config` decide os 3 canais condicionais (ai_voice_calls/human_call_alerts/
// ai_whatsapp); decidirProximaAcao() passa a config REAL (gate de execução),
// nextBestActionShadow.js passa uma config canal-agnóstica (todos "true").
// Retorna channel+handler (FASE B.5) — `acao` é sempre derivada dos dois via
// derivarAcao(), nunca escolhida direto, pra não reintroduzir o acoplamento
// que este trabalho existe pra remover.
export function escolherCanalNba({ config, teveQuebra, priority, recovery, etapa, reasonCodes }) {
  if (teveQuebra && priority?.score >= 60 && config.ai_voice_calls) {
    const channel = CANAL.CALL
    const handler = EXECUTOR.AI
    return { channel, handler, acao: derivarAcao(channel, handler), reason_codes: reasonCodes }
  }
  // FASE B.5 (homologação, 2026-08-11) — threshold configurável (era 80
  // hardcoded; calibração com a carteira elegível completa em produção,
  // 1.108 contas, mostrou máximo real de priority = 69 — 80 nunca era
  // atingido, então HUMAN_CALL nunca existia na prática, nem no shadow. 65
  // veio de dados reais (ver DEPLOY_PLAN/relatório B.5), não é arbitrário.
  // Muda só a RECOMENDAÇÃO: `config.human_call_alerts` continua sendo o
  // único gate de execução real — reduzir o threshold não liga ligação
  // nenhuma sozinho.
  if (etapa >= 7 && priority?.score >= config.human_call_priority_threshold && config.human_call_alerts) {
    const channel = CANAL.CALL
    const handler = EXECUTOR.HUMAN
    return { channel, handler, acao: derivarAcao(channel, handler), reason_codes: [...reasonCodes, 'REQUER_ATENCAO_HUMANA'] }
  }
  if (recovery?.score != null && recovery.score < 20 && etapa >= 7) {
    // Baixíssima recuperabilidade + estágio avançado: continuar insistindo via
    // automação tem baixo retorno — melhor revisão humana (ex: negativação,
    // encerramento de relação comercial) do que mais mensagens automáticas.
    const channel = CANAL.REVIEW
    const handler = EXECUTOR.HUMAN
    return { channel, handler, acao: derivarAcao(channel, handler), reason_codes: [...reasonCodes, 'BAIXA_RECUPERABILIDADE_ESTAGIO_AVANCADO'] }
  }
  if (config.ai_whatsapp) {
    const channel = CANAL.WHATSAPP
    const handler = EXECUTOR.AI
    return { channel, handler, acao: derivarAcao(channel, handler), reason_codes: reasonCodes }
  }
  const channel = CANAL.WHATSAPP
  const handler = EXECUTOR.AUTOMATION
  return { channel, handler, acao: derivarAcao(channel, handler), reason_codes: reasonCodes }
}

// `contexto` opcional (2026-08-15, effective_legacy_action) — permite ao
// shadow calcular carregarContextoNba() UMA vez e reusar tanto para o
// effective_legacy_action (guards) quanto para a decisão NBA em si, sem ler o
// título duas vezes por ciclo. Chamada normal (sem 2º argumento) continua
// carregando o contexto internamente — comportamento 100% igual a antes.
export async function decidirProximaAcao(contasFinanceirasId, { contexto: contextoInjetado } = {}) {
  const contexto = contextoInjetado ?? await carregarContextoNba(contasFinanceirasId)
  if (contexto.encerrado) return contexto.encerrado

  const config = await obterConfigCobranca()
  const { acao, reason_codes } = escolherCanalNba({ config, ...contexto })
  return { acao, reason_codes, etapa: contexto.etapa, diasAtraso: contexto.diasAtraso }
}

// Ranking da fila diária — não pega os N primeiros cronologicamente (comportamento
// antigo, "arbitrário" segundo a auditoria); ordena por priority_score DESC entre
// os elegíveis. Usado pelo job v2 (collection-engine.js) quando priority_score=true.
export function ordenarPorPrioridade(candidatos) {
  return [...candidatos].sort((a, b) => (b.priorityScore ?? 0) - (a.priorityScore ?? 0))
}
