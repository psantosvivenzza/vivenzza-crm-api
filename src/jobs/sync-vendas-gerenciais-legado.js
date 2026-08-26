/**
 * Sincronização do read-model GERENCIAL de vendas (NetVision `EN_NotasRepres`
 * → Vivenzza `vendas_gerenciais_netvision`).
 *
 * EN_NotasRepres é a fonte REAL do relatório oficial NetVision "Consulta
 * Vendas por Representante" — comprovado por reconciliação exata (bateu
 * Ana/Diego/Nicole/Tais e o total geral até o centavo, ver
 * VENDAS_DO_MES_RECONCILIACAO.md). NÃO é EN_Notas (que
 * notas_fiscais_netvision já espelha, domínio fiscal) nem ES_Pedidos —
 * são fontes estruturalmente diferentes que não reconciliam entre si.
 *
 * ESPELHO, NUNCA EMISSÃO. Este job:
 *   - NUNCA chama SEFAZ, NUNCA emite/cancela NF;
 *   - NUNCA escreve em `pedidos`, `contas_financeiras`, `nfe` ou
 *     `notas_fiscais_netvision` (domínio fiscal, intocado);
 *   - só espelha o que já existe no NetVision, pra alimentar o indicador
 *     GERENCIAL "Vendas do Mês" (vendas_gerenciais_mes no dashboard).
 *
 * Série 99 SEMPRE incluída, sem exceção — é exatamente o que o NetVision já
 * faz nesta tabela (comprovado: R$17.264,88 de Série 99 estava dentro do
 * total reconciliado). Nenhuma lógica de exclusão de série existe aqui de
 * propósito.
 *
 * Idempotente por `legacy_id` ("{CodigoFilial}-{RepresentanteCodigo}-{Serie}-
 * {NumeroDocumento}") — testado empiricamente contra as 8.202 linhas
 * históricas de EN_NotasRepres em produção: ZERO colisões com essa
 * combinação de 4 colunas (ver comentário na migration
 * 20260101000043_vendas_gerenciais_netvision.sql pro racional completo).
 * Upsert, nunca duplica. Varredura completa por padrão (não incremental).
 */
import pg from 'pg'
import { supabase } from '../lib/supabase-admin.server.js'

async function conectarE01() {
  return new pg.Pool({
    host: process.env.E01_HOST, port: process.env.E01_PORT, user: process.env.E01_USER,
    password: process.env.E01_PASSWORD, database: process.env.E01_DATABASE,
    connectionTimeoutMillis: 8000, max: 2,
  })
}

function montarVenda(row, mapaRepresentantes) {
  const filial = (row.CodigoFilial || '').trim()
  const repCodigo = (row.Representante || '').trim()
  const serie = (row.Serie || '').trim()
  return {
    legacy_id: `${filial}-${repCodigo}-${serie || '_'}-${row.NumeroDocumento}`,
    codigo_filial: filial,
    representante_codigo: repCodigo,
    representante_nome: mapaRepresentantes.get(repCodigo) ?? null,
    numero_documento: Number(row.NumeroDocumento),
    serie,
    data_emissao: row.DataEmissao ? new Date(row.DataEmissao).toISOString().slice(0, 10) : null,
    valor_documento: Number(row.ValorDocumento || 0),
    pagamento_a_vista: Number(row.PagamentoAVista) === 1,
    condicao_pagamento: row.CondicaoPagamento ? String(row.CondicaoPagamento).trim() : null,
    numero_titulo: row.NumeroTitulo != null ? Number(row.NumeroTitulo) : null,
    nro_registro: row.NroRegistro != null ? Number(row.NroRegistro) : null,
    emitente: row.Emitente ? String(row.Emitente).trim() : null,
    codigo_pdv: row.CodigoPDV != null ? String(row.CodigoPDV).trim() : null,
    status_representante: row.StatusRepresentante != null ? Number(row.StatusRepresentante) : null,
    atualizado_em: new Date().toISOString(),
    metadata: row,
  }
}

/**
 * `dryRun: true` (padrão) só reporta o que seria criado/atualizado, nenhuma
 * escrita — inclusive no log de sincronização, que só registra execuções
 * reais (dry_run nunca conta pro indicador de frescor em
 * vendaGerencialSyncStatus.js, mesma convenção do fiscal/financeiro).
 * Filtro obrigatório `filial` (default '001') e opcional `desde`/`ate`
 * (default: mês corrente) — varredura completa não faz sentido pra uma
 * tabela com anos de histórico (8.202+ linhas e crescendo); o dashboard só
 * precisa do mês corrente, então o sync varre só a janela relevante.
 */
