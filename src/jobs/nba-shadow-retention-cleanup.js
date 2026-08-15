// 2026-08-15 — agendamento da limpeza de nba_shadow_log (cleanupNbaShadowLog,
// shadowWriteRepository.js — já existia desde o PR #32, mas nunca era
// chamada por nada). nba_shadow_log é histórico de comparação (motor novo x
// régua antiga ao longo do tempo), não estado atual — cresce continuamente
// enquanto nba_shadow_mode estiver ligado, então precisa de uma janela de
// retenção, mas NUNCA rodando junto com o ciclo de 20min do shadow em si
// (isso apagaria dado que acabou de ser gravado antes de alguém olhar).
//
// Roda no máximo 1x/dia. Só toca nba_shadow_log — nunca scores atuais,
// contas_financeiras, cobrancas_whatsapp, collection_dispatches, timeline
// ou qualquer tabela financeira (cleanupNbaShadowLog só faz DELETE FROM
// nba_shadow_log, nada mais).
import { obterConfigCobranca } from '../lib/collection/featureFlags.js'
import { cleanupNbaShadowLog } from '../lib/collection/shadow/shadowWriteRepository.js'

export async function runNbaShadowRetentionCleanup() {
  const config = await obterConfigCobranca()
  const retentionDays = config.nba_shadow_log_retention_days ?? 90

  const resultado = await cleanupNbaShadowLog({ retentionDays, preview: false })
  console.log('[nba-shadow-retention-cleanup] concluído:', { retentionDays, ...resultado })
  return resultado
}
