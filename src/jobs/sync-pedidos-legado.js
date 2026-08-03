/**
 * Sincronização de pedidos do legado (NetVision, banco e01, tabela ES_Pedidos).
 *
 * A mesma função serve pra backfill (primeira execução, sem sincronização
 * concluída anterior — processa tudo) e incremental (execuções seguintes —
 * só o que mudou desde a última, com 10min de folga de segurança). Não existe
 * "modo backfill" separado: o cursor é sempre derivado do histórico real em
 * `sincronizacoes_pedidos`.
 *
 * Cliente: ES_Pedidos.CodigoEmitente é o código do cliente (confirmado
 * empiricamente — CodigoCliente vem sempre em branco nessa instalação,
 * CodigoDestinatario é um valor fixo "000001" sem relação com o cliente real).
 * CodigoEmitente bate direto com clientes_erp.legacy_id, sem normalização.
 *
 * Status: StatusPedido (0-20) e os flags Cancelado/PedidoConfirmado são
 * independentes entre si no legado — não é uma tradução 1:1 de código pra
 * status, é uma árvore de prioridade (ver mapearStatus).
 */
import pg from 'pg'
import { supabase } from '../lib/supabase-admin.server.js'

const PAGE_E01 = 200
const PAGE_SUPABASE = 1000
const JANELA_SEGURANCA_MS = 10 * 60 * 1000 // 10 min
const CONCORRENCIA = 10 // pedidos processados em paralelo dentro de cada página do e01

// null quando StatusPedido vem vazio/não numérico do legado — a árvore de
// prioridade normal não cobre esse caso, e cair em 'rascunho' silenciosamente
// esconderia um problema de dado de origem. processarPedido trata null
// marcando status_importacao_pendente=true em vez de importar sem avisar.
export function mapearStatus({ cancelado, pedidoConfirmado, statusPedido }) {
  if (statusPedido === null || statusPedido === undefined || Number.isNaN(Number(statusPedido))) return null
  if (Number(cancelado) === 1) return 'cancelado'
  if (Number(statusPedido) >= 5) return 'faturado' // 5=Faturamento Efetuado em diante (Conferido, Expedido, DANFE, ...)
  if (Number(pedidoConfirmado) === 1 || Number(statusPedido) >= 1) return 'confirmado'
  return 'rascunho' // StatusPedido=0 "Em carteira", ainda não confirmado — rascunho de verdade, não fallback
}

// Pool, não Client único: com CONCORRENCIA pedidos em paralelo, várias
// processarPedido() rodam ao mesmo tempo e cada uma consulta o e01 pros itens
// do pedido — um Client só enfileira (e a partir do pg@9 isso nem vai mais
// funcionar, só dá warning de depreciação hoje). O Pool dá uma conexão de
// verdade pra cada consulta concorrente.
async function conectarE01() {
  const pool = new pg.Pool({
    host: process.env.E01_HOST, port: process.env.E01_PORT, user: process.env.E01_USER,
    password: process.env.E01_PASSWORD, database: process.env.E01_DATABASE,
    connectionTimeoutMillis: 8000, max: CONCORRENCIA,
  })
  try {
    await pool.query('SELECT 1') // valida a conexão antes de seguir, mesmo padrão de client.connect()
  } catch (err) {
    // O e01 só é alcançável a partir da rede local do DESKTOP-Q6O54R1 — quando
    // essa API roda no Railway, a conexão sempre vai cair aqui. Mensagem clara
    // em vez do erro cru do driver pg, pra não confundir o admin no botão
    // "Sincronizar agora".
    await pool.end().catch(() => {})
    throw new Error('Não foi possível conectar ao banco legado (e01). Isso só funciona rodando localmente, na mesma rede do servidor NetVision — use "node scripts/sync-pedidos-legado.mjs" na máquina com acesso a ele.')
  }
  return pool
}

export async function buscarMapaClientes() {
  const mapa = new Map()
  for (let offset = 0; ; offset += PAGE_SUPABASE) {
    const { data, error } = await supabase.from('clientes_erp').select('id, legacy_id').range(offset, offset + PAGE_SUPABASE - 1)
    if (error) throw error
    for (const c of data) mapa.set(c.legacy_id, c.id)
    if (data.length < PAGE_SUPABASE) break
  }
  return mapa
}

export async function buscarMapaProdutos() {
  const mapa = new Map()
  for (let offset = 0; ; offset += PAGE_SUPABASE) {
    const { data, error } = await supabase
      .from('produtos').select('id, legacy_id').not('legacy_id', 'is', null).range(offset, offset + PAGE_SUPABASE - 1)
    if (error) throw error
    for (const p of data) mapa.set(p.legacy_id, p.id)
    if (data.length < PAGE_SUPABASE) break
  }
  return mapa
}

