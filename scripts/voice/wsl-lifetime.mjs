import { spawn } from 'node:child_process'

// Mantem WSL enquanto ESTE servico vive, sem prazo fixo nem sessao duplicada.
export function manterWslDuranteServico({ platform = process.platform, spawnFn = spawn, host = process } = {}) {
  if (platform !== 'win32') return null
  const child = spawnFn('wsl.exe', ['-d', 'Ubuntu', '-u', 'root', '--', 'sleep', 'infinity'], {
    windowsHide: true, stdio: 'ignore',
  })
  let encerrando = false
  const parar = () => { encerrando = true; child.kill() }
  host.once('exit', parar)
  child.once('error', () => {
    console.error('[voice-ai] WSL_LIFETIME_FAILED: nao posso garantir disponibilidade')
    host.exit(1)
  })
  child.once('exit', () => {
    if (!encerrando) {
      console.error('[voice-ai] WSL_LIFETIME_ENDED: encerrando servico sem conexao garantida')
      host.exit(1)
    }
  })
  return child
}
