// PASSO 19/20 + FASE B.1 (homologação) — CollectionShadowObserver. 100%
// read-only para o cliente: calcula e REGISTRA o que o motor v2 decidiria
// (Score + Next Best Action), mas nunca despacha nada, nunca chama
// enviarComFailover, nunca importa evolutionAdapter/whatsappInstances/
// dispatchEngine/callQueue/operatorAlerts — verificado automaticamente por
// shadow-architecture.test.mjs (inspeciona a árvore real de imports, não só a
// intenção declarada aqui). Roda independente de collection_engine_v2 — pode
// ligar isso em produção sem NENHUM risco de comportamento diferente pro
// cliente, exatamente para comparar "o que o motor novo faria" com "o que a
// régua antiga realmente fez" antes de confiar nele.
//
// Toda leitura passa por shadowReadRepository (getEligibleAccountsRotativo);
// toda escrita própria passa por shadowWriteRepository
// (persistNbaShadowDecision, persistShadowCursor).
// O cálculo de score em si continua delegado a recoveryScore.js/priorityScore.js
// (módulos compartilhados, já testados, cada um só lê dado financeiro e escreve
// SÓ na própria tabela de score — não duplicado aqui para não divergir da
// implementação usada pelo motor v2 real quando essa fase existir).
import { calcularEtapa } from '../lib/reguaCobranca.js'
import { diasAtrasoDe } from '../lib/collection/collectionContactPolicy.js'
import { calcularEPersistirRecoveryScore, ultimoRecoveryScore } from '../lib/collection/recoveryScore.js'
import { calcularEPersistirPriorityScore, ultimoPriorityScore, carregarDistribuicaoSaldos } from '../lib/collection/priorityScore.js'
import { decidirProximaAcao } from '../lib/collection/nextBestAction.js'
import { obterConfigCobranca } from '../lib/collection/featureFlags.js'
import { getEligibleAccountsRotativo } from '../lib/collection/shadow/shadowReadRepository.js'
import { persistNbaShadowDecision, persistShadowCursor } from '../lib/collection/shadow/shadowWriteRepository.js'

