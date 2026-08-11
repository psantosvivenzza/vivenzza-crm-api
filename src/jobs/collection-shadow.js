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
// Toda leitura passa por shadowReadRepository (getEligibleAccounts); toda
// escrita própria passa por shadowWriteRepository (persistNbaShadowDecision).
// O cálculo de score em si continua delegado a recoveryScore.js/priorityScore.js
// (módulos compartilhados, já testados, cada um só lê dado financeiro e escreve
// SÓ na própria tabela de score — não duplicado aqui para não divergir da
// implementação usada pelo motor v2 real quando essa fase existir).
import { calcularEtapa } from '../lib/reguaCobranca.js'
import { diasAtrasoDe } from '../lib/collection/collectionContactPolicy.js'
import { calcularEPersistirRecoveryScore } from '../lib/collection/recoveryScore.js'
import { calcularEPersistirPriorityScore } from '../lib/collection/priorityScore.js'
import { decidirProximaAcao } from '../lib/collection/nextBestAction.js'
import { obterConfigCobranca } from '../lib/collection/featureFlags.js'
import { getEligibleAccounts } from '../lib/collection/shadow/shadowReadRepository.js'
import { persistNbaShadowDecision } from '../lib/collection/shadow/shadowWriteRepository.js'

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
  // getEligibleAccounts ordena por id (determinístico) — a mesma amostra de
  // até `limite` contas sempre que rodar sobre o mesmo dado, nunca aleatória
  // (pedido explícito, seção 15).
  const contas = await getEligibleAccounts(limite)

  const resumo = { processados: 0, comScore: 0, comNba: 0, idsProcessados: [] }

  for (const conta of contas) {
    const diasAtraso = diasAtrasoDe(conta.vencimento)
    const etapaLegado = calcularEtapa(diasAtraso)
    const saldo = Number(conta.valor || 0) - Number(conta.valor_pago || 0)
    if (saldo <= 0) continue

    let recoveryScoreValor = null
    if (config.score_shadow_mode) {
      const recovery = await calcularEPersistirRecoveryScore(conta.id)
      const priority = await calcularEPersistirPriorityScore(conta.id, { recoveryScore: recovery.score })
      recoveryScoreValor = recovery.score
      resumo.comScore++

      if (config.nba_shadow_mode) {
        const nba = await decidirProximaAcao(conta.id)
        // "legacy_action": o que a régua ANTIGA realmente faria hoje — puramente
        // baseada em etapa por dias de atraso, sem score/prioridade.
        const legacyAction = etapaLegado === null ? 'NO_ACTION' : 'WHATSAPP'
        await persistNbaShadowDecision({
          contasFinanceirasId: conta.id, nbaSuggestedAction: nba.acao, nbaReasonCodes: nba.reason_codes,
          legacyAction, recoveryScore: recoveryScoreValor, priorityScore: priority.score,
        })
        resumo.comNba++
      }
    }
    resumo.processados++
    resumo.idsProcessados.push(conta.id)
  }

  console.log('[collection-shadow] ciclo concluído:', { ...resumo, idsProcessados: `${resumo.idsProcessados.length} id(s), ver retorno para lista completa` })
  return resumo
}
