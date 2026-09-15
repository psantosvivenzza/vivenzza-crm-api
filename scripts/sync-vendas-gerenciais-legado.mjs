// Sincroniza o read-model GERENCIAL de vendas (EN_NotasRepres -> vendas_gerenciais_netvision).
// Roda com `node` direto, mesma limitação de rede do escritório dos outros syncs de legado.
//
// Uso:
//   node scripts/sync-vendas-gerenciais-legado.mjs --dry-run              (simula, mostra inclusive o que seria removido)
//   node scripts/sync-vendas-gerenciais-legado.mjs                        (aplica, reconciliação ligada por padrão)
//   node scripts/sync-vendas-gerenciais-legado.mjs --sem-reconciliacao    (aplica cria/atualiza, mas NUNCA remove órfãos — só pra investigação pontual)
//
// NÃO emite NF, NÃO chama SEFAZ, NÃO toca pedidos/contas_financeiras/nfe/
// notas_fiscais_netvision — só popula vendas_gerenciais_netvision. Requer a
// migration 20260101000043_vendas_gerenciais_netvision.sql aplicada primeiro.
import 'dotenv/config'
import { executarSincronizacaoVendasGerenciais } from '../src/jobs/sync-vendas-gerenciais-legado.js'

const dryRun = process.argv.includes('--dry-run')
const reconciliar = !process.argv.includes('--sem-reconciliacao')

executarSincronizacaoVendasGerenciais({ dryRun, reconciliar })
  .then((r) => {
    console.log(`[sync-vendas-gerenciais-legado] ${new Date().toISOString()} dry_run=${dryRun} reconciliar=${reconciliar} periodo=${r.periodo.desde}..${r.periodo.ate}`)
    console.log(`  EN_NotasRepres (NetVision, filial 001): ${r.total_lido}`)
    console.log(`  ${dryRun ? 'Seriam criadas' : 'Criadas'}: ${r.total_criado}`)
    console.log(`  ${dryRun ? 'Seriam atualizadas' : 'Atualizadas'}: ${r.total_atualizado}`)
    console.log(`  ${dryRun ? 'Seriam removidas (órfãs, fora da origem)' : 'Removidas (órfãs, fora da origem)'}: ${r.total_removido || 0}`)
    if (r.reconciliacao?.motivo_bloqueio) {
      console.log(`  ATENÇÃO: reconciliação bloqueada (${r.reconciliacao.motivo_bloqueio}) — ${r.reconciliacao.candidatos} candidato(s) a remoção NÃO removido(s), revisão manual necessária`)
    }
    console.log(`  Erros: ${r.total_com_erro || 0}`)
    if (r.amostra_criar?.length) { console.log('\n  Amostra a criar:'); for (const a of r.amostra_criar) console.log('   ', JSON.stringify({ legacy_id: a.legacy_id, representante_nome: a.representante_nome, serie: a.serie, valor: a.valor_documento, data: a.data_emissao })) }
    if (r.amostra_remover?.length) { console.log('\n  Amostra a remover (chaves, sanitizado — sem dado pessoal):'); for (const a of r.amostra_remover) console.log('   ', JSON.stringify(a)) }
    if (r.erros?.length) { console.log('\n  Erros:'); for (const e of r.erros) console.log('   ', JSON.stringify(e)) }
    // process.exitCode (não process.exit()) — deixa o event loop esvaziar
    // sozinho antes de sair. Achado real: process.exit() aqui, logo após o
    // pg Pool fechar (finally do job), disparava "Assertion failed:
    // !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c" no Windows —
    // reproduzido 2/2 vezes, sempre DEPOIS do trabalho real já ter
    // terminado certo (dados corretos impressos), mas com exit code não-zero
    // mesmo assim, o que faria o Task Scheduler marcar a execução como
    // falha por engano.
    process.exitCode = (r.total_com_erro || 0) > 0 ? 1 : 0
  })
  .catch((err) => { console.error(`[sync-vendas-gerenciais-legado] ERRO: ${err.message}`); process.exitCode = 1 })
