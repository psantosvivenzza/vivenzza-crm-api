import { avaliarProgressoFinanceiro, LIMITE_ENTRADA_BYTES } from './lib/financeiro-progress-health.mjs'

// Recebe SOMENTE um recorte de log por stdin. Não abre arquivos nem inicia sync.
let encerrando = false
function finalizar(resultado, codigo) {
  if (encerrando) return
  encerrando = true
  process.stdin.pause()
  process.stdout.write(JSON.stringify(resultado) + '\n', () => process.exit(codigo))
}
const falhar = () => finalizar({ estado: 'inconclusivo' }, 2)
if (process.argv.length !== 2 || process.stdin.isTTY) {
  falhar()
} else {
const timeout = setTimeout(falhar, 5000)
try {
  const chunks = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    bytes += chunk.length
    if (bytes > LIMITE_ENTRADA_BYTES) { falhar(); break }
    chunks.push(chunk)
  }
  if (!encerrando) {
    const resultado = avaliarProgressoFinanceiro(Buffer.concat(chunks).toString('utf8'))
    finalizar(resultado, resultado.estado === 'ok' ? 0 : resultado.estado === 'inconclusivo' ? 2 : 1)
  }
} catch { falhar() } finally { clearTimeout(timeout) }
}
