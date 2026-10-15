import { randomUUID } from 'node:crypto'
import { CampaignApprovalError, createCampaignReviewWorkflow } from './campaignApproval.js'
import { createCampaignProposalStore } from './campaignProposalStore.js'

// Composição de revisão persistente: registra decisões humanas, NUNCA executa.
// Recebe pg já configurado e política do servidor; não lê env, credenciais ou flags
// e não recebe adapter de Ads. Sem composição o router continua respondendo 503.
const fail = (code) => { throw new CampaignApprovalError(code) }

export const MANUAL_SOURCE = 'Registro manual de revisão humana — estado declarado, não verificado no provedor'
export const MANUAL_INPUT_KEYS = ['platform', 'accountId', 'campaignId', 'action', 'before', 'after', 'objective', 'reason', 'observationSummary']

/** Intake mínimo: o navegador descreve a proposta; origem, fonte, horário de
 * observação e validade são definidos aqui, pelo servidor. Não é avaliação IA
 * nem snapshot de provedor e é marcado como não verificado. */
export function createManualProposalIntake({ workflow, policy, clock = () => Date.now() }) {
  if (!workflow || typeof workflow.propose !== 'function') fail('WORKFLOW_OBRIGATORIO')
  return async function registerManualProposal(input, actor) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).sort().join('|') !== [...MANUAL_INPUT_KEYS].sort().join('|')) fail('CONTRATO_INVALIDO')
    if (typeof input.observationSummary !== 'string' || !input.observationSummary.trim()) fail('CONTRATO_INVALIDO')
    const rules = typeof policy === 'function' ? policy() : policy
    const now = clock()
    if (!Number.isSafeInteger(rules?.maxEvidenceAgeMs) || rules.maxEvidenceAgeMs <= 0) fail('POLITICA_INVALIDA')
    return workflow.propose({
      schemaVersion: 2,
      origin: { kind: 'manual', verified: false },
      platform: input.platform, accountId: input.accountId, campaignId: input.campaignId, action: input.action,
      before: input.before, after: input.after, objective: input.objective, reason: input.reason,
      evidence: { observedAt: new Date(now).toISOString(), source: MANUAL_SOURCE, summary: input.observationSummary.trim() },
      expiresAt: new Date(now + rules.maxEvidenceAgeMs).toISOString(),
    }, actor)
  }
}

export function createCampaignReviewComposition({ db, policy, clock = () => Date.now(), id = randomUUID, ...rest } = {}) {
  if ('adapter' in rest) fail('EXECUTOR_NAO_PERMITIDO_EM_REVISAO')
  if (!db || typeof db.query !== 'function') fail('BANCO_OBRIGATORIO')
  if (!policy || (typeof policy !== 'function' && typeof policy !== 'object')) fail('POLITICA_INVALIDA')
  // Cópia congelada: o chamador não altera a política depois da montagem.
  const rules = typeof policy === 'function' ? policy : Object.freeze(structuredClone(policy))
  const workflow = createCampaignReviewWorkflow({ store: createCampaignProposalStore(db), policy: rules, clock, id })
  const intake = createManualProposalIntake({ workflow, policy: rules, clock })
  return Object.freeze({ mode: 'review', workflow, intake })
}
