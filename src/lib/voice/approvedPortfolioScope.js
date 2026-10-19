import { CAMPAIGN, cents, phoneKey } from '../collection/approvedPortfolio.js'

export function validateVoiceAudit(audit, entries, now = new Date()) {
  const age = now.getTime() - Date.parse(audit?.at)
  const today = now.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
  if (audit?.campaign !== CAMPAIGN || !Number.isFinite(age) || age < 0 || age > 1800000 || audit.today !== today) throw Error('auditoria_expirada')
  if (entries.length !== 120 || new Set(entries.map(e => e.code)).size !== 120 || JSON.stringify(entries) !== JSON.stringify(audit.entries)) throw Error('lista_pdf_divergente')
  if (!Array.isArray(audit.plans) || audit.plans.length !== 120 || new Set(audit.plans.map(p => p.code)).size !== 120 || audit.plans.some(p => !entries.some(e => e.code === p.code))) throw Error('planos_invalidos')
  return audit.plans.filter(p => p.status === 'ready').map(p => p.code)
}

export function voiceWindow(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', weekday: 'short', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(p => [p.type, p.value]))
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(parts.weekday) && Number(parts.hour) >= 9 && Number(parts.hour) < 17
}

export function validateVoiceCandidate(candidate, saved, fresh) {
  if (!saved || saved.status !== 'ready' || fresh?.status !== 'ready' || candidate.codigo_cliente !== saved.code || fresh.code !== saved.code) throw Error('fora_carteira_conciliada')
  if (phoneKey(candidate.telefone) !== saved.phone || fresh.phone !== saved.phone) throw Error('telefone_divergente')
  if (fresh.totalCents !== saved.totalCents || cents(candidate.valor_total) !== fresh.totalCents || candidate.cliente !== fresh.name) throw Error('saldo_ou_cadastro_alterado')
  if (!Array.isArray(saved.accountIds) || !saved.accountIds.length || JSON.stringify(fresh.accountIds) !== JSON.stringify(saved.accountIds)) throw Error('titulos_alterados')
  return true
}
