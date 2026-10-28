// Carteira explicitamente autorizada. Sem I/O, sem alterações no financeiro.
export const CAMPAIGN = 'atrasados-20261019'
const OPEN = new Set(['aberta', 'vencida', 'pago_parcial'])
export const normalizeName = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/\s+/g, ' ').trim()
export function cents(value) {
  const s = String(value)
  if (!/^\d+(?:\.\d{1,2})?$/.test(s)) throw new Error('valor_invalido')
  const [whole, fraction = ''] = s.split('.')
  const n = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  if (!Number.isSafeInteger(n)) throw new Error('valor_invalido')
  return n
}
export function phoneKey(value) {
  let n = String(value || '').replace(/\D/g, '')
  if (n.length === 10 || n.length === 11) n = '55' + n
  if (!/^55[1-9]\d{9,10}$/.test(n)) throw new Error('telefone_invalido')
  return n
}
export function planCustomer(entry, accounts, today) {
  if (!/^\d{6}$/.test(entry.code) || !entry.name) throw new Error('lista_invalida')
  const all = accounts.filter(t => t.codigo_cliente === entry.code)
  const blocked = reason => ({ code: entry.code, name: entry.name, status: 'blocked', reason })
  if (!all.length) return blocked('sem_contas')
  if (all.some(t => normalizeName(t.pessoa_nome) !== normalizeName(entry.name))) return blocked('cadastro_divergente')
  const overdue = all.filter(t => /^\d{4}-\d{2}-\d{2}$/.test(t.vencimento) && t.vencimento >= '2025-01-01' && t.vencimento < today)
  if (overdue.some(t => t.em_revisao_financeira || t.em_revisao)) return blocked('revisao_financeira')
  const payable = overdue.filter(t => OPEN.has(t.status) && cents(t.valor) > cents(t.valor_pago ?? 0))
  if (!payable.length) return blocked('sem_saldo_vencido')
  const identities = new Map()
  const ids = new Set()
  for (const t of payable) {
    if (!t.id || !t.legacy_id) return blocked('titulo_sem_identidade')
    // cr-X-N e 001-X-N são aliases conhecidos do mesmo título, não dois boletos.
    const key = String(t.legacy_id).replace(/^(?:cr|001)-/, '')
    if (identities.has(key) && identities.get(key).id !== t.id) return blocked('alias_financeiro_ambiguo')
    identities.set(key, t)
    ids.add(t.id)
  }
  const unique = [...identities.values()]
  const phones = new Set(unique.map(t => phoneKey(t.telefone_cobranca)))
  if (phones.size !== 1) return blocked('telefone_divergente')
  const totalCents = unique.reduce((sum, t) => sum + cents(t.valor) - cents(t.valor_pago ?? 0), 0)
  if (!Number.isSafeInteger(totalCents) || totalCents <= 0) return blocked('saldo_invalido')
  unique.sort((a, b) => a.vencimento.localeCompare(b.vencimento) || a.id.localeCompare(b.id))
  return { code: entry.code, name: entry.name, status: 'ready', phone: [...phones][0], totalCents,
    accountIds: [...ids].sort(), representative: unique[0].id, due: unique[0].vencimento,
    process: entry.process || null, referred: entry.referred === true, titles: unique.length }
}
export function renderApprovedMessage(plan) {
  if (plan.status !== 'ready') throw new Error('plano_nao_liberado')
  const value = (plan.totalCents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
  const lines = [`Olá, ${plan.name}. Aqui é o Financeiro da Vivenzza.`,
    `Consta saldo vencido de ${value}, referente a ${plan.titles} boleto(s), já considerando os pagamentos registrados. Os boletos que compõem a mesma parcela estão somados neste total.`,
    'Precisamos tratar dessa pendência com prioridade. Você consegue regularizar ou informar uma data e proposta de pagamento? Se já pagou, envie o comprovante para conferência.']
  if (plan.process) {
    if (!/^[\d.-]{12,30}$/.test(plan.process)) throw new Error('processo_invalido')
    lines.push(`Há registro de cobrança judicial no processo ${plan.process}. Uma proposta de acordo será encaminhada ao responsável jurídico para análise. Sem acordo, a cobrança segue pela via judicial, conforme os atos e decisões do processo.`)
  } else if (plan.referred) {
    lines.push('Há registro de encaminhamento ao responsável jurídico. Podemos encaminhar uma proposta de acordo para análise.')
  }
  lines.push('Condições de negociação dependem de aprovação. Financeiro Vivenzza.')
  return lines.join('\n\n')
}
