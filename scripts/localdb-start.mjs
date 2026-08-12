// npm run db:local:start — sobe o Postgres local (idempotente: se já estiver
// rodando, não faz nada).
//
// Nota operacional (achado real, homologação 2026-08-12): quando este comando
// é lançado como processo filho de um harness/agente que pode ter seu próprio
// console encerrado externamente (ex: uma task em segundo plano cujo processo
// pai é derrubado), o postgres.exe herdado pode receber o mesmo sinal de
// encerramento do console e cair com STATUS_CONTROL_C_EXIT (0x40010004) —
// não é um bug deste script, é uma característica de como processos filhos
// herdam console no Windows. Rodando num terminal normal (desenvolvedor
// interativo, CI), o console persiste e isso não acontece.
import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import path from 'path'
import { PG_CTL_BIN, INITDB_BIN, PSQL_BIN, PG_DATA, PG_LOG, PG_HOST, PG_PORT, PG_USER, PG_PASSWORD, PG_DATABASE } from './localdb-config.mjs'

// Achado real (homologação 2026-08-12): `pg_ctl start` no Windows deixa o
// postgres.exe (processo de vida longa) herdar os handles de stdout/stderr
// do pg_ctl.exe que o lançou. Se capturarmos esse stdout via pipe (o default
// do execFileSync), o pipe NUNCA fecha — postgres.exe continua segurando o
// handle muito depois de pg_ctl.exe já ter saído — e o Node fica esperando
// EOF pra sempre, mesmo com o servidor já pronto e aceitando conexões.
// stdio:'ignore' evita criar qualquer pipe: não há nada pra ficar esperando.
function pgCtlStart(args) {
  execFileSync(PG_CTL_BIN, args, { stdio: 'ignore' })
}

function pgCtl(args) {
  return execFileSync(PG_CTL_BIN, args, { encoding: 'utf8' })
}

function psql(args, opts = {}) {
  return execFileSync(PSQL_BIN, args, { encoding: 'utf8', env: { ...process.env, PGPASSWORD: PG_PASSWORD }, ...opts })
}

// Checkout limpo nunca tem .localdev/pgdata inicializado ainda — pg_ctl start
// exige um data directory já existente (initdb), não cria um sozinho.
// --auth=trust: sem senha exigida pra conectar via loopback — aceitável pra
// um banco que só escuta em 127.0.0.1, nunca exposto à rede, nunca produção.
if (!existsSync(path.join(PG_DATA, 'PG_VERSION'))) {
  console.log('[db:local:start] data directory não inicializado — rodando initdb em', PG_DATA, '...')
  execFileSync(INITDB_BIN, ['-D', PG_DATA, '-U', PG_USER, '-E', 'UTF8', '--auth=trust'], { encoding: 'utf8' })
}

try {
  const status = execFileSync(PG_CTL_BIN, ['-D', PG_DATA, 'status'], { encoding: 'utf8' })
  console.log('[db:local:start] já está rodando:', status.trim())
} catch {
  console.log('[db:local:start] iniciando Postgres local em', PG_DATA, '(porta', PG_PORT + ')...')
  // -o repassa opções direto pro postmaster, sem precisar editar
  // postgresql.conf — garante porta/listen_addresses corretos toda vez,
  // independente do que initdb gerou de default.
  pgCtlStart(['-D', PG_DATA, '-l', PG_LOG, '-o', `-p ${PG_PORT} -c listen_addresses=${PG_HOST}`, 'start'])
  console.log('[db:local:start] servidor iniciado')
}

try {
  psql(['-U', PG_USER, '-h', PG_HOST, '-p', PG_PORT, '-d', 'postgres', '-tAc', `SELECT 1 FROM pg_database WHERE datname='${PG_DATABASE}'`])
} catch {
  // ignora — a checagem abaixo cobre a criação real
}
const existe = psql(['-U', PG_USER, '-h', PG_HOST, '-p', PG_PORT, '-d', 'postgres', '-tAc', `SELECT 1 FROM pg_database WHERE datname='${PG_DATABASE}'`]).trim()
if (existe !== '1') {
  console.log(`[db:local:start] criando database ${PG_DATABASE}...`)
  psql(['-U', PG_USER, '-h', PG_HOST, '-p', PG_PORT, '-d', 'postgres', '-c', `CREATE DATABASE ${PG_DATABASE}`])
}

console.log('[db:local:start] pronto — LOCAL_PG_URL disponível via scripts/localdb-config.mjs')
