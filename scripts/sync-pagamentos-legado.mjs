// Sincroniza o ledger de eventos de pagamento (e01/CR_PagtoParcial →
// baixas_financeiras, origem='netvision'). Roda com `node` direto, mesma
// limitação de rede do escritório que
// sync-pedidos-legado.mjs/sync-clientes-legado.mjs.
//
// Uso:
//   node scripts/sync-pagamentos-legado.mjs --dry-run   (simula, não grava)
//   node scripts/sync-pagamentos-legado.mjs             (aplica de verdade)
//
// NÃO toca em contas_financeiras, NÃO chama fn_baixar_titulo — só insere
// direto em baixas_financeiras. Requer a migration
// 20260101000035_baixas_financeiras_e_ledger_netvision.sql aplicada
// primeiro (esta branch só cria o arquivo da migration — aplicar em
// produção é uma ação separada, fora do alcance deste script).
import 'dotenv/config'
import { executarSincronizacaoPagamentos } from '../src/jobs/sync-pagamentos-legado.js'

const dryRun = process.argv.includes('--dry-run')

executarSincronizacaoPagamentos({ dryRun })
  .then((r) => {
    console.log(`[sync-pagamentos-legado] ${new Date().toISOString()} dry_run=${dryRun}`)
    console.log(`  CR_PagtoParcial (NetVision): ${r.total_netvision}`)
    console.log(`  Já existentes no ledger: ${r.total_ja_existente}`)
    console.log(`  ${dryRun ? 'Seriam criados' : 'Criados'}: ${r.total_criado}`)
    console.log(`  Sem conta_financeira vinculada (evento fica com contas_financeiras_id=NULL): ${r.total_sem_conta_vinculada}`)
    console.log(`  Erros: ${r.total_com_erro || 0}`)
    if (r.amostra) { console.log('\n  Amostra (dry-run):'); for (const a of r.amostra) console.log('   ', JSON.stringify({ legacy_evento_id: a.legacy_evento_id, contas_financeiras_id: a.contas_financeiras_id, valor: a.valor, data_evento: a.data_evento })) }
    if (r.erros?.length) { console.log('\n  Erros:'); for (const e of r.erros) console.log('   ', JSON.stringify(e)) }
    process.exit((r.total_com_erro || 0) > 0 ? 1 : 0)
  })
  .catch((err) => { console.error(`[sync-pagamentos-legado] ERRO: ${err.message}`); process.exit(1) })