export async function processarPedido({ row, legacyId, mapaClientes, mapaProdutos, e01Client, contadores }) {
  const codigoCliente = (row.CodigoEmitente || '').trim()
  const clienteErpId = codigoCliente ? mapaClientes.get(codigoCliente) : undefined

  const { data: existente, error: erroExistente } = await supabase
    .from('pedidos')
    .select('id, atualizado_localmente_em, campos_com_override_local, cliente_erp_id')
    .eq('sistema_origem', 'legado')
    .eq('legacy_id', legacyId)
    .maybeSingle()
  if (erroExistente) throw erroExistente

  const statusMapeado = mapearStatus({ cancelado: row.Cancelado, pedidoConfirmado: row.PedidoConfirmado, statusPedido: row.StatusPedido })
  const statusDesconhecido = statusMapeado === null

  const dadosPedido = {
    legacy_id: legacyId,
    sistema_origem: 'legado',
    cliente_erp_id: clienteErpId !== undefined ? (clienteErpId ?? null) : (existente?.cliente_erp_id ?? null),
    cliente_externo_id: codigoCliente || null,
    precisa_vinculo_cliente: !clienteErpId,
    status: statusDesconhecido ? 'rascunho' : statusMapeado,
    status_origem: `StatusPedido=${row.StatusPedido}|Cancelado=${row.Cancelado}|PedidoConfirmado=${row.PedidoConfirmado}`,
    status_importacao_pendente: statusDesconhecido,
    total: Number(row.Valor || 0),
    desconto: Number(row.ValorDesconto || 0),
    valor_frete: Number(row.ValorFrete || 0),
    condicao_pagamento: row.CondicaoPagamento?.trim() || null,
    observacoes: row.Obs?.trim() || null,
    peso_bruto: row.PesoBruto != null ? Number(row.PesoBruto) : null,
    qtde_volumes: row.QtdeVolumes != null ? Number(row.QtdeVolumes) : null,
    criado_em: row.DataEmissao,
    atualizado_no_origem_em: row.DataAtualizacao,
    sincronizado_em: new Date().toISOString(),
    erro_sincronizacao: null,
  }

  // Conflito: se o pedido tem campos com edição local registrada, não sobrescreve
  // esses campos silenciosamente — remove do payload e sinaliza o conflito pro
  // admin decidir ("manter local" ou "usar dado do legado") na tela.
  let temOverrideLocal = false
  if (existente?.atualizado_localmente_em) {
    const overrides = Array.isArray(existente.campos_com_override_local) ? existente.campos_com_override_local : []
    if (overrides.length > 0) {
      temOverrideLocal = true
      for (const campo of overrides) delete dadosPedido[campo]
      dadosPedido.conflito_sincronizacao = true
    }
  }

  let pedidoId
  if (existente) {
    const { error } = await supabase.from('pedidos').update(dadosPedido).eq('id', existente.id)
    if (error) throw error
    pedidoId = existente.id
    contadores.total_atualizado++
  } else {
    const { data: criado, error } = await supabase.from('pedidos').insert(dadosPedido).select('id').single()
    if (error) throw error
    pedidoId = criado.id
    contadores.total_criado++
  }

  // Itens: só ressincroniza se não houver override local em itens (evita apagar
  // uma edição manual de itens feita depois da última sincronização). Substitui
  // o conjunto inteiro (delete + insert em lote) em vez de 1 select+upsert por
  // item — com 9k+ pedidos e 55k+ itens, round-trip por item tornava a
  // sincronização inviável (>1h); delete+insert em lote é o mesmo resultado
  // final (idempotente) com 2 chamadas por pedido em vez de até 2 por item.
  const itensTemOverride = temOverrideLocal &&
    Array.isArray(existente?.campos_com_override_local) && existente.campos_com_override_local.includes('itens')
  if (!itensTemOverride) {
    const { rows: itensLegado } = await e01Client.query(
      `SELECT "Sequencia", "CodigoItem", "Quantidade", "ValorUnitario"
       FROM "ES_ItemPedido" WHERE "CodigoFilial" = $1 AND "NumeroPedido" = $2 AND "TipoPedido" = 'V'`,
      [row.CodigoFilial, row.NumeroPedido]
    )
    const itensValidos = itensLegado
      .map(item => ({ codigoItem: (item.CodigoItem || '').trim(), item }))
      .filter(({ codigoItem }) => mapaProdutos.has(codigoItem))

    const { error: erroDelete } = await supabase.from('pedido_itens').delete().eq('pedido_id', pedidoId)
    if (erroDelete) throw erroDelete
    if (itensValidos.length > 0) {
      const { error: erroInsertItens } = await supabase.from('pedido_itens').insert(itensValidos.map(({ codigoItem, item }) => ({
        pedido_id: pedidoId, produto_id: mapaProdutos.get(codigoItem),
        quantidade: Number(item.Quantidade), preco_unitario: Number(item.ValorUnitario),
        legacy_id: `${legacyId}-${item.Sequencia}`,
      })))
      if (erroInsertItens) throw erroInsertItens
    }
  }
}

