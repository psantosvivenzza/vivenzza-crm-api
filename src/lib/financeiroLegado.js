/**
 * Núcleo de decisão da sincronização financeira NetVision → CRM.
 *
 * Puro/sem I/O de propósito: toda a regra que decide "este título mudou? virou
 * pago? é conflito?" mora aqui e é testável sem banco nenhum (ver
 * scripts/testes-sync-financeiro.mjs). O job só orquestra leitura/escrita.
 *
 * Por que detecção de colunas em vez de nomes fixos: o schema exato de
 * CR_Duplicatas varia por instalação/versão do NetVision, e só temos acesso ao
 * e01 pela rede local do escritório. Em vez de chutar e quebrar em produção, o
 * sync lê information_schema, escolhe a primeira coluna existente de cada
 * papel, REGISTRA o mapeamento escolhido no relatório da execução, e falha alto
 * e claro se não achar o mínimo necessário.
 */

// Ordem importa: primeiro nome encontrado vence. Os nomes confirmados em
// produção (CodigoCliente, NumeroTitulo, Sequencia, ValorParcialmentePago —
// ver scripts/popular-codigo-cliente.mjs e migrations/contas_financeiras_valor_pago.sql)
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
  // LÓGICA INVERTIDA. Confirmado na instalação da Vivenzza (13/08/2026): esta
  // base do NetVision não tem Situacao/Quitado/Cancelado — tem DuplicataAberta,
  // que diz o OPOSTO ("ainda está em aberto"). Tratar como se fosse `quitado`
  // marcaria todo título pago como em aberto e vice-versa, então tem papel
  // próprio e é negada em normalizarLinhaLegado.
  aberta: ['DuplicataAberta', 'TituloAberto', 'EmAberto', 'Aberta'],
  // Data, não flag: preenchida = título cancelado. Mesma instalação não tem
  // coluna booleana de cancelamento.
  dataCancelamento: ['DataCancelamento', 'DataEstorno', 'DataBaixaCancelamento'],
  vencimento: ['DataVencimento', 'Vencimento'],
  atualizacao: ['DataAtualizacao', 'DataUltimaAlteracao', 'UltimaAtualizacao', 'DataAlteracao'],
}

// Sem estes, não dá pra casar a linha do ERP com a conta do CRM — aborta.
const OBRIGATORIAS = ['numeroTitulo', 'sequencia']

// Pelo menos um sinal de pagamento precisa existir, senão o sync não teria o
// que sincronizar (e rodar assim daria uma falsa sensação de segurança).
const SINAIS_PAGAMENTO = ['valorPago', 'dataPagamento', 'situacao', 'quitado', 'aberta']

// Tolerância de centavo — comparar numeric vindo de dois bancos com == é receita
// pra "atualizar" o mesmo título pra sempre.
export const EPSILON = 0.005

const VALORES_QUITADO = new Set([
  'quitado', 'quitada', 'pago', 'paga', 'baixado', 'baixada', 'liquidado',
  'liquidada', 'recebido', 'recebida', 'q', 'p', 'b', 'l',
])

const VALORES_CANCELADO = new Set([
  'cancelado', 'cancelada', 'estornado', 'estornada', 'c', 'e',
])

// Valores que, na coluna de "em aberto", significam explicitamente NÃO aberto.
// Existe para instalações que usam S/N nessa coluna — na Vivenzza o encerramento
// é representado por ausência de valor, não por um marcador.
const MARCADORES_NEGATIVOS = new Set(['n', 'nao', 'não', '0', 'f', 'false', 'no'])

