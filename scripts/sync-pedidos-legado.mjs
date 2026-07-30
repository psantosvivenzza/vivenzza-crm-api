// Executa a sincronização de pedidos com o legado (e01/ES_Pedidos). Roda com
// `node` direto, NUNCA via `railway run` — o e01 só é alcançável a partir de
// uma máquina na mesma rede do DESKTOP-Q6O54R1 (mesma limitação documentada em
// scripts/sync-estoque-e01.js); o Railway não tem rota até lá.
//
// Uso:
//   node scripts/sync-pedidos-legado.mjs
//
// Primeira execução = backfill completo (nunca houve sincronização concluída
// antes). Execuções seguintes = incremental, a partir do cursor da última
// sincronização concluída com sucesso. Pra rodar automaticamente, agende esse
// comando no Task Scheduler do Windows na máquina com acesso ao e01 (ex: a
// cada 30 min).
import 'dotenv/config'
import { executarSincronizacaoPedidos } from '../src/jobs/sync-pedidos-legado.js'

executarSincronizacaoPedidos()
  .then(relatorio => {
    console.log(`[sync-pedidos-legado] ${new Date().toISOString()} —`, JSON.stringify(relatorio))
    process.exit(relatorio.status === 'concluido_com_erros' ? 0 : 0)
  })
  .catch(err => {
    console.error(`[sync-pedidos-legado] ERRO: ${err.message}`)
    process.exit(1)
  })
