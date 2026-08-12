// npm run db:local:reset — apaga e recria o database local, aplica o
// baseline local mínimo (scripts/localdb/schema-baseline/ — NUNCA migration
// de produção), depois TODAS as migrations reais em supabase/migrations/ (em
// ordem lexicográfica) e por fim supabase/seed.sql. Ciclo de
// reprodutibilidade: apagar → recriar → baseline → migrations → seed →
// pronto para testes, sempre do zero.
import { execFileSync } from 'child_process'
import { readdirSync } from 'fs'
import { PSQL_BIN, PG_HOST, PG_PORT, PG_USER, PG_PASSWORD, PG_DATABASE, BASELINE_DIR, MIGRATIONS_DIR, SEED_FILE } from './localdb-config.mjs'

// Guarda antes de qualquer DROP: este script só pode atuar sobre um host de
// loopback — nunca sobre uma URL de produção, mesmo que alguém defina
// LOCAL_PG_* de forma equivocada. localdb-config.mjs já hardcoda PG_HOST em
// '127.0.0.1' sem override por env, mas a checagem explícita aqui documenta
// e trava a intenção em vez de depender só disso silenciosamente.
const HOSTS_LOOPBACK_PERMITIDOS = new Set(['127.0.0.1', 'localhost', '::1'])
if (!HOSTS_LOOPBACK_PERMITIDOS.has(PG_HOST)) {
  throw new Error(`localdb-reset recusado: host "${PG_HOST}" não é loopback — este script nunca pode apagar/recriar um banco fora de 127.0.0.1/localhost.`)
}

function psql(args) {
  return execFileSync(PSQL_BIN, args, {
    encoding: 'utf8',
    env: { ...process.env, PGPASSWORD: PG_PASSWORD },
    stdio: ['inherit', 'pipe', 'pipe'],
  })
}

console.log(`[db:local:reset] apagando e recriando ${PG_DATABASE} em ${PG_HOST}:${PG_PORT}...`)
psql(['-U', PG_USER, '-h', PG_HOST, '-p', PG_PORT, '-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${PG_DATABASE}`])
psql(['-U', PG_USER, '-h', PG_HOST, '-p', PG_PORT, '-d', 'postgres', '-c', `CREATE DATABASE ${PG_DATABASE}`])

function aplicarDiretorio(dir, rotulo) {
  const arquivos = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  console.log(`[db:local:reset] aplicando ${arquivos.length} arquivo(s) de ${rotulo}...`)
  for (const arquivo of arquivos) {
    process.stdout.write(`  ${arquivo} ... `)
    try {
      execFileSync(PSQL_BIN, ['-U', PG_USER, '-h', PG_HOST, '-p', PG_PORT, '-d', PG_DATABASE, '-v', 'ON_ERROR_STOP=1', '-f', `${dir}/${arquivo}`], {
        encoding: 'utf8', env: { ...process.env, PGPASSWORD: PG_PASSWORD },
      })
      console.log('ok')
    } catch (err) {
      console.log('FALHOU')
      console.error(err.stdout || err.message)
      process.exit(1)
    }
  }
}

// Baseline PRIMEIRO — cobre o que as migrations reais assumem já existir
// (contas_financeiras, automacoes_config, usuarios) e tabelas que só existem
// em produção via migration nunca espelhada em git.
aplicarDiretorio(BASELINE_DIR, 'baseline local')
// Depois as migrations reais (aditivas, ADD COLUMN IF NOT EXISTS) — mesmas
// que rodam (ou vão rodar) contra produção.
aplicarDiretorio(MIGRATIONS_DIR, 'migrations')

console.log('[db:local:reset] aplicando seed sintético...')
psql(['-U', PG_USER, '-h', PG_HOST, '-p', PG_PORT, '-d', PG_DATABASE, '-v', 'ON_ERROR_STOP=1', '-f', SEED_FILE])

console.log('[db:local:reset] concluído — banco local pronto do zero.')
