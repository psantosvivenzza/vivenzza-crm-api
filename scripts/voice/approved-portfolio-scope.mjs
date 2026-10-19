// Adapter privado da carteira autorizada: nenhum originate ou mudança de flag.
import fs from 'node:fs'
import path from 'node:path'
import { entriesFromPdf, crmClient, sourceClient, sourceRows, loadAccounts, reconcile, reportPath } from '../audit-approved-portfolio.mjs'
import { CAMPAIGN } from '../../src/lib/collection/approvedPortfolio.js'
import { validateVoiceAudit, validateVoiceCandidate, voiceWindow } from '../../src/lib/voice/approvedPortfolioScope.js'
import { candidatosTelefone, telefonesEquivalentes } from '../../src/lib/telefone.js'
import { estaEmDoNotContact } from '../../src/lib/collection/doNotContactGuard.js'
import { verificarFrescorSync } from '../../src/lib/collection/financialSyncGuard.js'

export async function openApprovedVoiceScope() {
  if (process.env.VOICE_QUEUE_GENERAL_ENABLED === 'true') throw Error('fila_global_deve_permanecer_desligada')
  const audit = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  const entries = entriesFromPdf()
  const codes = validateVoiceAudit(audit, entries)
  const lock = path.join(path.dirname(reportPath), `${CAMPAIGN}-voice.lock`)
  const fd = fs.openSync(lock, 'wx')
  let source
  const close = async () => { try { if (source) await source.end() } finally { fs.closeSync(fd); fs.unlinkSync(lock) } }
  try {
    const crm = crmClient()
    source = await sourceClient()
    const read = async query => { const r = await query; if (r.error) throw Error('consulta_protecao_voz_falhou'); return r.data || [] }
    return { codes, close,
      // Autorização efêmera exclusiva deste dispatcher: flag persistente continua false.
      flags: config => { if (config.voice_external_enabled !== false) throw Error('voz_global_deve_permanecer_desligada'); return { ...config, voice_external_enabled: true } },
      allowlist: audit.plans.filter(p => p.status === 'ready').map(p => `+${p.phone}`),
      async reserve(candidate) {
      // Revalidar imediatamente antes de reservar/originar. Nenhum dado monetário é escrito.
      validateVoiceAudit(audit, entriesFromPdf())
      if (!voiceWindow()) throw Error('fora_janela_carteira_09_17')
      const sync = await verificarFrescorSync({ ignorarCache: true })
      if (!sync.allowed) throw Error('sync_financeiro_nao_liberado')
      const saved = audit.plans.find(p => p.code === candidate.codigo_cliente)
      const entry = entries.find(e => e.code === candidate.codigo_cliente)
      if (!entry || !codes.includes(entry.code)) throw Error('fora_carteira_conciliada')
      const accounts = await loadAccounts(crm, entries.map(e => e.code))
      const fresh = reconcile(entry, accounts, await sourceRows(source, [entry.code], audit.today), audit.today)
      validateVoiceCandidate(candidate, saved, fresh)
      // O runtime de diálogo atual lê todos os títulos vencidos do cliente.
      // Recusar se ele puder falar dinheiro fora do conjunto conciliado (incluindo anteriores a 2025).
      const dialogueIds = accounts.filter(a => a.codigo_cliente === entry.code && ['aberta', 'vencida'].includes(a.status) && a.vencimento < audit.today).map(a => a.id).sort()
      if (JSON.stringify(dialogueIds) !== JSON.stringify([...fresh.accountIds].sort())) throw Error('contexto_falado_fora_do_escopo')
      if (accounts.some(a => a.codigo_cliente !== entry.code && telefonesEquivalentes(a.telefone_cobranca, candidate.telefone))) throw Error('telefone_compartilhado')
      const promises = await read(crm.from('collection_promises').select('id').in('contas_financeiras_id', accounts.filter(a => a.codigo_cliente === entry.code).map(a => a.id)).eq('status', 'ativa').limit(1))
      if (promises.length) throw Error('promessa_ativa_cliente')
      const dnc = await estaEmDoNotContact(candidate.telefone, ['todos', 'ligacao', 'whatsapp'])
      if (dnc.blocked) throw Error('dnc_ou_quarentena')
      const replies = await read(crm.from('whatsapp_mensagens').select('id').eq('direcao', 'entrada').gte('created_at', new Date(Date.now() - 30 * 86400000).toISOString()).in('telefone', candidatosTelefone(candidate.telefone)).in('instance_name', ['vivenzza-financeiro', 'vivenzza-financeiro-reserva-01', 'vivenzza-financeiro-reserva-02']).limit(1))
      if (replies.length) throw Error('resposta_recente_atendimento_humano')
      // Reserva ANTES do POST: mesmo resultado incerto ou restart não permite nova tentativa.
      if (!voiceWindow()) throw Error('fora_janela_carteira_09_17')
      const claim = await crm.from('integration_events').insert({ provider: 'vivenzza-approved-voice', event_type: 'first_call', external_id: `${CAMPAIGN}:${entry.code}`, payload_hash: CAMPAIGN }).select('id').single()
      if (claim.error) throw Error(claim.error.code === '23505' ? 'ligacao_ja_reservada' : 'falha_reserva_voz')
      return true
    } }
  } catch (err) { await close(); throw err }
}
