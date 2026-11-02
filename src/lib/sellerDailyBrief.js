import { directionSummaryDay } from './directionDailySummary.js'

const STAGES = ['novo', 'contato', 'proposta', 'negociacao']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NOTES = [
  'Meta grande pede ação concreta. Escolha as oportunidades prioritárias, combine o próximo passo e execute com disciplina.',
  'Quem vende bem entende antes de oferecer. Faça boas perguntas e mostre como o produto atende à necessidade do cliente.',
  'Resultado se constrói nos combinados cumpridos. Retorne no prazo, acompanhe a proposta e registre o avanço real no CRM.',
  'Foque no que está ao seu alcance: preparação, atenção ao cliente e qualidade de cada conversa.',
  'Pense grande sem pular etapas. Transforme a meta do mês em prioridades claras para o trabalho de hoje.',
  'Uma objeção pede investigação, não pressão. Entenda a dúvida e responda com clareza, honestidade e conhecimento do produto.',
  'Explique o valor da solução com clareza. Respeite as condições comerciais e nunca prometa o que não pode entregar.',
  'Faturamento, margem e dinheiro recebido são coisas diferentes. Busque uma venda saudável e mantenha os registros corretos.',
  'Aprender também faz parte de vender. Reveja uma conversa, identifique um ponto de melhoria e pratique na próxima oportunidade.',
  'Consistência vence a empolgação passageira. Cuide dos retornos todos os dias e respeite o tempo e a decisão de cada cliente.',
  'Trabalhe com visão de longo prazo. Uma venda precisa fazer sentido para o cliente e fortalecer a confiança na empresa.',
  'Tenha iniciativa para destravar oportunidades. Quando faltar informação ou apoio, envolva a equipe e defina uma ação possível.',
  'Organização libera energia para vender. Priorize a carteira, prepare o atendimento e acompanhe cada compromisso assumido.',
  'Reconheça os avanços reais e aprenda com o processo. Compartilhe com a equipe uma prática que ajudou o cliente a decidir com segurança.',
]

export function sellerBriefPeriods(now) {
  const time = directionSummaryDay(now)
  const toStart = day => {
    const target = Date.parse(day + 'T00:00:00Z')
    let value = target
    for (let n = 0; n < 3; n++) {
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value)).map(x => [x.type, x.value]))
      const shown = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second))
      if (shown === target) return new Date(value).toISOString()
      value += target - shown
    }
    throw Error('SELLER_DAY_UNCONFIRMED')
  }
  const tomorrow = new Date(Date.parse(time.day + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10)
  return { ...time, start: toStart(time.day), end: toStart(tomorrow), month: toStart(time.day.slice(0, 7) + '-01') }
}

function phone(value) {
  if (typeof value !== 'string') return null
  const digits = value.replace(/\D/g, '')
  const result = /^\d{10,11}$/.test(digits) ? '55' + digits : digits
  return /^55[1-9]\d{9,10}$/.test(result) ? result : null
}
function aliases(number) {
  const local = number.slice(2)
  return local.length === 11 && local[2] === '9' ? [number, '55' + local.slice(0, 2) + local.slice(3)] : [number]
}

export function selectCommercialRecipient(value, directionNumber) {
  const recipient = phone(value), own = phone(directionNumber)
  if (!recipient || !own || aliases(recipient).some(key => aliases(own).includes(key))) throw Error('COMMERCIAL_RECIPIENT_UNCONFIRMED')
  return recipient
}

export function activeSellerIds(rows) {
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > 100) throw Error('SELLER_TEAM_UNCONFIRMED')
  const ids = rows.map(row => {
    if (!row || !UUID.test(row.id || '') || row.role !== 'vendedor' || row.ativo !== true) throw Error('SELLER_TEAM_UNCONFIRMED')
    return row.id
  })
  if (new Set(ids).size !== ids.length) throw Error('SELLER_TEAM_UNCONFIRMED')
  return ids
}

