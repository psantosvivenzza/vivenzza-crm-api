import { PG_USER, PG_PASSWORD, PG_PORT, PG_DATABASE } from '../../localdb-config.mjs'

// Exclusão mútua ENTRE PROCESSOS: os testes compartilham estado global no
// Postgres local (sincronizacoes_financeiro, automacoes_config id=1,
// whatsapp_instances). `node --test a.mjs b.mjs` roda os arquivos em paralelo,
// e um apagando/recriando esse estado quebrava o outro. Um advisory lock de
// sessão (conexão dedicada) serializa os arquivos sem enfraquecer nenhum guard;
// é liberado em pararAmbienteDeTeste() ou automaticamente se o processo morrer.
const CHAVE_LOCK_TESTES = 7420019
let clienteLock = null

export async function adquirirLockDeTeste() {
  if (clienteLock) return
  const { default: pg } = await import('pg')
  const c = new pg.Client({ connectionString: `postgres://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${PG_DATABASE}` })
  await c.connect()
  await c.query('SELECT pg_advisory_lock($1)', [CHAVE_LOCK_TESTES])
  clienteLock = c
}

export async function liberarLockDeTeste() {
  if (!clienteLock) return
  const c = clienteLock
  clienteLock = null
  try { await c.query('SELECT pg_advisory_unlock($1)', [CHAVE_LOCK_TESTES]) } finally { await c.end() }
}

