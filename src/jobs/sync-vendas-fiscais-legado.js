/**
 * Sincronização do fiscal read model (NetVision `EN_Notas` → Vivenzza
 * `notas_fiscais_netvision`).
 *
 * ESPELHO, NUNCA EMISSÃO. Este job:
 *   - NUNCA chama SEFAZ, NUNCA emite/cancela NF;
 *   - NUNCA escreve em `pedidos`, `contas_financeiras` ou `nfe` (a tabela
 *     de emissão real do Vivenzza, hoje desligada por
 *     configuracoes_fiscais.serie1_numeracao_liberada=false);
 *   - só espelha o que já existe no NetVision, pra alimentar indicadores
 *     de leitura (VENDAS DO MÊS, por representante).
 *
 * CFOP: só 5102/6102 são classificados VENDA (achado confirmado em
 * VENDAS_DO_MES_RECONCILIACAO.md). 6910 = BONIFICACAO. Resto = OUTROS,
 * exceto 5910 que fica INDETERMINADO com cfop_ambiguo=true (a própria
 * tabela `NaturezaOperacao` do NetVision tem descrição ambígua pra esse
 * código — não decidimos por ela).
 *
 * Idempotente por `legacy_nfe_id` ("{CodigoFilial}-{NumeroNota}") — upsert,
 * nunca duplica. Varredura completa por padrão (não incremental) — o
 * volume de EN_Notas não justifica cursor ainda; se crescer muito,
 * revisitar com `DataAtualizacao` como cursor.
 */
import pg from 'pg'
import { supabase } from '../lib/supabase-admin.server.js'

const CFOP_VENDA = new Set(['5102', '6102'])
const CFOP_BONIFICACAO = new Set(['6910'])
const CFOP_AMBIGUO = new Set(['5910'])

async function conectarE01() {
  return new pg.Pool({
    host: process.env.E01_HOST, port: process.env.E01_PORT, user: process.env.E01_USER,
    password: process.env.E01_PASSWORD, database: process.env.E01_DATABASE,
    connectionTimeoutMillis: 8000, max: 2,
  })
}

export function classificarCfop(cfopBruto) {
  const cfop = (cfopBruto || '').trim()
  if (CFOP_VENDA.has(cfop)) return { classificacao: 'VENDA', ambiguo: false }
  if (CFOP_BONIFICACAO.has(cfop)) return { classificacao: 'BONIFICACAO', ambiguo: false }
  if (CFOP_AMBIGUO.has(cfop)) return { classificacao: 'INDETERMINADO', ambiguo: true }
  return { classificacao: 'OUTROS', ambiguo: false }
}

function montarNota(row, mapaRepresentantes) {
  const filial = (row.CodigoFilial || '').trim()
  const serie = (row.Serie || '').trim()
  const codigoRepresentante = row.Comissionado ? String(row.Comissionado).trim() : null
  const { classificacao, ambiguo } = classificarCfop(row.NaturezaOperacao1)
  return {
    // achado na validação local: NumeroNota NÃO é único por filial sozinho
    // (reinicia por série — ex. nota 7 existe tanto na série "99"/VEN
    // quanto na série "E"/BON). Mesmo filial+série+número ainda colide em
    // pouquíssimos casos raros (2 em 10.659, ambos TipoNota='NE', fora do
    // domínio de vendas) — TipoNota entra na chave, e o insert usa upsert
    // com ON CONFLICT DO NOTHING pra não quebrar o sync inteiro por causa
    // de uma duplicata residual do dado de origem.
    legacy_nfe_id: `${filial}-${serie || '_'}-${(row.TipoNota || '').trim()}-${row.NumeroNota}`,
    numero: Number(row.NumeroNota),
    codigo_filial: filial,
    tipo_nota: row.TipoNota,
    cliente_codigo: row.Cliente ? String(row.Cliente).trim() : null,
    representante_codigo: codigoRepresentante,
    representante_nome: codigoRepresentante ? (mapaRepresentantes.get(codigoRepresentante) ?? null) : null,
    cfop: row.NaturezaOperacao1 ? String(row.NaturezaOperacao1).trim() : null,
    cfop_classificacao: classificacao,
    cfop_ambiguo: ambiguo,
    valor_nota: Number(row.ValorNota || 0),
    valor_total_produtos: row.ValorTotalProdutos != null ? Number(row.ValorTotalProdutos) : null,
    data_emissao: row.DataEmissao ? new Date(row.DataEmissao).toISOString().slice(0, 10) : null,
    cancelada: Number(row.Cancelada || 0),
    pedido_legacy_id: null, // vínculo não confiável (ver docstring) — nunca inventado
    atualizado_em: new Date().toISOString(),
    metadata: row,
  }
}

