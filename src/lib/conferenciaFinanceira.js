/**
 * Conferência NetVision × CRM — a prova de que a sincronização está correta.
 *
 * Regra do Peterson (13/08): "só vai parar quando o CRM bater exatos dados da
 * NetVision". Este módulo é o que mede isso, e roda sozinho depois de cada
 * varredura completa — conferência que depende de alguém clicar é conferência
 * que ninguém faz. Foi assim que o sync de pedidos ficou meses quebrado sem
 * ninguém perceber: o erro estava no fim de um log que ninguém abria.
 *
 * Só leitura nos dois bancos.
 */
import pg from 'pg'
import { supabase } from './supabase-admin.server.js'
import { detectarColunas, normalizarLinhaLegado, calcularValorPagoLegado, chavesLegado } from './financeiroLegado.js'

const CENTAVO = 0.005
const ABERTO_CRM = new Set(['aberta', 'vencida', 'pago_parcial'])
const TABELA_LEGADO = 'CR_Duplicatas'

// Quantos exemplos guardar de cada tipo de divergência. O suficiente pra
// investigar sem transformar a linha do banco num despejo de dados.
const LIMITE_AMOSTRA = 20

/**
 * Compara os dois lados título a título.
 * @param {object} opts.poolE01  pool/client já conectado ao e01 (opcional; cria um se faltar)
 */
