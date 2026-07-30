import { supabase } from '../src/lib/supabase.js'

for (const [tabela, colunas] of [
  ['pedidos', ['sistema_origem', 'cliente_externo_id', 'precisa_vinculo_cliente', 'atualizado_no_origem_em', 'conflito_sincronizacao']],
  ['pedido_itens', ['legacy_id']],
  ['sincronizacoes_pedidos', ['id', 'status', 'cursor_final']],
  ['sincronizacao_pedidos_erros', ['id', 'pedido_externo_id']],
  ['pedido_historico', ['id', 'campo', 'valor_anterior', 'valor_novo']],
]) {
  for (const c of colunas) {
    const { error } = await supabase.from(tabela).select(c).limit(1)
    console.log(`${tabela}.${c}: ${error ? 'ERRO — ' + error.message : 'ok'}`)
  }
}

// produtos.legacy_id — necessário pro matching de itens do pedido
const { error: erroProdLegacy } = await supabase.from('produtos').select('legacy_id').limit(1)
console.log(`produtos.legacy_id: ${erroProdLegacy ? 'NÃO EXISTE — ' + erroProdLegacy.message : 'existe'}`)

const { data: amostraProdutos } = await supabase.from('produtos').select('id, legacy_id, nome').not('legacy_id', 'is', null).limit(3)
console.log('Amostra produtos com legacy_id:', JSON.stringify(amostraProdutos, null, 2))
