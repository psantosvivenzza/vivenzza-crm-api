/**
 * Sincronização do ledger de pagamentos (NetVision → Vivenzza).
 *
 * Fonte: `CR_PagtoParcial` (e01) — 1 linha = 1 evento de pagamento real,
 * cobre pagamento parcial/negociado (confirmado na auditoria de paridade:
 * ~14% dos títulos, mas é o único ledger de eventos que o NetVision tem).
 * `CR_Duplicatas."ValorParcialmentePago"` bate EXATAMENTE com a soma dessas
 * linhas por título — confirmado, não é heurística.
 *
 * Destino: `baixas_financeiras` — NÃO é uma tabela nova. Já existe no
 * schema-baseline local e já é usada de verdade por src/routes/financeiro.js
 * (baixa manual via RPC fn_baixar_titulo), só nunca foi criada em produção
 * (achado desta rodada, ver migration 20260101000035). Reaproveitada aqui em
 * vez de criar uma tabela concorrente.
 *
 * Idempotência: `legacy_evento_id` = "{CodigoFilial}-{NumeroTitulo}-{Sequencia}-{NroPagto}",
 * verificada 100% preenchida e sem colisão nas 3.565 linhas existentes em
 * 2026-08-14 (índice único parcial, NULL pra baixas manuais).
 *
 * ESCOPO DELIBERADAMENTE LIMITADO desta primeira versão: insere direto na
 * tabela via `.insert()` — NUNCA chama `fn_baixar_titulo` (a RPC que
 * recalcula `contas_financeiras.valor_pago`/status). Isso é proposital: o
 * objetivo agora é ter o histórico de eventos espelhado com segurança, não
 * recalcular o financeiro a partir dele — decisão futura separada, com
 * autorização própria.
 */
import pg from 'pg'
import { supabase } from '../lib/supabase-admin.server.js'
import { chavesLegado } from '../lib/financeiroLegado.js'

async function conectarE01() {
  return new pg.Pool({
    host: process.env.E01_HOST, port: process.env.E01_PORT, user: process.env.E01_USER,
    password: process.env.E01_PASSWORD, database: process.env.E01_DATABASE,
    connectionTimeoutMillis: 8000, max: 2,
  })
}

function montarBaixa(row, contaId) {
  const filial = (row.CodigoFilial || '').trim()
  const legacyEventoId = `${filial}-${row.NumeroTitulo}-${row.Sequencia}-${row.NroPagto}`
  return {
    conta_financeira_id: contaId,
    valor_baixado: Number(row.ValorPago || 0),
    data_pagamento: row.DataPagamento ? new Date(row.DataPagamento).toISOString().slice(0, 10) : null,
    forma_pagamento: row.CartaoConvenio ? String(row.CartaoConvenio).trim() : null,
    origem: 'netvision',
    status: 'ativa',
    conciliado: true, // já é histórico consolidado do legado, não pendente de conciliação manual
    observacao: `Importado de CR_PagtoParcial (NetVision) — título ${row.NumeroTitulo}/${row.Sequencia}. Desconto R$${Number(row.ValorDesconto || 0).toFixed(2)}, juros abatido R$${Number(row.ValorAbatidoJuro || 0).toFixed(2)}.`,
    legacy_evento_id: legacyEventoId,
  }
}

/**
 * `dryRun: true` (padrão) só reporta o que seria criado — nenhuma escrita.
 * Varredura completa (não incremental): 3.565 linhas é pequeno o bastante
 * pra não precisar de cursor, mesma decisão já tomada pro sync de clientes.
 *
 * Eventos sem conta_financeira correspondente são PULADOS (não criados) —
 * `conta_financeira_id` é NOT NULL em `baixas_financeiras`, diferente do meu
 * desenho original; não dá pra criar uma baixa órfã. Contabilizado em
 * `total_sem_conta_vinculada` pra visibilidade, sem quebrar o sync.
 */
export async function executarSincronizacaoPagamentos({ dryRun = true, poolE01 = null, log = console.log } = {}) {
  const pool = poolE01 ?? await conectarE01()
  const contadores = { total_netvision: 0, total_ja_existente: 0, total_criado: 0, total_sem_conta_vinculada: 0, total_com_erro: 0 }
  const erros = []

  try {
    const { rows } = await pool.query(
      `SELECT "CodigoFilial", "NumeroTitulo", "Sequencia", "DataPagamento", "ValorPago",
              "ValorDesconto", "ValorAbatidoJuro", "NroPagto", "CartaoConvenio"
       FROM "CR_PagtoParcial"`
    )
    contadores.total_netvision = rows.length

    const existentes = new Set()
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await supabase.from('baixas_financeiras').select('legacy_evento_id').eq('origem', 'netvision').range(offset, offset + 999)
      if (error) throw error
      for (const r of data) if (r.legacy_evento_id) existentes.add(r.legacy_evento_id)
      if (data.length < 1000) break
    }

    const contasPorChave = new Map()
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await supabase.from('contas_financeiras').select('id, legacy_id').eq('tipo', 'receber').range(offset, offset + 999)
      if (error) throw error
      for (const c of data) if (c.legacy_id) contasPorChave.set(c.legacy_id, c.id)
      if (data.length < 1000) break
    }

    const paraCriar = []
    for (const row of rows) {
      const filial = (row.CodigoFilial || '').trim()
      const legacyEventoId = `${filial}-${row.NumeroTitulo}-${row.Sequencia}-${row.NroPagto}`
      if (existentes.has(legacyEventoId)) { contadores.total_ja_existente++; continue }

      let contaId = null
      for (const k of chavesLegado(row.NumeroTitulo, row.Sequencia, filial)) {
        if (contasPorChave.has(k)) { contaId = contasPorChave.get(k); break }
      }
      if (!contaId) { contadores.total_sem_conta_vinculada++; continue }

      paraCriar.push(montarBaixa(row, contaId))
    }

    if (dryRun) {
      contadores.total_criado = paraCriar.length
      return { ...contadores, dry_run: true, amostra: paraCriar.slice(0, 10) }
    }

    for (let i = 0; i < paraCriar.length; i += 500) {
      const lote = paraCriar.slice(i, i + 500)
      const { error } = await supabase.from('baixas_financeiras').insert(lote)
      if (error) {
        contadores.total_com_erro += lote.length
        erros.push({ mensagem: error.message, primeiro_evento: lote[0]?.legacy_evento_id })
        log(`[sync-pagamentos-legado] erro no lote iniciando em ${lote[0]?.legacy_evento_id}: ${error.message}`)
      } else {
        contadores.total_criado += lote.length
      }
    }

    return { ...contadores, dry_run: false, erros }
  } finally {
    if (!poolE01) await pool.end()
  }
}
