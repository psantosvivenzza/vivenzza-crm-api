import { supabase } from './supabase-admin.server.js'

function inicioMesAtual() {
  const agora = new Date()
  return new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), 1)).toISOString()
}

async function buscarVendedor(vendedor_id) {
  const { data, error } = await supabase
    .from('usuarios')
    .select('id, nome, meta_mensal, comissao_sem_meta, comissao_com_meta')
    .eq('id', vendedor_id)
    .single()
  if (error) throw error
  return data
}

// Soma comissoes.valor_base já geradas pro vendedor no mês corrente — a tabela
// comissoes é o ledger confiável do mês (evita reabrir discussão sobre qual data
// de pedido usar pra "vendas do mês"). Exclui estornada/cancelada: uma venda
// desfeita (NF-e cancelada, nota interna cancelada) não deve contar pra meta.
async function somaComissoesDoMes(vendedor_id) {
  const { data, error } = await supabase
    .from('comissoes')
    .select('valor_base')
    .eq('vendedor_id', vendedor_id)
    .gte('data_geracao', inicioMesAtual())
    .not('status', 'in', '(estornada,cancelada)')
  if (error) throw error
  return (data || []).reduce((acc, c) => acc + Number(c.valor_base), 0)
}

// Preview usado na confirmação do pedido e no formulário — estimativa com base
// nas vendas já autorizadas do vendedor até agora (não inclui o pedido atual,
// que ainda não tem NF-e autorizada).
export async function calcularComissaoEstimada(vendedor_id) {
  if (!vendedor_id) return null
  const vendedor = await buscarVendedor(vendedor_id)
  if (!vendedor) return null

  const totalVendidoNoMes = await somaComissoesDoMes(vendedor_id)
  const metaMensal = Number(vendedor.meta_mensal) || 0
  const bateuMeta = metaMensal > 0 && totalVendidoNoMes >= metaMensal
  const percentualEstimado = bateuMeta ? Number(vendedor.comissao_com_meta) : Number(vendedor.comissao_sem_meta)

  return {
    percentual_estimado: percentualEstimado,
    total_vendido_no_mes: totalVendidoNoMes,
    meta_mensal: metaMensal,
    bateu_meta: bateuMeta,
  }
}

// Gatilho de geração por série: série 1 (NF-e SEFAZ) gera na autorização;
// série 99 (Nota Interna) gera imediatamente ao ser registrada — não passa
// pela SEFAZ, então não existe "autorizada" nesse fluxo.
function gatilhoValido(nfe) {
  if (nfe.serie === 99) return nfe.status === 'emitida_interna'
  return nfe.status === 'autorizada'
}

// Chamado após a NF-e ser autorizada pela SEFAZ (série 1) ou registrada como nota
// interna (série 99) — src/routes/nfe.js. Idempotente: se já existe comissão pra
// esse par (nfe_id, vendedor_id) — corrida ou nova tentativa do mesmo fluxo —
// retorna a existente em vez de duplicar (UNIQUE no banco é a garantia final; o
// SELECT prévio evita o round-trip de erro no caminho comum).
export async function gerarComissao(nfeId) {
  const { data: nfe, error: errNfe } = await supabase
    .from('nfe')
    .select('id, pedido_id, status, serie')
    .eq('id', nfeId)
    .single()
  if (errNfe) throw errNfe
  if (!nfe || !nfe.pedido_id || !gatilhoValido(nfe)) return null

  const { data: pedido, error: errPedido } = await supabase
    .from('pedidos')
    .select('id, vendedor_id, vendedor_nome, valor_base_comissao')
    .eq('id', nfe.pedido_id)
    .single()
  if (errPedido) throw errPedido
  if (!pedido?.vendedor_id) return null

  const { data: existente } = await supabase
    .from('comissoes')
    .select('*')
    .eq('nfe_id', nfe.id)
    .eq('vendedor_id', pedido.vendedor_id)
    .maybeSingle()
  if (existente) return existente

  const vendedor = await buscarVendedor(pedido.vendedor_id)
  if (!vendedor) return null

  const valorBase = Number(pedido.valor_base_comissao) || 0
  const jaGeradoNoMes = await somaComissoesDoMes(pedido.vendedor_id)
  const totalComEste = jaGeradoNoMes + valorBase
  const metaMensal = Number(vendedor.meta_mensal) || 0
  const bateuMeta = metaMensal > 0 && totalComEste >= metaMensal
  const percentual = bateuMeta ? Number(vendedor.comissao_com_meta) : Number(vendedor.comissao_sem_meta)
  const valorComissao = Math.round(valorBase * (percentual / 100) * 100) / 100

  const { data: comissao, error: errInsert } = await supabase
    .from('comissoes')
    .insert({
      pedido_id: pedido.id,
      nfe_id: nfe.id,
      vendedor_id: pedido.vendedor_id,
      vendedor_nome_snapshot: vendedor.nome || pedido.vendedor_nome,
      valor_base: valorBase,
      percentual_snapshot: percentual,
      valor_comissao: valorComissao,
      bateu_meta: bateuMeta,
      meta_mensal_snapshot: metaMensal,
      total_vendido_no_mes: totalComEste,
    })
    .select()
    .single()

  if (errInsert) {
    if (errInsert.code === '23505') {
      const { data: jaExiste } = await supabase
        .from('comissoes')
        .select('*')
        .eq('nfe_id', nfe.id)
        .eq('vendedor_id', pedido.vendedor_id)
        .single()
      return jaExiste
    }
    throw errInsert
  }

  return comissao
}

// Estorna a comissão de uma NF-e cancelada (SEFAZ ou nota interna) — a venda foi
// desfeita, então a comissão não deve mais contar. Só mexe em comissão ainda
// 'disponivel': se já foi 'paga', o estorno de dinheiro já repassado é decisão
// manual do admin, não algo pra reverter sozinho aqui.
export async function estornarComissao(nfeId) {
  const { data, error } = await supabase
    .from('comissoes')
    .update({ status: 'estornada', atualizado_em: new Date().toISOString() })
    .eq('nfe_id', nfeId)
    .eq('status', 'disponivel')
    .select()
    .maybeSingle()
  if (error) throw error
  return data
}
