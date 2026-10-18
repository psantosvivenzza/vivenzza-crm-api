const encerrado = proc => proc.exitCode !== null || proc.signalCode !== null

export function aguardarProntidaoLocal(proc, timeoutMs = 15000) {
  if (encerrado(proc)) return Promise.reject(new Error('Serviço local encerrou antes de ficar pronto.'))
  return new Promise((resolve, reject) => {
    let saida = ''
    const finalizar = (erro, token) => {
      clearTimeout(timer)
      proc.stdout.off('data', dados); proc.off('exit', saiu); proc.off('error', falhou)
      erro ? reject(erro) : resolve(token)
    }
    const saiu = () => finalizar(new Error('Serviço local encerrou antes de ficar pronto.'))
    const falhou = () => finalizar(new Error('Não foi possível iniciar o serviço local de teste.'))
    const dados = c => {
      saida += c.toString()
      const token = saida.match(/token de pareamento[^\r\n]*?:[ \t]*(\S+)\r?\n/)
      if (token && saida.includes('escutando em')) finalizar(null, token[1])
    }
    const timer = setTimeout(() => finalizar(new Error('Timeout subindo serviço local de teste.')), timeoutMs)
    proc.stdout.on('data', dados); proc.once('exit', saiu); proc.once('error', falhou)
  })
}

export function encerrarProcessoLocal(proc, timeoutMs = 5000) {
  if (!proc || encerrado(proc)) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const finalizar = erro => {
      clearTimeout(timer); proc.off('exit', saiu); proc.off('error', falhou)
      erro ? reject(erro) : resolve()
    }
    const saiu = () => finalizar()
    const falhou = () => finalizar(new Error('Falha ao encerrar processo local de teste.'))
    const timer = setTimeout(() => finalizar(new Error('Timeout encerrando processo local de teste.')), timeoutMs)
    proc.once('exit', saiu); proc.once('error', falhou)
    try { if (!proc.kill()) falhou() } catch { falhou() }
  })
}
