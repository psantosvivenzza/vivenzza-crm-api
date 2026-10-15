// Used only by the exclusive local homologation/preview entry point.
import { createSyntheticCampaignWorkflow } from '../../src/lib/campaignApproval.js'
import { createCampaignProposalStore } from '../../src/lib/campaignProposalStore.js'
export async function initializeSyntheticTargets(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS campaign_review.synthetic_targets(platform text PRIMARY KEY, snapshot jsonb NOT NULL, writes integer NOT NULL DEFAULT 0)`)
  for (const platform of ['meta', 'google']) await db.query(`INSERT INTO campaign_review.synthetic_targets(platform,snapshot) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING`, [platform, JSON.stringify({ status: 'ACTIVE', dailyBudgetMinor: 1000, currency: 'BRL' })])
  await db.query('GRANT SELECT,UPDATE ON campaign_review.synthetic_targets TO service_role')
}
export async function createCampaignReviewSimulation(db) {
  const policy = { maxEvidenceAgeMs: 900_000, maxApprovalAgeMs: 600_000, scopes: ['meta', 'google'].map((platform) => ({ platform, accountId: 'conta-sintetica', campaignIds: [`campanha-${platform}-sintetica`], actions: ['daily_budget'], currency: 'BRL', maxDailyBudgetMinor: 2000, maxBudgetDeltaMinor: 500 })) }
  const adapter = {
    mode: 'synthetic',
    async read(target) {
      const { rows } = await db.query('SELECT snapshot FROM campaign_review.synthetic_targets WHERE platform=$1', [target.platform])
      if (!rows[0]) throw Error('SYNTHETIC_TARGET_MISSING')
      return { ...target, snapshot: rows[0].snapshot }
    },
    async write(target) {
      const r = await db.query('UPDATE campaign_review.synthetic_targets SET snapshot=$2::jsonb,writes=writes+1 WHERE platform=$1', [target.platform, JSON.stringify(target.snapshot)])
      if (r.rowCount !== 1) throw Error('SYNTHETIC_TARGET_MISSING')
    },
  }
  const store = createCampaignProposalStore(db)
  const workflow = createSyntheticCampaignWorkflow({ store, policy, adapter })
  const simulation = async (platform, actor) => {
    const target = { platform, accountId: 'conta-sintetica', campaignId: `campanha-${platform}-sintetica` }
    const { snapshot: before } = await adapter.read(target)
    return workflow.propose({ schemaVersion: 1, ...target, action: 'daily_budget', before, after: { ...before, dailyBudgetMinor: before.dailyBudgetMinor === 1000 ? 1200 : 1000 }, objective: 'Demonstrar revisão humana de orçamento diário', reason: 'Avaliação demonstrativa fixa. Não é recomendação de IA nem usa desempenho real.', evidence: { observedAt: new Date().toISOString(), source: 'fixture local sintética', summary: platform === 'meta' ? 'Exemplo Meta: eventos por família permanecem separados. Nenhuma métrica real consultada.' : 'Exemplo Google: conversões configuradas não equivalem a conversas. Nenhuma métrica real consultada.' }, expiresAt: new Date(Date.now() + 900_000).toISOString() }, actor)
  }
  return { workflow, simulation, store, policy, adapter }
}