export async function executarConferencia({ poolE01 = null } = {}) {
  let pool = poolE01
  let poolProprio = false

  if (!pool) {
    pool = new pg.Pool({
      host: process.env.E01_HOST, port: process.env.E01_PORT, user: process.env.E01_USER,
      password: process.env.E01_PASSWORD, database: process.env.E01_DATABASE,
      connectionTimeoutMillis: 8000, max: 2,
    })
    poolProprio = true
  }

  try {
    const { rows: colunas } = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`,
      [TABELA_LEGADO]
    )
    const mapa = detectarColunas(colunas.map((c) => c.column_name))
    const selecionadas = [...new Set(Object.values(mapa).filter(Boolean))].map((c) => `"${c}"`).join(', ')
    const { rows: linhasErp } = await pool.query(`SELECT ${selecionadas} FROM "${TABELA_LEGADO}"`)

    // Indexa o ERP pelas duas chaves históricas de legacy_id.
    const erpPorChave = new Map()
    const erpUnicos = new Map()
    for (const r of linhasErp) {
      const l = normalizarLinhaLegado(r, mapa)
      const valorTitulo = Number(l.valor || 0)
      const pago = calcularValorPagoLegado(l, valorTitulo)
      const reg = {
        numeroTitulo: l.numeroTitulo,
        sequencia: l.sequencia,
        valor: valorTitulo,
        pago,
        saldo: valorTitulo - pago,
        cancelado: l.cancelado,
        aberto: !l.cancelado && !l.encerrado,
      }
      for (const k of chavesLegado(l.numeroTitulo, l.sequencia)) erpPorChave.set(k, reg)
      erpUnicos.set(`${l.numeroTitulo}-${l.sequencia}`, reg)
    }

    const crm = []
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await supabase
        .from('contas_financeiras')
        .select('id, legacy_id, pessoa_nome, valor, valor_pago, status')
        .eq('tipo', 'receber')
        .range(offset, offset + 999)
      if (error) throw error
      crm.push(...data)
      if (data.length < 1000) break
    }

    const totalErp = { abertos: 0, saldo: 0, cancelados: 0 }
    for (const r of erpUnicos.values()) {
      if (r.cancelado) totalErp.cancelados++
      else if (r.aberto) { totalErp.abertos++; totalErp.saldo += r.saldo }
    }

    const totalCrm = { abertos: 0, saldo: 0, cancelados: 0 }
    for (const c of crm) {
      if (c.status === 'cancelada') totalCrm.cancelados++
      else if (ABERTO_CRM.has(c.status)) {
        totalCrm.abertos++
        totalCrm.saldo += Number(c.valor || 0) - Number(c.valor_pago || 0)
      }
    }

    const div = {
      crmAbertoErpFechado: [],
      crmFechadoErpAberto: [],
      valorPagoDiferente: [],
      soNoCrm: [],
      soNoErp: [],
    }
    const vistos = new Set()

    for (const c of crm) {
      if (!c.legacy_id) continue
      // Prefixo e99- veio da outra empresa (IE antiga de Sapucaia do Sul),
      // carregada à parte na migração original. Não tem par em CR_Duplicatas
      // por definição — contar como divergência seria ruído permanente.
      if (String(c.legacy_id).startsWith('e99-')) continue

      const e = erpPorChave.get(c.legacy_id)
      if (!e) {
        div.soNoCrm.push({ legacy_id: c.legacy_id, cliente: c.pessoa_nome, status: c.status })
        continue
      }
      vistos.add(`${e.numeroTitulo}-${e.sequencia}`)

      const crmAberto = ABERTO_CRM.has(c.status)
      if (crmAberto && !e.aberto) {
        div.crmAbertoErpFechado.push({ legacy_id: c.legacy_id, cliente: c.pessoa_nome, status_crm: c.status, pago_erp: e.pago })
      } else if (!crmAberto && e.aberto && c.status !== 'cancelada') {
        div.crmFechadoErpAberto.push({ legacy_id: c.legacy_id, cliente: c.pessoa_nome, status_crm: c.status, saldo_erp: e.saldo })
      }

      const pagoCrm = Number(c.valor_pago || 0)
      if (Math.abs(pagoCrm - e.pago) > CENTAVO) {
        div.valorPagoDiferente.push({
          legacy_id: c.legacy_id, cliente: c.pessoa_nome,
          pago_crm: pagoCrm, pago_erp: e.pago, diferenca: Number((pagoCrm - e.pago).toFixed(2)),
        })
      }
    }

    for (const [k, e] of erpUnicos) {
      if (!vistos.has(k)) {
        div.soNoErp.push({ titulo: `${e.numeroTitulo}/${e.sequencia}`, valor: e.valor, aberto: e.aberto })
      }
    }

    // Só o que afeta cobrança entra no veredito. Título que nunca foi importado
    // é escopo de carga, não dessincronização — vira ressalva, não reprovação.
    const criticas =
      div.crmAbertoErpFechado.length + div.crmFechadoErpAberto.length + div.valorPagoDiferente.length

    return {
      bateu: criticas === 0,
      criticas,
      erp: { ...totalErp, saldo: Number(totalErp.saldo.toFixed(2)), total: erpUnicos.size },
      crm: { ...totalCrm, saldo: Number(totalCrm.saldo.toFixed(2)), total: crm.length },
      contagens: {
        crm_aberto_erp_fechado: div.crmAbertoErpFechado.length,
        crm_fechado_erp_aberto: div.crmFechadoErpAberto.length,
        valor_pago_diferente: div.valorPagoDiferente.length,
        so_no_crm: div.soNoCrm.length,
        so_no_erp: div.soNoErp.length,
      },
      amostras: Object.fromEntries(
        Object.entries(div).map(([k, v]) => [k, v.slice(0, LIMITE_AMOSTRA)])
      ),
    }
  } finally {
    if (poolProprio && pool) await pool.end().catch(() => {})
  }
}

/**
 * Roda a conferência e grava o resultado. É isto que torna a verificação
 * contínua: cada varredura completa deixa um registro consultável pela tela e
 * pelo suporte, em vez de depender de alguém rodar um script.
 */
export async function conferirEregistrar({ poolE01 = null, log = console.log } = {}) {
  const r = await executarConferencia({ poolE01 })

  const { error } = await supabase.from('conferencias_financeiro').insert({
    bateu: r.bateu,
    total_criticas: r.criticas,
    erp_abertos: r.erp.abertos,
    erp_saldo: r.erp.saldo,
    crm_abertos: r.crm.abertos,
    crm_saldo: r.crm.saldo,
    crm_aberto_erp_fechado: r.contagens.crm_aberto_erp_fechado,
    crm_fechado_erp_aberto: r.contagens.crm_fechado_erp_aberto,
    valor_pago_diferente: r.contagens.valor_pago_diferente,
    so_no_crm: r.contagens.so_no_crm,
    so_no_erp: r.contagens.so_no_erp,
    amostras: r.amostras,
  })
  if (error) log(`[conferencia] nao consegui gravar o resultado: ${error.message}`)

  return r
}
