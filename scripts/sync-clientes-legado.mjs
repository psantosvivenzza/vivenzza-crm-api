// Executa a sincronização de clientes com o legado (e01/Pessoas, Cliente=1).
// Roda com `node` direto — o e01 só é alcançável a partir de uma máquina na
// rede do escritório, mesma limitação de sync-pedidos-legado.mjs.
//
// Uso:
//   node scripts/sync-clientes-legado.mjs --dry-run   (simula, não grava nada)
//   node scripts/sync-clientes-legado.mjs             (aplica de verdade)
//
// SÓ CRIA clientes que faltam em clientes_erp — nunca atualiza um que já
// existe (ver comentário em src/jobs/sync-clientes-legado.js). Varredura
// completa a cada execução (não incremental) — ~2.048 linhas é pequeno o
// bastante pra não precisar de cursor.
//
// Pra rodar automaticamente ANTES do sync de pedidos (evita pedido apontando
// pra cliente ainda ausente), agende no Task Scheduler do Windows na mesma
// máquina, num horário anterior ao sync-pedidos.bat.
import 'dotenv/config'
import { executarSincronizacaoClientes } from '../src/jobs/sync-clientes-legado.js'

const dryRun = process.argv.includes('--dry-run')

executarSincronizacaoClientes({ dryRun })
  .then((relatorio) => {
    console.log(`[sync-clientes-legado] ${new Date().toISOString()} dry_run=${dryRun}`)
    console.log(`  Pessoas (NetVision, Cliente=1): ${relatorio.total_netvision}`)
    console.log(`  Já existentes em clientes_erp: ${relatorio.total_ja_existente}`)
    console.log(`  ${dryRun ? 'Seriam criados' : 'Criados'}: ${relatorio.total_criado}`)
    console.log(`  Marcados em_revisao (dado incompleto): ${relatorio.total_marcado_revisao}`)
    console.log(`  Erros: ${relatorio.total_com_erro}`)
    if (relatorio.criados.length) {
      console.log(`\n  ${dryRun ? 'Seriam criados' : 'Criados'}:`)
      for (const c of relatorio.criados) console.log(`    ${c.legacy_id}  ${c.razao_social}${c.em_revisao ? '  [EM_REVISAO]' : ''}`)
    }
    if (relatorio.erros.length) {
      console.log('\n  Erros:')
      for (const e of relatorio.erros) console.log(`    ${e.legacy_id}: ${e.mensagem}`)
    }
    process.exit(relatorio.total_com_erro > 0 ? 1 : 0)
  })
  .catch((err) => {
    console.error(`[sync-clientes-legado] ERRO: ${err.message}`)
    process.exit(1)
  })