/**
 * `dryRun: true` (padrão) só reporta o que seria criado/atualizado, nenhuma
 * escrita. Filtro opcional `filial`/`desde` pra rodadas parciais.
 */
export async function executarSincronizacaoVendasFiscais({ dryRun = true, filial = '001', poolE01 = null, log = console.log } = {}) {
  const pool = poolE01 ?? await conectarE01()
  const contadores = { total_netvision: 0, total_criado: 0, total_atualizado: 0, total_com_erro: 0 }
  const erros = []

  try {
    const { rows } = await pool.query(
      `SELECT "CodigoFilial","NumeroNota","Serie","TipoNota","Cliente","Comissionado","NaturezaOperacao1",
              "ValorNota","ValorTotalProdutos","DataEmissao","Cancelada"
       FROM "EN_Notas" WHERE "CodigoFilial" = $1`,
      [filial]
    )
    contadores.total_netvision = rows.length

    // Código -> nome do representante, mesma fonte/padrão de
    // sync-pedidos-legado.js (buscarMapaVendedores) — só o nome bruto do
    // NetVision aqui, não tenta casar com usuarios.id (esse read model é
    // fiscal, não precisa do vínculo com login do Vivenzza).
    const { rows: representantes } = await pool.query(
      `SELECT TRIM("Representante") AS codigo, "Nome" AS nome FROM "EN_Representantes" WHERE TRIM("Representante") <> ''`
    )
    const mapaRepresentantes = new Map(representantes.map((r) => [r.codigo, r.nome]))

    const existentes = new Map()
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await supabase.from('notas_fiscais_netvision').select('legacy_nfe_id, valor_nota, cancelada, cfop_classificacao').range(offset, offset + 999)
      if (error) throw error
      for (const r of data) existentes.set(r.legacy_nfe_id, r)
      if (data.length < 1000) break
    }

    const paraCriar = [], paraAtualizar = []
    for (const row of rows) {
      const nota = montarNota(row, mapaRepresentantes)
      const atual = existentes.get(nota.legacy_nfe_id)
      if (!atual) { paraCriar.push(nota); continue }
      // Só reescreve se algo relevante mudou (nota pode ser cancelada depois
      // de importada — precisa refletir isso numa próxima execução).
      if (atual.valor_nota != nota.valor_nota || atual.cancelada !== nota.cancelada || atual.cfop_classificacao !== nota.cfop_classificacao) {
        paraAtualizar.push(nota)
      }
    }

    if (dryRun) {
      contadores.total_criado = paraCriar.length
      contadores.total_atualizado = paraAtualizar.length
      return { ...contadores, dry_run: true, amostra_criar: paraCriar.slice(0, 10), amostra_atualizar: paraAtualizar.slice(0, 10) }
    }

    for (let i = 0; i < paraCriar.length; i += 500) {
      const lote = paraCriar.slice(i, i + 500)
      const { error } = await supabase.from('notas_fiscais_netvision').upsert(lote, { onConflict: 'legacy_nfe_id', ignoreDuplicates: true })
      if (error) { contadores.total_com_erro += lote.length; erros.push({ mensagem: error.message, primeiro: lote[0]?.legacy_nfe_id }); log(`[sync-vendas-fiscais-legado] erro criar lote ${lote[0]?.legacy_nfe_id}: ${error.message}`) }
      else contadores.total_criado += lote.length
    }
    for (const nota of paraAtualizar) {
      const { error } = await supabase.from('notas_fiscais_netvision').update(nota).eq('legacy_nfe_id', nota.legacy_nfe_id)
      if (error) { contadores.total_com_erro++; erros.push({ mensagem: error.message, primeiro: nota.legacy_nfe_id }) }
      else contadores.total_atualizado++
    }

    return { ...contadores, dry_run: false, erros }
  } finally {
    if (!poolE01) await pool.end()
  }
}
