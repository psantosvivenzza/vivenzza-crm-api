// Recebe somente metadados sanitizados do CIM; nunca linhas de comando.
export function interpretarInventarioVoz(saida, agora = Date.now()) {
  try {
    const dados = JSON.parse(saida)
    if (!Number.isSafeInteger(dados?.invisiveis) || dados.invisiveis < 0
      || !Array.isArray(dados.servicos)) return { estado: 'inconclusivo' }
    if (dados.servicos.length === 0) {
      return { estado: dados.invisiveis > 0 ? 'inconclusivo' : 'parado' }
    }
    if (dados.servicos.length !== 1) return { estado: 'inconclusivo' }
    const { pid, criadoEm } = dados.servicos[0]
    if (!Number.isSafeInteger(pid) || pid <= 0 || typeof criadoEm !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/.test(criadoEm)) return { estado: 'inconclusivo' }
    const data = new Date(criadoEm)
    if (!Number.isFinite(data.getTime()) || !Number.isFinite(agora) || data.getTime() > agora
      || data.toISOString().slice(0,19) !== criadoEm.slice(0,19)) return { estado: 'inconclusivo' }
    return { estado: 'identificado', servico: { pid, criadoEm: data } }
  } catch {
    return { estado: 'inconclusivo' }
  }
}
