/**
 * Núcleo de decisão da sincronização financeira NetVision → CRM.
 *
 * Puro/sem I/O de propósito: toda a regra que decide "este título mudou? virou
 * pago? é conflito?" mora aqui e é testável sem banco nenhum. O job só
 * orquestra leitura/escrita.
 *
 * Copiado de vivenzza-crm-api/src/lib/financeiroLegado.js pra uso exclusivo
 * do script read-only audit-netvision-financeiro.mjs desta branch — o job de
 * escrita (sync-financeiro-legado.js) que usa decidirAtualizacao() não faz
 * parte deste worktree/PR, que é estritamente leitura.
 *
 * Por que detecção de colunas em vez de nomes fixos: o schema exato de
 * CR_Duplicatas varia por instalação/versão do NetVision, e só temos acesso ao
 * e01 pela rede local do escritório. Em vez de chutar e quebrar em produção, o
 * sync lê information_schema, escolhe a primeira coluna existente de cada
 * papel, REGISTRA o mapeamento escolhido no relatório da execução, e falha alto
 * e claro se não achar o mínimo necessário.
 */

// Ordem importa: primeiro nome encontrado vence. Os nomes confirmados em
// produção (CodigoCliente, NumeroTitulo, Sequencia, ValorParcialmentePago)
// vêm antes dos palpites.
export const CANDIDATOS_COLUNA = {
  numeroTitulo: ['NumeroTitulo', 'Numero', 'NroTitulo'],
  sequencia: ['Sequencia', 'Parcela', 'NumeroParcela'],
  codigoCliente: ['CodigoCliente', 'CodigoEmitente'],
  valor: ['ValorTitulo', 'Valor', 'ValorDuplicata', 'ValorOriginal', 'ValorParcela'],
  valorPago: ['ValorPago', 'ValorRecebido', 'ValorBaixado', 'ValorLiquidado', 'ValorParcialmentePago'],
  dataPagamento: ['DataPagamento', 'DataBaixa', 'DataRecebimento', 'DataLiquidacao', 'DataQuitacao'],
  situacao: ['Situacao', 'SituacaoTitulo', 'StatusTitulo', 'Status'],
  quitado: ['Quitado', 'Baixado', 'Liquidado', 'PagoTotal', 'Pago'],
  cancelado: ['Cancelado', 'Estornado'],
  // LÓGICA INVERTIDA. Confirmado na instalação da Vivenzza: esta base do
  // NetVision não tem Situacao/Quitado/Cancelado — tem DuplicataAberta, que
  // diz o OPOSTO ("ainda está em aberto").
  aberta: ['DuplicataAberta', 'TituloAberto', 'EmAberto', 'Aberta'],
  // Data, não flag: preenchida = título cancelado. Mesma instalação não tem
  // coluna booleana de cancelamento.
  dataCancelamento: ['DataCancelamento', 'DataEstorno', 'DataBaixaCancelamento'],
  vencimento: ['DataVencimento', 'Vencimento'],
  atualizacao: ['DataAtualizacao', 'DataUltimaAlteracao', 'UltimaAtualizacao', 'DataAlteracao'],
}

// Sem estes, não dá pra casar a linha do ERP com a conta do CRM — aborta.
const OBRIGATORIAS = ['numeroTitulo', 'sequencia']

// Pelo menos um sinal de pagamento precisa existir.
const SINAIS_PAGAMENTO = ['valorPago', 'dataPagamento', 'situacao', 'quitado', 'aberta']

// Tolerância de centavo.
export const EPSILON = 0.005

const VALORES_QUITADO = new Set([
  'quitado', 'quitada', 'pago', 'paga', 'baixado', 'baixada', 'liquidado',
  'liquidada', 'recebido', 'recebida', 'q', 'p', 'b', 'l',
])

const VALORES_CANCELADO = new Set([
  'cancelado', 'cancelada', 'estornado', 'estornada', 'c', 'e',
])

const MARCADORES_NEGATIVOS = new Set(['n', 'nao', 'não', '0', 'f', 'false', 'no'])

export function detectarColunas(colunasReais) {
  const existentes = new Set(colunasReais)
  const mapa = {}
  for (const [papel, candidatos] of Object.entries(CANDIDATOS_COLUNA)) {
    mapa[papel] = candidatos.find((c) => existentes.has(c)) ?? null
  }

  const faltando = OBRIGATORIAS.filter((p) => !mapa[p])
  if (faltando.length) {
    throw new Error(
      `CR_Duplicatas não tem as colunas obrigatórias para casar com o CRM: ${faltando.join(', ')}. ` +
      `Colunas encontradas na tabela: ${colunasReais.join(', ')}.`
    )
  }

  if (!SINAIS_PAGAMENTO.some((p) => mapa[p])) {
    throw new Error(
      `CR_Duplicatas não tem nenhuma coluna que indique pagamento ` +
      `(procurei por: ${SINAIS_PAGAMENTO.flatMap((p) => CANDIDATOS_COLUNA[p]).join(', ')}). ` +
      `Colunas encontradas: ${colunasReais.join(', ')}.`
    )
  }

  return mapa
}

