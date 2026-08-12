// Configuração central do banco local de desenvolvimento/teste — usado por
// localdb-start.mjs, localdb-reset.mjs, localdb-stop.mjs e pelos testes.
// Ver docs/cobranca-ai/LOCAL_DEVELOPMENT.md para o setup completo.
//
// SYNTHETIC/LOCAL-ONLY: nada aqui aponta pra produção. O banco criado por
// este config escuta exclusivamente em 127.0.0.1 (nunca 0.0.0.0), numa porta
// e database dedicados (padrão 5433/vivenzza_dev), completamente separados
// do Supabase real (que usa DATABASE_URL/SUPABASE_URL, nunca lidos aqui).
import path from 'path'
import { existsSync } from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')

const EH_WINDOWS = process.platform === 'win32'
export function nomeExecutavel(nome) {
  return EH_WINDOWS ? `${nome}.exe` : nome
}

// Resolve o diretório com os binários do PostgreSQL (pg_ctl/psql), nesta ordem:
// 1. LOCAL_PG_BIN explícito (sempre vence, se definido);
// 2. PATH do sistema (se pg_ctl/psql já são executáveis diretos no shell);
// 3. Caminho padrão conhecido de instalação Windows (última tentativa, só
//    nesta plataforma — não existe equivalente universal em Mac/Linux);
// 4. Erro claro instruindo a configurar LOCAL_PG_BIN.
function resolverPgBin() {
  if (process.env.LOCAL_PG_BIN) return process.env.LOCAL_PG_BIN

  const dirsNoPath = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  for (const dir of dirsNoPath) {
    if (existsSync(path.join(dir, nomeExecutavel('pg_ctl'))) && existsSync(path.join(dir, nomeExecutavel('psql')))) {
      return dir
    }
  }

  if (EH_WINDOWS) {
    for (const versao of ['17', '16', '15', '14']) {
      const candidato = `C:\\Program Files\\PostgreSQL\\${versao}\\bin`
      if (existsSync(path.join(candidato, nomeExecutavel('pg_ctl')))) return candidato
    }
  }

  throw new Error(
    'PostgreSQL não encontrado. Defina LOCAL_PG_BIN apontando pro diretório com pg_ctl/psql ' +
    '(ex: LOCAL_PG_BIN="C:\\Program Files\\PostgreSQL\\17\\bin"), ou garanta que pg_ctl/psql estejam no PATH.'
  )
}

export const PG_BIN = resolverPgBin()
export const PG_CTL_BIN = path.join(PG_BIN, nomeExecutavel('pg_ctl'))
export const PSQL_BIN = path.join(PG_BIN, nomeExecutavel('psql'))
export const INITDB_BIN = path.join(PG_BIN, nomeExecutavel('initdb'))

export const PG_DATA = process.env.LOCAL_PG_DATA || path.join(ROOT, '.localdev', 'pgdata')
export const PG_LOG = process.env.LOCAL_PG_LOG || path.join(ROOT, '.localdev', 'pg.log')
export const PG_HOST = '127.0.0.1' // nunca 0.0.0.0 — banco de teste só em loopback
export const PG_PORT = process.env.LOCAL_PG_PORT || '5433'
export const PG_USER = 'postgres'
// Aceitável como default só por ser senha de um Postgres bindado em loopback
// (127.0.0.1), nunca exposto à rede — não é segredo de produção.
export const PG_PASSWORD = process.env.LOCAL_PG_PASSWORD || 'localdev_only_2026'
export const PG_DATABASE = process.env.LOCAL_PG_DATABASE || 'vivenzza_dev'

export const LOCAL_PG_URL = `postgres://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/${PG_DATABASE}`

// BASELINE_DIR — schema mínimo SOMENTE local/teste (nunca migration de
// produção). Aplicado ANTES de MIGRATIONS_DIR no reset: cobre só o que as
// migrations reais (000028/000029/...) assumem já existir (contas_financeiras,
// automacoes_config, usuarios) + tabelas que existem em produção mas nunca
// tiveram migration git-versionada (collection_recovery_scores, nba_shadow_log
// etc — ver docs/cobranca-ai/LOCAL_DEVELOPMENT.md).
export const BASELINE_DIR = path.join(ROOT, 'scripts', 'localdb', 'schema-baseline')
export const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations')
export const SEED_FILE = path.join(ROOT, 'supabase', 'seed.sql')
export const ROOT_DIR = ROOT
