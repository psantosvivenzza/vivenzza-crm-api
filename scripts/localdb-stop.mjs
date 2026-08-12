// npm run db:local:stop — para SOMENTE o cluster local configurado em
// LOCAL_PG_DATA (via pg_ctl stop, que só sinaliza o postmaster dono desse
// data directory específico). Nunca usa taskkill/kill genérico por nome de
// processo — isso poderia atingir outro Postgres na máquina (ex: um serviço
// Windows instalado separadamente), o que nunca é a intenção aqui.
import { execFileSync } from 'child_process'
import { PG_CTL_BIN, PG_DATA } from './localdb-config.mjs'

try {
  console.log(execFileSync(PG_CTL_BIN, ['-D', PG_DATA, 'stop'], { encoding: 'utf8' }))
} catch (err) {
  console.log('[db:local:stop]', err.message)
}