function ehVerdadeiro(v) {
  if (v === null || v === undefined) return false
  if (typeof v === 'boolean') return v
  const s = String(v).trim().toLowerCase()
  if (s === '' || s === '0' || s === 'n' || s === 'nao' || s === 'não' || s === 'f' || s === 'false') return false
  return s === '1' || s === 's' || s === 'sim' || s === 't' || s === 'true' || s === 'y' || s === 'yes'
}

function numero(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(String(v).replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

function texto(v) {
  return v === null || v === undefined ? '' : String(v).trim().toLowerCase()
}

/**
 * legacy_id do CRM tem dois formatos históricos pro mesmo par título/sequência:
 * "cr-1008994-3" (carga antiga) e "001-1009054-2" (carga com prefixo de
 * filial). Gera as duas chaves possíveis pra casar dos dois lados.
 */
export function chavesLegado(numeroTitulo, sequencia, codigoFilial = null) {
  const t = String(numeroTitulo ?? '').trim()
  const s = String(sequencia ?? '').trim()
  if (!t || !s) return []
  const chaves = [`cr-${t}-${s}`]
  if (codigoFilial) chaves.push(`${String(codigoFilial).trim()}-${t}-${s}`)
  else chaves.push(`001-${t}-${s}`)
  return chaves
}

export function normalizarLinhaLegado(linha, mapa) {
  const col = (papel) => (mapa[papel] ? linha[mapa[papel]] : undefined)

  const situacaoTxt = texto(col('situacao'))

  const abertaBruto = col('aberta')
  const temColunaAberta = Boolean(mapa.aberta)
  const abertaPreenchida = abertaBruto !== null && abertaBruto !== undefined && String(abertaBruto).trim() !== ''
  const marcadorNegativo = abertaPreenchida && MARCADORES_NEGATIVOS.has(texto(abertaBruto))

  const abertaExplicita = temColunaAberta && abertaPreenchida && !marcadorNegativo
  const encerradoPelaColuna = temColunaAberta && (!abertaPreenchida || marcadorNegativo)

  const quitadoFlag = ehVerdadeiro(col('quitado')) || VALORES_QUITADO.has(situacaoTxt)

  const canceladoPorData = Boolean(mapa.dataCancelamento) && Boolean(dataISO(col('dataCancelamento')))
  const canceladoFlag =
    ehVerdadeiro(col('cancelado')) ||
    VALORES_CANCELADO.has(situacaoTxt) ||
    canceladoPorData

  return {
    numeroTitulo: col('numeroTitulo'),
    sequencia: col('sequencia'),
    codigoCliente: col('codigoCliente') != null ? String(col('codigoCliente')).trim() : null,
    valor: numero(col('valor')),
    valorPagoBruto: numero(col('valorPago')),
    dataPagamento: col('dataPagamento') ?? null,
    quitado: quitadoFlag,
    cancelado: canceladoFlag,
    abertaExplicita,
    encerrado: quitadoFlag || encerradoPelaColuna || VALORES_QUITADO.has(situacaoTxt),
    vencimento: col('vencimento') ?? null,
    atualizacao: col('atualizacao') ?? null,
  }
}

/**
 * Quanto o ERP diz que foi pago neste título, em reais. Ordem de confiança
 * deliberada: flag/situação explícita de "quitado" vale mais que o campo de
 * valor (várias instalações só registram baixa PARCIAL nesse campo e zeram
 * quando o título é quitado de uma vez).
 */
export function calcularValorPagoLegado(legado, valorTituloCrm) {
  const valorTitulo = legado.valor ?? valorTituloCrm ?? 0

  if (legado.valorPagoBruto != null && legado.valorPagoBruto > 0) {
    return Math.min(legado.valorPagoBruto, valorTitulo)
  }
  if (legado.quitado) return valorTitulo
  if (legado.dataPagamento && !legado.abertaExplicita) return valorTitulo
  return 0
}

/**
 * Converte um valor de data vindo do driver pg (Date | string | null) pro
 * formato 'YYYY-MM-DD', sem passar por fuso.
 */
export function dataISO(v) {
  if (!v) return null
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
  }
  const s = String(v).trim()
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/)
  if (br) return `${br[3]}-${br[2]}-${br[1]}`
  return null
}