/**
 * Escolhe, pra cada papel, a primeira coluna candidata que existe de verdade na
 * tabela. `colunasReais` é a lista crua vinda de information_schema.
 */
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
      `Colunas encontradas na tabela: ${colunasReais.join(', ')}. ` +
      `Rode "node scripts/investigar-e01-financeiro.mjs" e me mande a saída pra eu ajustar o mapeamento.`
    )
  }

  if (!SINAIS_PAGAMENTO.some((p) => mapa[p])) {
    throw new Error(
      `CR_Duplicatas não tem nenhuma coluna que indique pagamento ` +
      `(procurei por: ${SINAIS_PAGAMENTO.flatMap((p) => CANDIDATOS_COLUNA[p]).join(', ')}). ` +
      `Sem isso o sync não tem o que sincronizar. Colunas encontradas: ${colunasReais.join(', ')}.`
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
 * "cr-1008994-3" (carga antiga) e "001-1009054-2" (carga de 23/07, prefixo =
 * código da filial). Gera as duas chaves possíveis pra casar dos dois lados.
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

/**
 * Normaliza uma linha crua de CR_Duplicatas usando o mapeamento de colunas.
 * Devolve sempre a mesma forma, independente do schema da instalação.
 */
export function normalizarLinhaLegado(linha, mapa) {
  const col = (papel) => (mapa[papel] ? linha[mapa[papel]] : undefined)

  const situacaoTxt = texto(col('situacao'))

  // ── Coluna de "em aberto" — semântica confirmada com os dados ─────────────
  // Prova rodada contra a base da Vivenzza em 13/08/2026 (17.725 títulos):
  //
  //   DuplicataAberta   total   pago total   parcial   sem pgto
  //   null              16545        14026      2438         81
  //   S                  1161            0         0       1161
  //   R                    10            0         0         10
  //   I                     9            0         0          9
  //
  // Ou seja: a coluna é PREENCHIDA apenas enquanto o título está em aberto
  // (100% dos S/R/I não têm um centavo pago) e fica NULA quando o ERP encerra
  // a duplicata. Não é um booleano — 'S', 'R' e 'I' são estados diferentes de
  // "ainda aberto" (provavelmente Simples, Renegociada, Impressa).
  //
  // Duas consequências que a leitura ingênua erraria:
  //  1. NULO significa ENCERRADO, não "não sei". Tratar como desconhecido
  //     deixaria 16.545 títulos encerrados voltando pra régua.
  //  2. Só 'S' seria reconhecido como verdadeiro por uma checagem booleana —
  //     'R' e 'I' cairiam em "falso" e 19 títulos SEM NENHUM PAGAMENTO seriam
  //     dados como quitados, saindo da cobrança em silêncio.
  //
  // Regra adotada: valor presente = em aberto, salvo marcador explícito de
  // negativa ('N', '0', 'F'), que cobre instalações que usam S/N. Ausência de
  // valor = encerrado. Na dúvida o erro cai pro lado de NÃO cobrar.
  const abertaBruto = col('aberta')
  const temColunaAberta = Boolean(mapa.aberta)
  const abertaPreenchida = abertaBruto !== null && abertaBruto !== undefined && String(abertaBruto).trim() !== ''
  const marcadorNegativo = abertaPreenchida && MARCADORES_NEGATIVOS.has(texto(abertaBruto))

  const abertaExplicita = temColunaAberta && abertaPreenchida && !marcadorNegativo
  const encerradoPelaColuna = temColunaAberta && (!abertaPreenchida || marcadorNegativo)

  const quitadoFlag = ehVerdadeiro(col('quitado')) || VALORES_QUITADO.has(situacaoTxt)

  // Cancelamento pode vir como flag booleana, como texto de situação, ou como
  // data preenchida (é o caso desta instalação: DataCancelamento).
  // Boolean() explícito: sem ele, quando a coluna de data não existe no schema
  // a expressão devolve o próprio `null` do mapa em vez de `false`, e o campo
  // sai com tipo inconsistente entre instalações.
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
    // O ERP afirmou que este título CONTINUA em aberto. Diferente de "não sei":
    // vale mais que qualquer heurística de data mais adiante.
    abertaExplicita,
    // O ERP encerrou a duplicata. NÃO é sinônimo de "recebeu tudo" — pode ter
    // sido acordo, desconto ou baixa comercial. Define se a régua PARA de
    // cobrar; quanto entrou de dinheiro continua saindo de ValorPago.
    encerrado: quitadoFlag || encerradoPelaColuna || VALORES_QUITADO.has(situacaoTxt),
    vencimento: col('vencimento') ?? null,
    atualizacao: col('atualizacao') ?? null,
  }
}

/**
 * Quanto o ERP diz que foi pago neste título, em reais.
 *
 * A ordem de confiança é deliberada: uma flag/situação explícita de "quitado"
 * vale mais que o campo de valor, porque em várias instalações o campo de valor
 * pago só registra baixa PARCIAL e fica zerado quando o título é quitado de uma
 * vez só (foi exatamente o caso de ValorParcialmentePago aqui — ver
 * migrations/contas_financeiras_valor_pago.sql). Confiar só no número faria o
 * sync achar que título quitado está em aberto, que é o bug que estamos matando.
 */
export function calcularValorPagoLegado(legado, valorTituloCrm) {
  const valorTitulo = legado.valor ?? valorTituloCrm ?? 0

  // DINHEIRO vem sempre do valor informado pelo ERP, quando informado. Isto
  // vem ANTES das flags de propósito: na base da Vivenzza existem 2.438
  // duplicatas encerradas com pagamento PARCIAL (acordo, desconto, baixa
  // comercial). Se a flag de encerramento decidisse o valor, o CRM registraria
  // recebimento integral de dinheiro que nunca entrou — mentira contábil.
  // Encerrar a cobrança e registrar o valor recebido são decisões separadas:
  // a primeira sai de `encerrado`, esta aqui só cuida do dinheiro.
  if (legado.valorPagoBruto != null && legado.valorPagoBruto > 0) {
    // Nunca deixa passar do valor do título — juros/multa no ERP não devem
    // virar "crédito" no CRM.
    return Math.min(legado.valorPagoBruto, valorTitulo)
  }

  // Instalações que têm flag/situação de quitação mas não informam o valor
  // pago: quitado sem valor = recebeu tudo.
  if (legado.quitado) return valorTitulo

  // Sem valor, mas com data de baixa preenchida: o ERP considera pago.
  //
  // Heurística mais fraca de todas — só vale quando o ERP NÃO afirmou que o
  // título continua em aberto. Na instalação da Vivenzza, DataPagamento vem
  // preenchida em 16.555 de 17.725 títulos; se ela sozinha decidisse, qualquer
  // título com data antiga e DuplicataAberta='S' seria dado como pago e sairia
  // da cobrança em silêncio. Sinal explícito ganha de heurística, sempre.
  if (legado.dataPagamento && !legado.abertaExplicita) return valorTitulo

  return 0
}

/**
 * Decide o que fazer com um título. Não escreve nada — só devolve a intenção,
 * o que torna o dry-run e os testes triviais.
 *
 * acao:
 *   'nenhuma'  — ERP e CRM já concordam
 *   'atualizar'— ERP tem mais pagamento que o CRM; aplicar
 *   'cancelar' — título cancelado no ERP
 *   'conflito' — CRM tem MAIS pagamento que o ERP; não reverter, sinalizar
 */
export function decidirAtualizacao({ conta, legado }) {
  if (legado.cancelado) {
    return conta.status === 'cancelada'
      ? { acao: 'nenhuma', motivo: 'já cancelado nos dois lados' }
      : { acao: 'cancelar', motivo: 'cancelado no NetVision' }
  }

  const valorTitulo = Number(conta.valor || 0)
  const valorPagoLegado = calcularValorPagoLegado(legado, valorTitulo)
  const valorPagoCrm = Number(conta.valor_pago || 0)
  const valorPagoLegadoAnterior = Number(conta.valor_pago_legado || 0)

  // O CRM reconhece mais pagamento do que o ERP. Pode ser baixa manual ainda
  // não lançada lá, ou estorno lá que não queremos espelhar. Regra do projeto:
  // nunca "desfazer" pagamento automaticamente.
  if (valorPagoCrm > valorPagoLegado + EPSILON) {
    const aindaCobravel = ['aberta', 'vencida', 'pago_parcial'].includes(conta.status)

    // MAS: divergência de VALOR não pode bloquear o "pare de cobrar".
    //
    // A conferência de 13/08 pegou 5 títulos que o NetVision já tinha encerrado
    // e o CRM seguia tratando como cobráveis — justamente porque o conflito de
    // valor abortava antes de aplicar o encerramento. Eram clientes prestes a
    // receber cobrança de dívida quitada, que é o bug que este módulo existe
    // pra matar.
    //
    // Dinheiro e cobrança são decisões separadas: o valor fica como está (a RPC
    // nunca reduz), e o encerramento é aplicado assim mesmo. O erro cai pro
    // lado de não cobrar, que é o lado certo.
    if (legado.encerrado && aindaCobravel) {
      return {
        acao: 'atualizar',
        valorPagoLegado,
        encerrado: true,
        conflitoValor: true,
        statusPrevisto: 'paga',
        motivo: `encerrado no NetVision — para de cobrar. Valor diverge (CRM R$ ${valorPagoCrm.toFixed(2)} x ERP R$ ${valorPagoLegado.toFixed(2)}) e NÃO foi alterado`,
      }
    }

    return {
      acao: 'conflito',
      valorPagoLegado,
      motivo: `CRM registra R$ ${valorPagoCrm.toFixed(2)} pago e o NetVision só R$ ${valorPagoLegado.toFixed(2)} — não reverto pagamento automaticamente`,
    }
  }

  const saldo = valorTitulo - valorPagoLegado
  const encerrado = Boolean(legado.encerrado)

  // Nada mudou desde a última sincronização. O encerramento entra na conta:
  // um título encerrado no ERP com saldo (acordo/desconto) precisa de UMA
  // passada pra parar de ser cobrado, mesmo que o valor pago não tenha mudado.
  const valorIgual = Math.abs(valorPagoLegado - valorPagoLegadoAnterior) < EPSILON && valorPagoLegado <= valorPagoCrm + EPSILON
  const encerramentoJaAplicado = !encerrado || conta.status === 'paga' || conta.status === 'cancelada'
  if (valorIgual && encerramentoJaAplicado) {
    return { acao: 'nenhuma', valorPagoLegado, motivo: 'sem alteração' }
  }

  // `encerrado` decide se a régua para; `valorPagoLegado` decide o dinheiro.
  // Quando o ERP encerra com saldo em aberto, o CRM para de cobrar mas mantém
  // registrado só o que entrou de verdade — a diferença é baixa comercial.
  const motivo = encerrado
    ? saldo <= EPSILON
      ? 'quitado no NetVision'
      : `encerrado no NetVision com saldo de R$ ${saldo.toFixed(2)} (acordo/desconto) — para de cobrar`
    : `baixa parcial no NetVision (saldo R$ ${saldo.toFixed(2)})`

  return {
    acao: 'atualizar',
    valorPagoLegado,
    encerrado,
    statusPrevisto: encerrado || saldo <= EPSILON ? 'paga' : valorPagoLegado > 0 ? 'pago_parcial' : conta.status,
    motivo,
  }
}

/**
 * Converte um valor de data vindo do driver pg (Date | string | null) pro
 * formato 'YYYY-MM-DD' que a RPC espera, sem passar por fuso.
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
