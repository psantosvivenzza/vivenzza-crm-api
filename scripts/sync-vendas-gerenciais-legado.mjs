// Sincroniza o read-model GERENCIAL de vendas (EN_NotasRepres -> vendas_gerenciais_netvision).
// Roda com `node` direto, mesma limitação de rede do escritório dos outros syncs de legado.
//
// Uso:
//   node scripts/sync-vendas-gerenciais-legado.mjs --dry-run   (simula)
//   node scripts/sync-vendas-gerenciais-legado.mjs             (aplica)
//
// NÃO emite NF, NÃO chama SEFAZ, NÃO toca pedidos/contas_financeiras/nfe/
// notas_fiscais_netvision — só popula vendas_gerenciais_netvision. Requer a
// migration 20260101000043_vendas_gerenciais_netvision.sql aplicada primeiro.
import 'dotenv/config'
import { executarSincronizacaoVendasGerenciais } from '../src/jobs/sync-vendas-gerenciais-legado.js'

const dryRun = process.argv.includes('--dry-run')

executarSincronizacaoVendasGerenciais({ dryRun })
  .then((r) => {
    console.log(`[sync-vendas-gerenciais-legado] ${new Date().toISOString()} dry_run=${dryRun} periodo=${r.periodo.desde}..${r.periodo.ate}`)
    console.log(`  EN_NotasRepres (NetVision, filial 001): ${r.total_lido}`)
    console.log(`  ${dryRun ? 'Seriam criadas' : 'Criadas'}: ${r.total_criado}`)
    console.log(`  ${dryRun ? 'Seriam atualizadas' : 'Atualizadas'}: ${r.total_atualizado}`)
    console.log(`  Erros: ${r.total_com_erro || 0}`)
    if (r.amostra_criar?.length) { console.log('\n  Amostra a criar:'); for (const a of r.amostra_criar) console.log('   ', JSON.stringify({ legacy_id: a.legacy_id, representante_nome: a.representante_nome, serie: a.serie, valor: a.valor_documento, data: a.data_emissao })) }
    if (r.erros?.length) { console.log('\n  Erros:'); for (const e of r.erros) console.log('   ', JSON.stringify(e)) }
    process.exit((r.total_com_erro || 0) > 0 ? 1 : 0)
  })
  .catch((err) => { console.error(`[sync-vendas-gerenciais-legado] ERRO: ${err.message}`); process.exit(1) })
