// Guarda de pre-voo da fila de ligacao.
//
// ACHADO DE 18/09/2026: tres ligacoes cairam em secretaria eletronica e foram
// gravadas como conversa completa, travando esses clientes por 7 dias. Os
// filtros de caixa postal e de alucinacao do Whisper ja existiam e funcionam
// (testados). O que falhou foi mais simples e mais perigoso: o processo do
// servico de voz tinha subido as 10h34 e o codigo dos filtros foi salvo as
// 11h38. O servico estava rodando codigo velho, e ninguem tinha como saber.
//
// Um servico parado tambem nao e obvio: a Nvoip aceita a ligacao, o cliente
// ouve o telefone tocar, atende, e nao tem ninguem do outro lado. Isso e pior
// do que nao ligar.
//
// Este script roda ANTES da fila e recusa a discagem quando:
//   1. o servico de voz nao esta no ar; ou
//   2. o servico esta no ar mas subiu ANTES do arquivo de codigo de voz mais
//      recente - ou seja, esta rodando uma versao que ja nao existe.
//
// Sai com codigo 0 quando pode discar, 1 quando nao pode.
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIR_VOZ = path.join(__dirname, '..', '..', 'src', 'lib', 'voice')

function log(msg) { console.log(`[pre-voo] ${msg}`) }

function processoDoServico() {
  // PowerShell porque so o Win32_Process traz a linha de comando E a hora de
  // inicio juntas; tasklist nao traz nenhuma das duas de forma confiavel.
  const saida = execFileSync('powershell.exe', [
    '-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
    "Where-Object { $_.CommandLine -match 'run-voice-service' } | " +
    "Select-Object -First 1 | ForEach-Object { $_.ProcessId.ToString() + '|' + $_.CreationDate.ToString('o') }",
  ], { encoding: 'utf8', timeout: 30000 }).trim()
  if (!saida) return null
  const [pid, criadoEm] = saida.split('|')
  return { pid: Number(pid), criadoEm: new Date(criadoEm) }
}

function codigoDeVozMaisRecente() {
  let maisRecente = { arquivo: null, em: new Date(0) }
  for (const nome of fs.readdirSync(DIR_VOZ)) {
    if (!nome.endsWith('.js')) continue
    const st = fs.statSync(path.join(DIR_VOZ, nome))
    if (st.mtime > maisRecente.em) maisRecente = { arquivo: nome, em: st.mtime }
  }
  return maisRecente
}

const servico = processoDoServico()
if (!servico) {
  log('SERVICO DE VOZ NAO ESTA NO AR. Nao vou discar: o cliente atenderia e nao teria ninguem do outro lado.')
  log('Para subir: INICIAR-SERVICO-VOZ.ps1 (ou npm run voice:service)')
  process.exit(1)
}

const codigo = codigoDeVozMaisRecente()
if (codigo.arquivo && codigo.em > servico.criadoEm) {
  log(`SERVICO RODANDO CODIGO VELHO. Nao vou discar.`)
  log(`  servico subiu em .....: ${servico.criadoEm.toLocaleString('pt-BR')} (PID ${servico.pid})`)
  log(`  codigo mais recente ..: ${codigo.arquivo} salvo em ${codigo.em.toLocaleString('pt-BR')}`)
  log('  Reinicie o servico de voz para carregar o codigo atual.')
  process.exit(1)
}

log(`servico no ar (PID ${servico.pid}, desde ${servico.criadoEm.toLocaleString('pt-BR')}) e com o codigo atual. Liberado.`)
process.exit(0)
