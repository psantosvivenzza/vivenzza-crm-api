const columns = Object.freeze({ lara: 'sdr_ativo', voz: 'voz_ativa', 'financeiro-regua': 'cobranca_whatsapp_ativa', 'reativacao-comercial': 'reativacao_ativa' })
export class AutomationWriteError extends Error {
  constructor(status, message) { super(message); this.status = status }
}
export async function setAutomationConfig({ db, key, body, canEnable, now = () => new Date() }) {
  const column = columns[key]
  if (!column || typeof body?.ativo !== 'boolean' || typeof body?.esperado !== 'boolean'
    || typeof body?.versao !== 'string' || !Number.isFinite(Date.parse(body.versao))) throw new AutomationWriteError(400, 'Informe estado desejado e versão da consulta.')
  if (key === 'financeiro-regua' && body.ativo === true && (typeof canEnable !== 'function' || await canEnable(key) !== true)) throw new AutomationWriteError(409, 'A prontidão da cobrança não foi confirmada. Atualize os diagnósticos antes de habilitar.')
  const { data, error } = await db.from('automacoes_config')
    .update({ [column]: body.ativo, atualizado_em: now().toISOString() })
    .eq('id', 1).eq(column, body.esperado).eq('atualizado_em', body.versao)
    .select(column + ',atualizado_em').maybeSingle().abortSignal(AbortSignal.timeout(10000))
  if (error) throw new AutomationWriteError(503, 'A alteração não pôde ser confirmada. Consulte o estado atual.')
  if (!data) throw new AutomationWriteError(409, 'A configuração mudou. Atualize antes de alterar.')
  return { ativo: data[column], versao: data.atualizado_em }
}
