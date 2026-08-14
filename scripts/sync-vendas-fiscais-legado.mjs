// Sincroniza o fiscal read model (e01/EN_Notas → notas_fiscais_netvision).
// Roda com `node` direto, mesma limitação de rede do escritório que os
// outros syncs de legado.
//
// Uso:
//   node scripts/sync-vendas-fiscais-legado.mjs --dry-run   (simula)
//   node scripts/sync-vendas-fiscais-legado.mjs             (aplica)
//
// NÃO emite NF, NÃO chama SEFAZ, NÃO toca pedidos/contas_financeiras/nfe —
// só popula notas_fiscais_netvision. Requer a migration
// 20260101000036_notas_fiscais_netvision.sql aplicada primeiro (esta
// branch só cria o arquivo — aplicar em produção é ação separada).
import 'dotenv/config'
import { executarSincronizacaoVendasFiscais } from '../src/jobs/sync-vendas-fiscais-legado.js'

const dryRun = process.argv.includes('--dry-run')

executarSincronizacaoVendasFiscais({ dryRun })
  .then((r) => {
    console.log(`[sync-vendas-fiscais-legado] ${new Date().toISOString()} dry_run=${dryRun}`)
    console.log(`  EN_Notas (NetVision, filial 001): ${r.total_netvision}`)
    console.log(`  ${dryRun ? 'Seriam criadas' : 'Criadas'}: ${r.total_criado}`)
    console.log(`  ${dryRun ? 'Seriam atualizadas' : 'Atualizadas'}: ${r.total_atualizado}`)
    console.log(`  Erros: ${r.total_com_erro || 0}`)
    if (r.amostra_criar?.length) { console.log('\n  Amostra a criar:'); for (const a of r.amostra_criar) console.log('   ', JSON.stringify({ legacy_nfe_id: a.legacy_nfe_id, cfop: a.cfop, cfop_classificacao: a.cfop_classificacao, valor: a.valor_nota, data: a.data_emissao })) }
    if (r.erros?.length) { console.log('\n  Erros:'); for (const e of r.erros) console.log('   ', JSON.stringify(e)) }
    process.exit((r.total_com_erro || 0) > 0 ? 1 : 0)
  })
  .catch((err) => { console.error(`[sync-vendas-fiscais-legado] ERRO: ${err.message}`); process.exit(1) })