export async function executarSincronizacaoVendasGerenciais({
  dryRun = true, filial = '001', desde = null, ate = null, poolE01 = null, log = console.log,
} = {}) {
  const pool = poolE01 ?? await conectarE01()
  const contadores = { total_lido: 0, total_criado: 0, total_atualizado: 0, total_com_erro: 0 }
  const erros = []

  const agora = new Date()
  const desdeReal = desde ?? new Date(agora.getFullYear(), agora.getMonth(), 1).toISOString().slice(0, 10)
  const ateReal = ate ?? new Date(agora.getFullYear(), agora.getMonth() + 1, 0).toISOString().slice(0, 10)

  let syncLogId = null
  if (!dryRun) {
    const { data, error } = await supabase
      .from('sincronizacoes_vendas_gerenciais')
      .insert({ status: 'executando', dry_run: false, host_origem: process.env.HOSTNAME || process.env.COMPUTERNAME || null })
      .select('id')
      .single()
    if (error) log(`[sync-vendas-gerenciais-legado] aviso: não registrou início do sync em sincronizacoes_vendas_gerenciais: ${error.message}`)
    else syncLogId = data.id
  }

  try {
    const { rows } = await pool.query(
      `SELECT "CodigoFilial","Representante","DataEmissao","NumeroDocumento","Serie","ValorDocumento",
              "PagamentoAVista","CondicaoPagamento","NumeroTitulo","NroRegistro","Emitente","CodigoPDV",
              "StatusRepresentante"
       FROM "EN_NotasRepres"
       WHERE "CodigoFilial" = $1 AND "DataEmissao" >= $2 AND "DataEmissao" <= $3`,
      [filial, desdeReal, ateReal]
    )
    contadores.total_lido = rows.length

    const { rows: representantes } = await pool.query(
      `SELECT TRIM("Representante") AS codigo, "Nome" AS nome FROM "EN_Representantes" WHERE TRIM("Representante") <> ''`
    )
    const mapaRepresentantes = new Map(representantes.map((r) => [r.codigo, r.nome]))

    const existentes = new Map()
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await supabase.from('vendas_gerenciais_netvision').select('legacy_id, valor_documento, pagamento_a_vista').range(offset, offset + 999)
      if (error) throw error
      for (const r of data) existentes.set(r.legacy_id, r)
      if (data.length < 1000) break
    }

    const paraCriar = [], paraAtualizar = []
    for (const row of rows) {
      const venda = montarVenda(row, mapaRepresentantes)
      const atual = existentes.get(venda.legacy_id)
      if (!atual) { paraCriar.push(venda); continue }
      if (Number(atual.valor_documento) !== venda.valor_documento || atual.pagamento_a_vista !== venda.pagamento_a_vista) {
        paraAtualizar.push(venda)
      }
    }

    if (dryRun) {
      contadores.total_criado = paraCriar.length
      contadores.total_atualizado = paraAtualizar.length
      return { ...contadores, dry_run: true, periodo: { desde: desdeReal, ate: ateReal }, amostra_criar: paraCriar.slice(0, 10), amostra_atualizar: paraAtualizar.slice(0, 10) }
    }

    for (let i = 0; i < paraCriar.length; i += 500) {
      const lote = paraCriar.slice(i, i + 500)
      const { error } = await supabase.from('vendas_gerenciais_netvision').upsert(lote, { onConflict: 'legacy_id', ignoreDuplicates: true })
      if (error) { contadores.total_com_erro += lote.length; erros.push({ mensagem: error.message, primeiro: lote[0]?.legacy_id }); log(`[sync-vendas-gerenciais-legado] erro criar lote ${lote[0]?.legacy_id}: ${error.message}`) }
      else contadores.total_criado += lote.length
    }
    for (const venda of paraAtualizar) {
      const { error } = await supabase.from('vendas_gerenciais_netvision').update(venda).eq('legacy_id', venda.legacy_id)
      if (error) { contadores.total_com_erro++; erros.push({ mensagem: error.message, primeiro: venda.legacy_id }) }
      else contadores.total_atualizado++
    }

    if (syncLogId) {
      await supabase.from('sincronizacoes_vendas_gerenciais').update({
        status: contadores.total_com_erro > 0 ? 'concluido_com_erros' : 'concluido',
        concluido_em: new Date().toISOString(),
        total_lido: contadores.total_lido,
        total_criado: contadores.total_criado,
        total_atualizado: contadores.total_atualizado,
        total_com_erro: contadores.total_com_erro,
      }).eq('id', syncLogId)
    }

    return { ...contadores, dry_run: false, periodo: { desde: desdeReal, ate: ateReal }, erros }
  } catch (err) {
    if (syncLogId) {
      await supabase.from('sincronizacoes_vendas_gerenciais').update({
        status: 'falhou', concluido_em: new Date().toISOString(), mensagem_erro: err.message,
      }).eq('id', syncLogId)
    }
    throw err
  } finally {
    if (!poolE01) await pool.end()
  }
}
