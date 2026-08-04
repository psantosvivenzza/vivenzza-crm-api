import { supabase } from './supabase-admin.server.js'
import { classificarOperacaoPedido } from './cfop.js'

// Vincula ao pedido a NF-e Série 1 recém-autorizada (SEFAZ real, ou simulada
// como autorizada em homologação/teste) — grava nfe_id e a classificação de
// faturamento derivada do CFOP dos itens (venda/bonificação/outra_operacao).
// Chamado tanto por POST /:id/emitir (autorização síncrona) quanto pelo job de
// reconciliação (autorização descoberta depois de um timeout) — os dois efeitos
// devem ser idênticos, então fica num único lugar em vez de duplicado nos dois
// arquivos. Sobrescreve qualquer vínculo anterior (ex.: uma Nota Interna
// 'nao_fiscal' criada antes) — uma Série 1 autorizada é sempre o documento
// fiscal definitivo do pedido.
export async function vincularSerie1Autorizada(pedidoId, nfe) {
  const classificacao = await classificarOperacaoPedido(nfe.nfe_itens)
  await supabase.from('pedidos').update({ nfe_id: nfe.id, classificacao_faturamento: classificacao }).eq('id', pedidoId)
  return classificacao
}

// Vincula ao pedido uma Nota Interna (série 99) recém-criada — nunca é venda
// fiscal (regra 6/11 da especificação: série 99 nunca vai à SEFAZ, não gera
// comissão nem entra em relatório fiscal). Só roda quando ainda não existe
// Série 1 autorizada pro pedido (já garantido pela checagem de duplicidade em
// POST /api/nfe antes de chegar aqui) — se uma Série 1 for autorizada depois
// pro mesmo pedido, vincularSerie1Autorizada sobrescreve isso.
export async function vincularSerie99Interna(pedidoId, nfeId) {
  await supabase.from('pedidos').update({ nfe_id: nfeId, classificacao_faturamento: 'nao_fiscal' }).eq('id', pedidoId)
}

// Desfaz o vínculo quando a NF-e que gerou a classificação é cancelada — uma
// venda/bonificação/nota interna cancelada não deve continuar contando no
// faturamento reportado. Só limpa se essa NF-e ainda for a atualmente vinculada
// (.eq('nfe_id', nfeId)): evita apagar um vínculo mais novo por engano numa
// corrida onde uma Série 1 já foi autorizada e depois alguém cancela uma Nota
// Interna antiga do mesmo pedido fora de ordem.
export async function desvincularSeForAAtual(pedidoId, nfeId) {
  await supabase.from('pedidos').update({ nfe_id: null, classificacao_faturamento: null })
    .eq('id', pedidoId).eq('nfe_id', nfeId)
}
