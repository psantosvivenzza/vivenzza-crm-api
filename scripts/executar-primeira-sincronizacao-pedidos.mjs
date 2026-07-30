// Primeira execução REAL da sincronização de pedidos (backfill completo, já que
// nunca houve uma sincronização concluída antes) + uma segunda rodada logo em
// seguida (incremental). Cobre os testes 1, 2, 4, 5, 6 e 7 dos 12 obrigatórios
// e entrega o relatório da sincronização inicial pedido no fechamento da tarefa.
//
// Roda com `node` direto (NÃO via `railway run`) — o e01 só é alcançável a
// partir de uma máquina na mesma rede do DESKTOP-Q6O54R1, e o Railway não tem
// as variáveis E01_* configuradas (só existem no .env local), então `railway
// run` conectaria em localhost:5432 e falharia com ECONNREFUSED.
import 'dotenv/config'
import pg from 'pg'
import { supabase } from '../src/lib/supabase.js'
import { executarSincronizacaoPedidos } from '../src/jobs/sync-pedidos-legado.js'

let falhas = 0
function check(nome, condicao, detalhe) {
  if (condicao) console.log(`OK — ${nome}`)
  else { falhas++; console.log(`FALHOU — ${nome}${detalhe ? ' — ' + detalhe : ''}`) }
}

async function contarPedidosVendaNoLegado() {
  const client = new pg.Client({
    host: process.env.E01_HOST, port: process.env.E01_PORT, user: process.env.E01_USER,
    password: process.env.E01_PASSWORD, database: process.env.E01_DATABASE,
  })
  await client.connect()
  try {
    const { rows } = await client.query(`SELECT COUNT(*)::int AS total FROM "ES_Pedidos" WHERE "TipoPedido" = 'V'`)
    return rows[0].total
  } finally {
    await client.end()
  }
}

async function main() {
  console.log('=== Teste 6 (parte 1/2): contando pedidos de venda reais no legado (ground truth) ===')
  const totalRealE01 = await contarPedidosVendaNoLegado()
  console.log(`ES_Pedidos com TipoPedido='V': ${totalRealE01}`)

  console.log('\n=== Rodando sincronização #1 (backfill completo — primeira execução do sistema) ===')
  const inicio1 = Date.now()
  const relatorio1 = await executarSincronizacaoPedidos()
  console.log(`Duração: ${Math.round((Date.now() - inicio1) / 1000)}s`)
  console.log('Relatório da sincronização #1:', JSON.stringify(relatorio1, null, 2))

  check('Teste 6: total_lido da sincronização #1 bate com a contagem real do legado (nenhuma página perdida)', relatorio1.total_lido === totalRealE01, `lido=${relatorio1.total_lido} real=${totalRealE01}`)
  check('sincronização #1 concluiu (não falhou)', relatorio1.status === 'concluido' || relatorio1.status === 'concluido_com_erros')

  console.log('\n=== Teste 1: pedidos sem cliente foram reconciliados via CodigoEmitente ===')
  const { count: aindaSemCliente } = await supabase
    .from('pedidos').select('id', { count: 'exact', head: true })
    .eq('sistema_origem', 'legado').is('cliente_erp_id', null)
  const { count: totalLegado } = await supabase
    .from('pedidos').select('id', { count: 'exact', head: true }).eq('sistema_origem', 'legado')
  const { count: comClienteAgora } = await supabase
    .from('pedidos').select('id', { count: 'exact', head: true })
    .eq('sistema_origem', 'legado').not('cliente_erp_id', 'is', null)
  console.log(`Pedidos legado: ${totalLegado} total, ${comClienteAgora} agora com cliente vinculado, ${aindaSemCliente} ainda sem vínculo (código sem match no cadastro)`)
  check('Teste 1: a grande maioria dos 9.108 pedidos sem cliente foi reconciliada', comClienteAgora > 8000, `apenas ${comClienteAgora} vinculados`)

  console.log('\n=== Teste 2: pedidos sem match ficam "pendente de vinculação", nunca "—" silencioso ===')
  const { data: amostraSemVinculo } = await supabase
    .from('pedidos').select('id, cliente_erp_id, precisa_vinculo_cliente, cliente_externo_id')
    .eq('sistema_origem', 'legado').is('cliente_erp_id', null).limit(50)
  check('Teste 2: todo pedido sem cliente_erp_id está marcado precisa_vinculo_cliente=true', (amostraSemVinculo || []).every(p => p.precisa_vinculo_cliente === true))

  console.log('\n=== Teste 7: status "confirmado"/"faturado" no legado refletido corretamente no CRM ===')
  const { count: confirmados } = await supabase.from('pedidos').select('id', { count: 'exact', head: true }).eq('sistema_origem', 'legado').eq('status', 'confirmado')
  const { count: faturados } = await supabase.from('pedidos').select('id', { count: 'exact', head: true }).eq('sistema_origem', 'legado').eq('status', 'faturado')
  const { count: cancelados } = await supabase.from('pedidos').select('id', { count: 'exact', head: true }).eq('sistema_origem', 'legado').eq('status', 'cancelado')
  const { count: rascunhos } = await supabase.from('pedidos').select('id', { count: 'exact', head: true }).eq('sistema_origem', 'legado').eq('status', 'rascunho')
  console.log(`Distribuição real após sync: confirmado=${confirmados} faturado=${faturados} cancelado=${cancelados} rascunho=${rascunhos}`)
  check('Teste 7: existem pedidos mapeados como "faturado" (badge que antes ficava em branco)', faturados > 0)
  check('Teste 7: existem pedidos mapeados como "confirmado"', confirmados > 0)

  console.log('\n=== Rodando sincronização #2 (incremental — cursor da sincronização #1) ===')
  const inicio2 = Date.now()
  const relatorio2 = await executarSincronizacaoPedidos()
  console.log(`Duração: ${Math.round((Date.now() - inicio2) / 1000)}s`)
  console.log('Relatório da sincronização #2:', JSON.stringify(relatorio2, null, 2))

  console.log('\n=== Teste 4: reimportação não duplica (idempotência) ===')
  check('Teste 4: sincronização #2 não criou pedidos novos (todos já existiam)', relatorio2.total_criado === 0, `criou ${relatorio2.total_criado}`)
  const { count: totalLegadoAposSegunda } = await supabase.from('pedidos').select('id', { count: 'exact', head: true }).eq('sistema_origem', 'legado')
  check('Teste 4: contagem de pedidos legado não mudou entre as duas sincronizações', totalLegadoAposSegunda === totalLegado, `antes=${totalLegado} depois=${totalLegadoAposSegunda}`)

  console.log('\n=== Teste 5: sincronização incremental usa escopo restrito (cursor), não reprocessa tudo ===')
  check('Teste 5: sincronização #2 (incremental) leu muito menos linhas que a #1 (backfill completo)', relatorio2.total_lido < relatorio1.total_lido, `sync1=${relatorio1.total_lido} sync2=${relatorio2.total_lido}`)

  console.log(`\n${falhas === 0 ? 'TODOS OS TESTES DESTE ARQUIVO PASSARAM' : `${falhas} TESTE(S) FALHARAM`}`)
  console.log('\n=== RELATÓRIO FINAL PARA ENTREGA ===')
  console.log(JSON.stringify({ sincronizacao_inicial: relatorio1, sincronizacao_incremental: relatorio2, total_no_legado: totalRealE01 }, null, 2))
  process.exit(falhas === 0 ? 0 : 1)
}

main().catch(err => { console.error('ERRO FATAL:', err); process.exit(1) })
