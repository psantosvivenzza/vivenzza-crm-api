const timezone = 'America/Sao_Paulo'
const money = value => Number.isFinite(Number(value)) ? Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : 'indisponível'
export function directionSummaryDay(now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(x => [x.type, x.value]))
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) }
}
export function formatDirectionSummary(data) {
  if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(data.day || '')) throw Error('SUMMARY_INVALID')
  const receipts = data.receipts_available ?? data.finance_available
  const forecast = data.forecast_available ?? data.finance_available
  for (const [available, fields] of [[data.sales_available, ['sales_day','sales_month']], [receipts, ['received_day','settled_titles']], [forecast, ['due_next_day','due_next_count']]]) {
    if (available === true && fields.some(key => data[key] == null || typeof data[key] === 'boolean' || !Number.isFinite(Number(data[key])))) throw Error('SUMMARY_VALUES_UNAVAILABLE')
  }
  return [
    `Resumo da direção — ${data.day.split('-').reverse().join('/')} · posição das 18h (Brasília)`,
    'Vendas gerenciais · filial 001 (mesma fonte do painel; não somar documentos fiscais novamente):',
    `Hoje: ${data.sales_available ? money(data.sales_day) : 'indisponível — sincronização não confirmada'}`,
    `Mês até hoje: ${data.sales_available ? money(data.sales_month) : 'indisponível — sincronização não confirmada'}`,
    'Financeiro:',
    `Recebimentos com data de pagamento hoje: ${receipts ? money(data.received_day) : 'indisponível — cobertura dos pagamentos ainda não comprovada'}`,
    `Títulos quitados com recebimento hoje: ${receipts ? data.settled_titles : 'indisponível — cobertura dos pagamentos ainda não comprovada'}`,
    `A receber no próximo dia (${data.next_day}): ${forecast ? money(data.due_next_day) : 'indisponível — sincronização dos títulos não confirmada'}`,
    `Títulos a vencer no próximo dia: ${forecast ? data.due_next_count : 'indisponível'}`,
    'Previsão considera o saldo aberto dos títulos no próximo dia do calendário; não é recebimento garantido. Este resumo considera a posição das 18h; movimentações posteriores não estão incluídas.',
  ].join('\n')
}

export function createDailySnapshotReader({ salesStatus, financeStatus, read }) {
  return async day => {
    const [sales,finance,data] = await Promise.allSettled([Promise.resolve().then(salesStatus),Promise.resolve().then(financeStatus),Promise.resolve().then(()=>read(day))])
    if (data.status !== 'fulfilled' || !data.value) throw Error('DIRECTION_STORAGE_FAILED')
    return { ...data.value,
      sales_available: sales.status==='fulfilled' && sales.value?.disponivel===true,
      forecast_available: finance.status==='fulfilled' && finance.value?.allowed===true && finance.value?.reason!=='guard_desabilitado',
      receipts_available:false, finance_available:false }
  }
}

// Persistent claim precedes provider I/O. Uncertain outcomes are never retried.
export function createDailyDirectionJob({ enabled, ready = async () => true, snapshot, claim, send, finish, now = () => new Date() }) {
  return async function run() {
    if (await enabled() !== true) return { status: 'disabled' }
    const time = directionSummaryDay(now())
    if (time.hour !== 18) return { status: 'outside_window' }
    if (await ready() !== true) return { status: 'sender_not_ready' }
    const data = await snapshot(time.day)
    if (data?.day !== time.day) throw Error('SUMMARY_DAY_MISMATCH')
    const text = formatDirectionSummary(data)
    const reservation = await claim(time.day)
    if (!reservation) return { status: 'already_reserved' }
    let result
    try { result = await send(text) }
    catch { await finish(reservation.id, 'uncertain', null); return { status: 'uncertain' } }
    if (!result?.providerMessageId) { await finish(reservation.id, 'uncertain', null); return { status: 'uncertain' } }
    await finish(reservation.id, 'sent', result.providerMessageId)
    return { status: 'sent' }
  }
}