export function createSellerBriefReader(db) {
  const checked = async query => {
    const result = await query.abortSignal(AbortSignal.timeout(10000))
    if (result.error || !Number.isSafeInteger(result.count) || result.count < 0) throw Error('SELLER_METRICS_UNCONFIRMED')
    return result.count
  }
  const count = table => db.from(table).select('id', { count: 'exact', head: true })
  return {
    async sellers() {
      const result = await db.from('usuarios').select('id,role,ativo').eq('role', 'vendedor').eq('ativo', true).order('id').limit(101).abortSignal(AbortSignal.timeout(10000))
      if (result.error) throw Error('SELLER_RECIPIENTS_UNCONFIRMED')
      return result.data
    },
    async metrics(ids, period, now) {
      if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(id => !UUID.test(id || '')) || new Set(ids).size !== ids.length) throw Error('SELLER_TEAM_UNCONFIRMED')
      const stages = await Promise.all(STAGES.map(stage => checked(count('leads').in('responsavel_id', ids).eq('etapa', stage))))
      const [stale, overdue, due, closed, invoiced, unclassified] = await Promise.all([
        checked(count('leads').in('responsavel_id', ids).eq('etapa', 'novo').or('campanha_origem.is.null,campanha_origem.neq.site_volte10_20261023').gte('created_at', new Date(now.getTime() - 7 * 86400000).toISOString()).lt('created_at', new Date(now.getTime() - 2 * 3600000).toISOString())),
        checked(count('tarefas').in('responsavel_id', ids).eq('status', 'pendente').lt('prazo', period.start)),
        checked(count('tarefas').in('responsavel_id', ids).eq('status', 'pendente').gte('prazo', period.start).lt('prazo', period.end)),
        checked(count('leads').in('responsavel_id', ids).eq('etapa', 'fechado').gte('fechado_em', period.month).lte('fechado_em', now.toISOString())),
        checked(count('pedidos').in('vendedor_id', ids).eq('status', 'faturado').eq('classificacao_faturamento', 'venda').gte('criado_em', period.month).lte('criado_em', now.toISOString())),
        checked(count('pedidos').in('vendedor_id', ids).eq('status', 'faturado').is('classificacao_faturamento', null).gte('criado_em', period.month).lte('criado_em', now.toISOString())),
      ])
      return { stages: Object.fromEntries(STAGES.map((stage, i) => [stage, stages[i]])), stale, overdue, due, closed, invoiced, unclassified }
    },
  }
}

export function formatSellerBrief(period, metrics, sellerCount) {
  if (!Number.isSafeInteger(sellerCount) || sellerCount < 1 || sellerCount > 100) throw Error('SELLER_TEAM_UNCONFIRMED')
  const numbers = [...STAGES.map(k => metrics?.stages?.[k]), ...['stale','overdue','due','closed','invoiced','unclassified'].map(k => metrics?.[k])]
  if (numbers.some(n => !Number.isSafeInteger(n) || n < 0)) throw Error('SELLER_METRICS_UNCONFIRMED')
  const index = Math.floor(Date.parse(period.day + 'T12:00:00Z') / 86400000) % NOTES.length
  return [
    `Bom dia, equipe! Foco comercial — ${period.day.split('-').reverse().join('/')} · resumo da manhã (Brasília)`,
    '',
    `Carteira dos ${sellerCount} vendedores ativos: ${metrics.stages.novo} em Novo · ${metrics.stages.contato} em Contato · ${metrics.stages.proposta} em Proposta · ${metrics.stages.negociacao} em Negociação.`,
    `Atenção na carteira da equipe: ${metrics.stale} leads recentes criados há mais de 2h estão em Novo.`,
    `Pendências: ${metrics.overdue} tarefas pendentes de dias anteriores · ${metrics.due} para hoje.`,
    `Negócios fechados no CRM neste mês: ${metrics.closed}.`,
    `Pedidos criados neste mês e já faturados: ${metrics.invoiced} classificados como venda · ${metrics.unclassified} sem classificação (conferir).`,
    'Negócios do CRM e pedidos faturados são contagens distintas; não somar como vendas.',
    '',
    `Orientação de hoje: ${NOTES[index]}`,
    'Prioridade: cuide dos retornos, acompanhe propostas e registre somente avanços reais no CRM.',
    'Confira suas prioridades no CRM: https://crm.vivenzzaprofessional.com.br/pipeline',
  ].join('\n')
}

export function createSellerDailyJob({ enabled, reader, notify, directionNumber, commercialNumber, now = () => new Date() }) {
  let running = false
  return async () => {
    if (running) return { status: 'running' }
    running = true
    let confirmed = 0
    try {
      if (await enabled() !== true) return { status: 'disabled' }
      const period = sellerBriefPeriods(now())
      if (period.hour !== 9) return { status: 'outside_window' }
      const recipient = selectCommercialRecipient(commercialNumber(), directionNumber())
      if (await notify.ready() !== true) return { status: 'sender_not_ready' }
      const ids = activeSellerIds(await reader.sellers())
      const fresh = now(), check = sellerBriefPeriods(fresh)
      if (check.day !== period.day || check.hour !== 9) return { status: 'window_closed', confirmed }
      const metrics = await reader.metrics(ids, period, fresh)
      const active = await enabled()
      const end = sellerBriefPeriods(now())
      if (active !== true) return { status: 'disabled_mid_batch', confirmed }
      if (end.day !== period.day || end.hour !== 9) return { status: 'window_closed', confirmed }
      if (selectCommercialRecipient(commercialNumber(), directionNumber()) !== recipient) return { status: 'recipient_changed', confirmed }
      const result = await notify(formatSellerBrief(period, metrics, ids.length), { recipient, key: `commercial-daily:${period.day}` })
      if (result?.status !== 'sent' || typeof result.providerMessageId !== 'string' || !result.providerMessageId) throw Error('SELLER_DELIVERY_UNCONFIRMED')
      confirmed = 1
      return { status: 'complete', recipients: 1, sellers: ids.length, confirmed }
    } catch { return { status: 'unconfirmed', confirmed } }
    finally { running = false }
  }
}
