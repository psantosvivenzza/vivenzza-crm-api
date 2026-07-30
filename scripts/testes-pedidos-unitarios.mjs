// Testes 3, 8 e 10 dos 12 obrigatórios do módulo de Pedidos.
// Não toca o e01 real — usa mapearStatus/processarPedido exportados do job com
// um client e01 falso (stub) e um mapa de clientes vazio, isolando a lógica pura.
import { mapearStatus, processarPedido } from '../src/jobs/sync-pedidos-legado.js'
import { supabase } from '../src/lib/supabase.js'

let falhas = 0
function check(nome, condicao, detalhe) {
  if (condicao) console.log(`OK — ${nome}`)
  else { falhas++; console.log(`FALHOU — ${nome}${detalhe ? ' — ' + detalhe : ''}`) }
}

const e01Stub = { query: async () => ({ rows: [] }) } // sem itens, não precisamos de produtos aqui

async function main() {
  // ── Teste 8: status desconhecido não vira 'rascunho' silencioso ──────────
  console.log('\n=== Teste 8: status desconhecido gera pendência, não rascunho silencioso ===')
  check('mapearStatus com StatusPedido válido (0) retorna rascunho', mapearStatus({ cancelado: 0, pedidoConfirmado: 0, statusPedido: 0 }) === 'rascunho')
  check('mapearStatus com StatusPedido válido (5) retorna faturado', mapearStatus({ cancelado: 0, pedidoConfirmado: 0, statusPedido: 5 }) === 'faturado')
  check('mapearStatus com StatusPedido null retorna null (desconhecido)', mapearStatus({ cancelado: 0, pedidoConfirmado: 0, statusPedido: null }) === null)
  check('mapearStatus com StatusPedido não numérico retorna null (desconhecido)', mapearStatus({ cancelado: 0, pedidoConfirmado: 0, statusPedido: 'XYZ' }) === null)

  const legacyIdDesconhecido = 'TESTE-STATUS-DESCONHECIDO'
  try {
    await processarPedido({
      row: {
        CodigoFilial: '999', NumeroPedido: 999001, TipoPedido: 'V',
        StatusPedido: null, Cancelado: 0, PedidoConfirmado: 0,
        CodigoEmitente: '', DataEmissao: new Date().toISOString(), DataAtualizacao: new Date().toISOString(),
        Valor: 100, ValorDesconto: 0, ValorFrete: 0, CondicaoPagamento: null, Obs: 'TESTE - APAGAR', PesoBruto: null, QtdeVolumes: null,
      },
      legacyId: legacyIdDesconhecido, mapaClientes: new Map(), mapaProdutos: new Map(), e01Client: e01Stub,
      contadores: { total_criado: 0, total_atualizado: 0 },
    })
    const { data: pedidoCriado } = await supabase.from('pedidos').select('*').eq('sistema_origem', 'legado').eq('legacy_id', legacyIdDesconhecido).single()
    check('pedido com status desconhecido foi importado como rascunho (visível, não descartado)', pedidoCriado?.status === 'rascunho')
    check('pedido com status desconhecido fica com status_importacao_pendente=true (não é rascunho silencioso)', pedidoCriado?.status_importacao_pendente === true)

    // ── Teste 3: cliente sem match (código inválido) não vincula automaticamente ──
    console.log('\n=== Teste 3: cliente sem match não gera vínculo automático (nem cria cliente novo) ===')
    check('pedido sem CodigoEmitente válido fica com cliente_erp_id=null', pedidoCriado?.cliente_erp_id === null)
    check('pedido sem CodigoEmitente válido fica marcado precisa_vinculo_cliente=true', pedidoCriado?.precisa_vinculo_cliente === true)

    // ── Teste 10: sincronização posterior não sobrescreve edição local ────────
    console.log('\n=== Teste 10: sincronização não sobrescreve edição local silenciosamente (conflito) ===')
    const agora = new Date().toISOString()
    await supabase.from('pedidos').update({
      observacoes: 'EDITADO LOCALMENTE - APAGAR',
      atualizado_localmente_em: agora,
      atualizado_localmente_por_usuario_id: null,
      campos_com_override_local: ['observacoes'],
    }).eq('id', pedidoCriado.id)

    // Simula uma nova passada de sincronização trazendo um "Obs" diferente do legado
    await processarPedido({
      row: {
        CodigoFilial: '999', NumeroPedido: 999001, TipoPedido: 'V',
        StatusPedido: 1, Cancelado: 0, PedidoConfirmado: 1,
        CodigoEmitente: '', DataEmissao: new Date().toISOString(), DataAtualizacao: new Date().toISOString(),
        Valor: 100, ValorDesconto: 0, ValorFrete: 0, CondicaoPagamento: null, Obs: 'OBS NOVA DO LEGADO - NAO DEVE SOBRESCREVER', PesoBruto: null, QtdeVolumes: null,
      },
      legacyId: legacyIdDesconhecido, mapaClientes: new Map(), mapaProdutos: new Map(), e01Client: e01Stub,
      contadores: { total_criado: 0, total_atualizado: 0 },
    })

    const { data: pedidoAposSync } = await supabase.from('pedidos').select('*').eq('id', pedidoCriado.id).single()
    check('observacoes local NÃO foi sobrescrita pela sincronização', pedidoAposSync.observacoes === 'EDITADO LOCALMENTE - APAGAR')
    check('pedido foi marcado com conflito_sincronizacao=true (sinalizado, não silencioso)', pedidoAposSync.conflito_sincronizacao === true)
    check('status foi atualizado normalmente (campo sem override não é bloqueado)', pedidoAposSync.status === 'confirmado')
  } finally {
    await supabase.from('pedidos').delete().eq('legacy_id', legacyIdDesconhecido).eq('sistema_origem', 'legado')
  }

  console.log(`\n${falhas === 0 ? 'TODOS OS TESTES DESTE ARQUIVO PASSARAM' : `${falhas} TESTE(S) FALHARAM`}`)
  process.exit(falhas === 0 ? 0 : 1)
}

main().catch(err => { console.error('ERRO FATAL:', err); process.exit(1) })
