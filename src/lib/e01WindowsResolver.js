import childProcess from 'node:child_process'
import path from 'node:path'
import { isIPv4 } from 'node:net'

// Código constante: o hostname é dado de ambiente, nunca código PowerShell.
// Sem shell, perfil, credenciais herdadas ou dependência de executável no PATH.
const LOOKUP_SCRIPT = '$ErrorActionPreference="Stop"; @(Resolve-DnsName -Name $env:VIVENZZA_E01_LOOKUP_HOST -Type A -LlmnrNetbiosOnly -QuickTimeout -ErrorAction Stop | Where-Object { $_.IPAddress } | Select-Object -ExpandProperty IPAddress) | ConvertTo-Json -Compress'
const inFlight = new Map()

function unicast(ip) {
  if (typeof ip !== 'string' || !isIPv4(ip)) return false
  const [first, second] = ip.split('.').map(Number)
  return first !== 0 && first !== 127 && first < 224 && !(first === 169 && second === 254)
}

export async function resolverIpv4Windows(nome, { allowedIps = [] } = {}) {
  // Nova configuração opt-in: sem lista explícita não há mudança operacional.
  // LLMNR não autentica servidor; jamais descobrir e confiar em IP arbitrário.
  const allowed = [...new Set(allowedIps.filter(unicast))].sort()
  if (!allowed.length) throw new Error('Resolução Windows não autorizada por IP')
  const key = JSON.stringify([nome, allowed])
  if (inFlight.has(key)) return inFlight.get(key)
  const pending = resolveNative(nome, allowed)
  inFlight.set(key, pending)
  try { return await pending } finally { inFlight.delete(key) }
}

async function resolveNative(nome, allowed) {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const executable = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const stdout = await new Promise((resolve, reject) => {
    childProcess.execFile(executable, ['-NoProfile', '-NonInteractive', '-Command', LOOKUP_SCRIPT], {
      shell: false, windowsHide: true, timeout: 4000, maxBuffer: 16384,
      env: { SystemRoot: systemRoot, WINDIR: systemRoot, VIVENZZA_E01_LOOKUP_HOST: nome },
    }, (error, output) => error ? reject(error) : resolve(output))
  })
  const result = JSON.parse(stdout.replace(/^\uFEFF/, '').trim())
  const addresses = Array.isArray(result) ? result : [result]
  // Rejeitar resposta malformada/IPv6 e múltiplos IPv4 distintos: nunca escolher
  // arbitrariamente uma interface para um banco financeiro.
  if (!addresses.length || addresses.some(ip => !unicast(ip))) {
    throw new Error('Resolução Windows sem IPv4 válido')
  }
  const unique = [...new Set(addresses)]
  if (unique.length !== 1) throw new Error('Resolução Windows ambígua')
  if (!allowed.includes(unique[0])) throw new Error('IPv4 Windows fora da lista permitida')
  return unique[0]
}