export async function executarSincronizacaoPedidos({ usuarioId = null } = {}) {
  const { data: ultima } = await supabase
    .from('sincronizacoes_pedidos')
    .select('cursor_final')
    .in('status', ['concluido', 'concluido_com_erros'])
    .not('cursor_final', 'is', null)
    .order('concluido_em', { ascending: false })
    .limit(1)
    .maybeSingle()

  const cursorAnterior = ultima?.cursor_final ? new Date(ultima.cursor_final) : null
  const desde = cursorAnterior ? new Date(cursorAnterior.getTime() - JANELA_SEGURANCA_MS) : null

  const { data: sync, error: erroSync } = await supabase
    .from('sincronizacoes_pedidos')
    .insert({ sistema_origem: 'legado', status: 'executando', cursor_inicial: desde?.toISOString() ?? null, iniciado_por_usuario_id: usuarioId })
    .select()
    .single()
  if (erroSync) throw erroSync

  const contadores = { total_lido: 0, total_criado: 0, total_atualizado: 0, total_ignorado: 0, total_com_erro: 0 }
  const erros = []
  let cursorFinal = desde ?? new Date(0)
  let e01Client

  try {
    e01Client = await conectarE01()
    const [mapaClientes, mapaProdutos] = await Promise.all([buscarMapaClientes(), buscarMapaProdutos()])

    for (let offset = 0; ; offset += PAGE_E01) {
      const params = []
      let where = `WHERE "TipoPedido" = 'V'`
      if (desde) {
        params.push(desde.toISOString())
        where += ` AND "DataAtualizacao" >= $${params.length}`
      }
      const { rows } = await e01Client.query(
        `SELECT "CodigoFilial", "NumeroPedido", "TipoPedido", "StatusPedido", "Cancelado", "PedidoConfirmado",
                "CodigoCliente", "CodigoEmitente", "DataEmissao", "DataAtualizacao", "Valor", "ValorDesconto",
                "ValorFrete", "Representante", "CondicaoPagamento", "Obs", "PesoBruto", "QtdeVolumes"
         FROM "ES_Pedidos" ${where}
         ORDER BY "DataAtualizacao" ASC, "NumeroPedido" ASC
         LIMIT ${PAGE_E01} OFFSET ${offset}`,
        params
      )
      if (rows.length === 0) break

      // Processa a página em lotes concorrentes (o e01Client é uma única conexão
      // pg — as queries do legado nesse lote serializam na própria fila do driver,
      // mas as chamadas ao Supabase, que são a maior parte do custo, paralelizam
      // de verdade). Sem isso, 9k+ pedidos processados 1 a 1 levariam mais de 1h.
      for (let i = 0; i < rows.length; i += CONCORRENCIA) {
        const lote = rows.slice(i, i + CONCORRENCIA)
        await Promise.all(lote.map(async row => {
          contadores.total_lido++
          const legacyId = `${(row.CodigoFilial || '').trim()}-${row.NumeroPedido}`
          try {
            await processarPedido({ row, legacyId, mapaClientes, mapaProdutos, e01Client, contadores })
            const dataAtualizacao = new Date(row.DataAtualizacao)
            if (dataAtualizacao > cursorFinal) cursorFinal = dataAtualizacao
          } catch (errPedido) {
            contadores.total_com_erro++
            erros.push({ sincronizacao_id: sync.id, pedido_externo_id: legacyId, mensagem: errPedido.message })
          }
        }))
      }

      if (rows.length < PAGE_E01) break
    }

    if (erros.length > 0) {
      // PostgREST aceita até 1000 linhas por insert em lote — nunca teremos isso
      // numa sincronização real, mas fatia por segurança de qualquer forma.
      for (let i = 0; i < erros.length; i += 500) {
        await supabase.from('sincronizacao_pedidos_erros').insert(erros.slice(i, i + 500))
      }
    }

    const statusFinal = erros.length > 0 ? 'concluido_com_erros' : 'concluido'
    await supabase.from('sincronizacoes_pedidos').update({
      status: statusFinal,
      concluido_em: new Date().toISOString(),
      cursor_final: cursorFinal.toISOString(),
      ...contadores,
    }).eq('id', sync.id)

    return { ...contadores, status: statusFinal, sincronizacao_id: sync.id, cursor_final: cursorFinal.toISOString() }
  } catch (err) {
    // Não avança o cursor em falha geral — a próxima execução recomeça do
    // mesmo ponto (última sincronização concluída com sucesso).
    await supabase.from('sincronizacoes_pedidos').update({
      status: 'falhou', concluido_em: new Date().toISOString(), mensagem_erro: err.message, ...contadores,
    }).eq('id', sync.id)
    throw err
  } finally {
    if (e01Client) await e01Client.end()
  }
}
