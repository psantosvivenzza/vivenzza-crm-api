const ETAPAS = new Set(['sincronizacao_completa', 'sincronizacao_incremental', 'conferencia', 'alerta'])
const LIMITE_MS = 10 * 60 * 1000
export const LIMITE_ENTRADA_BYTES = 256 * 1024
const inconclusivo = () => ({ estado: 'inconclusivo' })

// Evidência de conclusão, não de liveness. Nunca lê env, banco ou processos.
export function avaliarProgressoFinanceiro(texto, { agora = Date.now() } = {}) {
  if (typeof texto !== 'string' || Buffer.byteLength(texto) > LIMITE_ENTRADA_BYTES || !Number.isFinite(agora)) return inconclusivo()
  let anterior = -Infinity, ultimoFim = null, pendente = null, ultimaEtapa = null, etapaUltimoFim = null
  const erros = new Set()
  for (const linha of texto.split(/\r?\n/)) {
    if (!linha.trimStart().startsWith('{')) {
      if (linha.includes('financeiro_etapa')) return inconclusivo()
      continue
    }
    let e
    try { e = JSON.parse(linha) } catch {
      if (linha.includes('financeiro_etapa')) return inconclusivo()
      continue
    }
    if (e?.tipo !== 'financeiro_etapa') continue
    const em = typeof e.em === 'string' ? Date.parse(e.em) : NaN
    if (!ETAPAS.has(e.etapa) || !['inicio', 'fim', 'erro'].includes(e.evento) || !Number.isFinite(em) || new Date(em).toISOString() !== e.em || em > agora || em < anterior) return inconclusivo()
    anterior = em
    ultimaEtapa = e.etapa
    if (e.evento === 'inicio') {
      if (pendente) return inconclusivo()
      pendente = { etapa: e.etapa, em }
    } else {
      if (pendente && pendente.etapa !== e.etapa) return inconclusivo()
      pendente = null
      if (e.evento === 'fim') { ultimoFim = em; etapaUltimoFim = e.etapa; erros.delete(e.etapa) }
      else erros.add(e.etapa)
    }
  }
  if (ultimaEtapa === null) return inconclusivo()
  const atraso = (ultimoFim !== null && agora - ultimoFim > LIMITE_MS) || (pendente && agora - pendente.em > LIMITE_MS)
  return {
    estado: erros.size ? 'erro' : atraso ? 'atrasado' : ultimoFim === null ? 'inconclusivo' : 'ok',
    etapa_ultimo_evento: ultimaEtapa,
    etapas_com_erro: [...erros].sort(),
    ...(ultimoFim === null ? {} : { etapa_ultima_conclusao: etapaUltimoFim, ultima_conclusao_em: new Date(ultimoFim).toISOString(), idade_conclusao_ms: Math.round(agora - ultimoFim) }),
    etapa_pendente: pendente !== null,
  }
}
