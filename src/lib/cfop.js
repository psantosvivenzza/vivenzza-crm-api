import { supabase } from './supabase-admin.server.js'

// Classifica a operação de um pedido faturado a partir dos CFOPs dos itens da
// NF-e vinculada. Fonte única de verdade é cfops.categoria_faturamento (cadastro
// já usado no wizard de emissão, migrations/classificacao_faturamento_pedidos.sql)
// — não duplica essa lista aqui, pra nunca divergir se o cadastro mudar.
//
// Precedência quando a nota tem itens de categorias diferentes (nota mista):
// qualquer item de venda já classifica o pedido inteiro como 'venda' (é receita
// real, mesmo que parcial); senão, qualquer item de bonificação classifica como
// 'bonificacao'; senão, 'outra_operacao'.
//
// CFOP sem categoria cadastrada (não deveria acontecer — o wizard só oferece
// CFOPs do cadastro — mas se acontecer) cai em 'outra_operacao' por padrão
// conservador: nunca conta como venda silenciosamente. Fica logado pra chamar
// atenção de que o cadastro de CFOPs precisa de uma entrada nova.
export async function classificarOperacaoPedido(nfeItens) {
  const cfopsUsados = [...new Set((nfeItens || []).map(i => i.cfop).filter(Boolean))]
  if (!cfopsUsados.length) return 'outra_operacao'

  const { data, error } = await supabase.from('cfops').select('codigo, categoria_faturamento').in('codigo', cfopsUsados)
  if (error) throw error

  const categoriaPorCodigo = new Map((data || []).map(c => [c.codigo, c.categoria_faturamento]))
  const categorias = cfopsUsados.map(cfop => {
    const categoria = categoriaPorCodigo.get(cfop)
    if (!categoria) console.warn(`[cfop] CFOP "${cfop}" não está cadastrado em public.cfops — classificando como outra_operacao por padrão conservador`)
    return categoria || 'outra_operacao'
  })

  if (categorias.includes('venda')) return 'venda'
  if (categorias.includes('bonificacao')) return 'bonificacao'
  return 'outra_operacao'
}
