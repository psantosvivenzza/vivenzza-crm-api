// Executa UMA rodada real do hard-cap de spend (src/jobs/meta-budget-guard.js)
// contra a Meta/Supabase de produção e imprime um resumo legível — usado pra
// validar manualmente o comportamento em DRY RUN antes de ligar de vez
// (meta_budget_guard_dry_run=false). Não sobrescreve config nenhuma: só lê
// automacoes_config e roda o job, que já respeita enabled/dry_run como estão.
//
// Rodar com as credenciais de produção injetadas, ex:
//   railway run --service vivenzza-crm-api node scripts/rodar-meta-budget-guard-uma-vez.mjs
import 'dotenv/config'
import { runMetaBudgetGuard } from '../src/jobs/meta-budget-guard.js'
import { obterConfigMetaGuard } from '../src/lib/metaBudgetGuardConfig.js'
import { obterTimezoneConta } from '../src/lib/metaAdsGuardClient.js'

const config = await obterConfigMetaGuard()
let timezone = null
let apiStatus = 'OK'
try {
  timezone = await obterTimezoneConta()
} catch (err) {
  apiStatus = `FALHOU (timezone): ${err.message}`
}

const resultado = await runMetaBudgetGuard()

console.log(JSON.stringify({
  config: {
    meta_budget_guard_enabled: config.meta_budget_guard_enabled,
    meta_budget_guard_dry_run: config.meta_budget_guard_dry_run,
    threshold_alert: config.meta_budget_guard_alert_threshold,
    threshold_protection: config.meta_budget_guard_protect_threshold,
    business_hard_target: config.meta_budget_guard_hard_cap,
  },
  timezone,
  api_status: resultado.erro ? `FALHOU: ${resultado.erro} — ${resultado.detalhe}` : apiStatus,
  spend_today: resultado.spend ?? null,
  decision: resultado.nivel ?? (resultado.pulado ? 'PULADO' : resultado.erro ?? null),
  entities_that_would_be_paused: (resultado.pausadasAgora || []).map((p) => p.name),
  reativadas: resultado.reativadas || [],
  overrides_detectados: resultado.overridesDetectados || [],
  resultado_bruto: resultado,
}, null, 2))