export async function runCollectionShadow() {
  const config = await obterConfigCobranca()
  if (!config.nba_shadow_mode && !config.score_shadow_mode) return { pulado: true }

  // PASSO 12/FASE B (homologação) — SHADOW_MAX_CUSTOMERS: amostra controlada
  // para as primeiras rodadas em produção (default 50, pedido explícito do
  // usuário — "não comece analisando 100% da carteira imediatamente"). Ajustar
  // via automacoes_config.shadow_max_customers só com autorização explícita
  // para aumentar a amostra.
  const limite = config.shadow_max_customers ?? 50

  // Achado real (FASE B, shadow-safety.test.mjs) — `em_revisao_financeira=true`
  // (contestação) NÃO é filtrado aqui de propósito: o motor v2 real filtraria
  // isso antes de despachar (dispatchEngine.js), mas o SHADOW existe justamente
  // para observar o que decidirProximaAcao() diria para TODA a carteira
  // elegível, incluindo contas em contestação — que devem aparecer como
  // HUMAN_REVIEW no log, não desaparecer silenciosamente da amostra.
  //
  // 2026-08-15 — rotação por cursor (collection_shadow_cursor): antes disto,
  // ordenar só por id ASC LIMIT sempre pegava as MESMAS ~50 contas de menor
  // UUID, nunca cobria o resto da carteira real (achado, 1.161 títulos em
  // aberto em produção só 50 eram vistos, pra sempre). Determinístico —
  // nunca aleatório (pedido explícito, seção 15) — só avança
  // sequencialmente por id, com wrap-around no fim da carteira ordenada.
  const { contas, proximoCursor } = await getEligibleAccountsRotativo(limite)

  // 2026-08-15 — achado de performance (mesmo já documentado em
  // priorityScore.js:22-30, "~2,6s/conta, ~131s pra 50 contas"): esta função
  // chamava calcularEPersistirPriorityScore sem a distribuição pré-carregada,
  // então cada conta varria a carteira em aberto inteira do zero
  // (carregarDistribuicaoSaldos, paginada) só pra achar o percentil de 1
  // saldo. A otimização já existia na lib (percentilEmDistribuicao) mas não
  // estava conectada aqui — carrega 1x por ciclo, reusa pra todas as contas.
  // Resultado do score é idêntico (mesma fórmula/pesos, só decide de onde vem
  // o percentil — distribuição em memória em vez de nova varredura por
  // conta), ver score-formula-correctness.test.mjs e
  // priority-score-otimizacao.test.mjs para a prova de equivalência. Só
  // carrega se score_shadow_mode estiver ligado — nba_shadow_mode sozinho
  // nunca calcula score (só lê o último persistido), não precisa da carteira.
  const distribuicaoSaldos = config.score_shadow_mode ? await carregarDistribuicaoSaldos() : null

  const resumo = { processados: 0, comScore: 0, comNba: 0, idsProcessados: [] }

  for (const conta of contas) {
    const diasAtraso = diasAtrasoDe(conta.vencimento)
    const etapaLegado = calcularEtapa(diasAtraso)
    const saldo = Number(conta.valor || 0) - Number(conta.valor_pago || 0)
    if (saldo <= 0) continue

    // FASE B.1.2 (homologação, 2026-08-11) — achado real: antes desta correção,
    // o bloco de NBA estava aninhado DENTRO de `if (config.score_shadow_mode)`,
    // então nba_shadow_mode=true com score_shadow_mode=false não fazia
    // ABSOLUTAMENTE NADA (nem lia score persistido, nem calculava NBA) —
    // silenciosamente, sem erro. Corrigido para os dois flags serem
    // independentes: NBA nunca recalcula score, só lê o último já persistido
    // (via ultimoRecoveryScore/ultimoPriorityScore, mesma função que
    // decidirProximaAcao() já usa internamente para a própria decisão — aqui é
    // só para preencher as colunas informativas do log).
    let recoveryScoreValor = null
    let priorityScoreValor = null

    if (config.score_shadow_mode) {
      const recovery = await calcularEPersistirRecoveryScore(conta.id)
      const priority = await calcularEPersistirPriorityScore(conta.id, { recoveryScore: recovery.score, distribuicaoSaldos })
      recoveryScoreValor = recovery.score
      priorityScoreValor = priority.score
      resumo.comScore++
    }

    if (config.nba_shadow_mode) {
      const nba = await decidirProximaAcao(conta.id)
      // "legacy_action": o que a régua ANTIGA realmente faria hoje — puramente
      // baseada em etapa por dias de atraso, sem score/prioridade.
      const legacyAction = etapaLegado === null ? 'NO_ACTION' : 'WHATSAPP'

      if (recoveryScoreValor === null) {
        const ultimoRecovery = await ultimoRecoveryScore(conta.id)
        recoveryScoreValor = ultimoRecovery?.score ?? null
      }
      if (priorityScoreValor === null) {
        const ultimoPriority = await ultimoPriorityScore(conta.id)
        priorityScoreValor = ultimoPriority?.score ?? null
      }

      await persistNbaShadowDecision({
        contasFinanceirasId: conta.id, nbaSuggestedAction: nba.acao, nbaReasonCodes: nba.reason_codes,
        legacyAction, recoveryScore: recoveryScoreValor, priorityScore: priorityScoreValor,
      })
      resumo.comNba++
    }
    resumo.processados++
    resumo.idsProcessados.push(conta.id)
  }

  // Avança o cursor só depois do ciclo inteiro processar (nunca no meio) —
  // se o processo cair a meio caminho, o próximo ciclo REPETE o lote atual
  // em vez de pular contas sem processar (mais seguro: repetir é inofensivo,
  // pular é o que causava a cobertura incompleta original).
  await persistShadowCursor(proximoCursor)
  resumo.proximoCursor = proximoCursor

  console.log('[collection-shadow] ciclo concluído:', { ...resumo, idsProcessados: `${resumo.idsProcessados.length} id(s), ver retorno para lista completa` })
  return resumo
}
