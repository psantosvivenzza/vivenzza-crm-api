// Qualificação de leads B2B da Vivenzza (Lara). Funções PURAS — sem rede e sem
// banco — para serem testáveis. As consultas externas ficam em
// qualificacaoLookup.js e entram por injeção.

export const PEDIDO_MINIMO = 5000
export const VOLUME_MENSAL_MINIMO = 3000
export const ENTRADA_PERCENTUAL = 40

export function normalizarTexto(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9' ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

export function soDigitos(s) {
  return String(s ?? '').replace(/\D/g, '')
}

export function cnpjValido(valor) {
  const c = soDigitos(valor)
  if (c.length !== 14 || /^(\d)\1+$/.test(c)) return false
  const dv = (base) => {
    const pesos = base.length === 12
      ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
      : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
    const soma = base.split('').reduce((acc, d, i) => acc + Number(d) * pesos[i], 0)
    const r = soma % 11
    return r < 2 ? 0 : 11 - r
  }
  const d1 = dv(c.slice(0, 12))
  const d2 = dv(c.slice(0, 12) + d1)
  return c.endsWith(`${d1}${d2}`)
}

// Cidade já tem distribuidor? `territorio` = [{cidade, estado}] ativos.
export function cidadeOcupada(cidade, estado, territorio = []) {
  const c = normalizarTexto(cidade)
  const uf = String(estado ?? '').trim().toUpperCase()
  if (!c) return null // desconhecido
  return territorio.some(
    (t) => normalizarTexto(t.cidade) === c && (!uf || String(t.estado).toUpperCase() === uf)
  )
}

function numeroOuNulo(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : null
}

// Entrada: o que a Lara extraiu da conversa (bloco `qualificacao` do JSON).
// Contexto: resultados das verificações externas.
//   cnpjStatus: 'ativo' | 'inativo' | 'desconhecido'
//   inadimplente: boolean (débito vencido conosco)
export function avaliarLead(q = {}, ctx = {}) {
  const perfil = ['distribuidor', 'salao', 'consumidor_final'].includes(q.perfil) ? q.perfil : 'indefinido'
  const cnpj = q.cnpj === 'sim' || q.cnpj === 'nao' ? q.cnpj : 'desconhecido'
  const volume = numeroOuNulo(q.volume_mensal)
  const ocupada = cidadeOcupada(q.cidade, q.estado, ctx.territorio)
  const cnpjStatus = ctx.cnpjStatus ?? 'desconhecido'

  // BLOQUEIO: CNPJ baixado/inapto ou débito vencido conosco → lead não flui.
  if (cnpj === 'sim' && (cnpjStatus === 'inativo' || ctx.inadimplente === true)) {
    return {
      nota: 0, faixa: 'bloqueado', regiao_valida: ocupada === null ? null : !ocupada,
      motivo: ctx.inadimplente ? 'debito_vencido' : 'cnpj_inativo',
      repassar_vendedora: false,
    }
  }

  let nota = 0
  if (perfil === 'distribuidor') nota += 20
  else if (perfil === 'salao') nota += 12
  else if (perfil === 'indefinido') nota += 4

  if (cnpj === 'sim') nota += 25
  if (cnpj === 'sim' && cnpjStatus === 'ativo') nota += 5

  if (ocupada === false) nota += 15
  else if (ocupada === null) nota += 4

  if (volume !== null) {
    if (volume >= PEDIDO_MINIMO) nota += 30
    else if (volume >= VOLUME_MENSAL_MINIMO) nota += 25
    else if (volume > 0) nota += 8
  }

  // Engajamento: respondeu as 4 perguntas.
  const respondidas = [perfil !== 'indefinido', cnpj !== 'desconhecido', ocupada !== null, volume !== null]
    .filter(Boolean).length
  if (respondidas === 4) nota += 5

  nota = Math.max(0, Math.min(100, nota))

  // Quente só com TODOS os requisitos: CNPJ + volume mínimo + região livre.
  const quente =
    perfil !== 'consumidor_final' && cnpj === 'sim' && volume !== null &&
    volume >= VOLUME_MENSAL_MINIMO && ocupada === false
  let faixa
  if (quente) faixa = 'quente'
  else if (perfil === 'consumidor_final' || nota < 40) faixa = 'frio'
  else faixa = 'morno'

  // A nota nunca contradiz a faixa: só quem cumpre TODOS os requisitos passa de 69.
  nota = quente ? Math.max(nota, 70) : Math.min(nota, 69)

  return {
    nota, faixa, regiao_valida: ocupada === null ? null : !ocupada,
    motivo: null,
    // Regra do dono: desqualificado (consumidor, preço barato) AINDA vai para a
    // vendedora, só que com nota baixa. Só o bloqueio acima não é repassado.
    repassar_vendedora: true,
  }
}

export function condicaoComercial() {
  return `Pedido mínimo ${PEDIDO_MINIMO.toLocaleString('pt-BR')} reais e entrada de ${ENTRADA_PERCENTUAL}%.`
}
