// 2026-08-17 — regra de negócio: cliente com 2+ títulos vencendo na MESMA data
// vira UMA parcela de cobrança (soma dos saldos), nunca N mensagens separadas.
//
// CRÍTICO: isto é só uma camada lógica de agrupamento pra decidir "quantas
// mensagens mandar e com que valor" — não muda nada no banco financeiro.
// Nenhuma função aqui faz UPDATE/INSERT/DELETE em contas_financeiras. Os
// títulos continuam individuais no financeiro; a consolidação existe só na
// hora de montar a mensagem de cobrança.
//
// Puro/sem I/O de propósito — mesmo padrão de reguaCobranca.js.

// Mesma fórmula já usada em paymentGuard.js/cobranca-whatsapp.js — não
// reinventa outra fonte de verdade de saldo cobrável.
export function calcularSaldo(titulo) {
  return Number(titulo.valor || 0) - Number(titulo.valor_pago || 0)
}

// Mesmos critérios de exclusão já usados em paymentGuard.tituloEstaQuitado:
// cancelada, em revisão financeira, ou saldo já zerado/negativo.
export function tituloElegivelParaConsolidacao(titulo) {
  if (titulo.status === 'cancelada') return false
  if (titulo.em_revisao_financeira) return false
  if (calcularSaldo(titulo) <= 0) return false
  return true
}

// Duplicata TÉCNICA real = mesmo legacy_id aparecendo mais de uma vez no grupo
// (reprocessamento de sync criou 2 linhas pro MESMO título lógico). legacy_id
// não tem constraint UNIQUE no banco (ver auditoria 2026-08-17), então isso
// pode acontecer de verdade — dedupar aqui, nunca no banco.
//
// Ambiguidade real: 2+ títulos SEM legacy_id no mesmo grupo — sem identificador
// nenhum pra provar que são títulos distintos (nem que são duplicata), não dá
// pra decidir com segurança. Nesse caso o grupo inteiro fica `ambiguo`.
function analisarIdentificadores(titulos) {
  const vistos = new Map()
  const semIdentificador = []
  for (const t of titulos) {
    if (!t.legacy_id) {
      semIdentificador.push(t)
      continue
    }
    if (!vistos.has(t.legacy_id)) vistos.set(t.legacy_id, t)
    // já visto: duplicata técnica do MESMO título lógico — ignora a repetição
  }
  if (semIdentificador.length >= 2) {
    return { ambiguo: true, motivo: 'sem_legacy_id_multiplo' }
  }
  return { ambiguo: false, deduplicados: [...vistos.values(), ...semIdentificador] }
}

// Agrupa títulos elegíveis por (codigo_cliente, vencimento) e consolida cada
// grupo de 2+ numa única "parcela de cobrança" lógica. Grupos de 1 título
// mantêm o comportamento atual (nenhuma mudança de valor/mensagem).
//
// Retorna um array de grupos: { ambiguo, motivo?, titulos, quantidadeTitulos,
// valorTotal, vencimento, telefone, nome, tituloRepresentante }.
// Grupos ambíguos (`ambiguo:true`) NUNCA devem gerar cobrança automática —
// só reportados pra revisão (ver item 10 do pedido original).
export function agruparParaConsolidacao(titulos) {
  const grupos = new Map()
  let proximoIdSingleton = 0

  for (const t of titulos ?? []) {
    if (!tituloElegivelParaConsolidacao(t)) continue

    // Sem codigo_cliente = sem chave de agrupamento confiável (não existe
    // cliente_id/FK no schema) — nunca agrupa, sempre vira grupo próprio de 1
    // (não inventa outro campo pra suprir isso).
    const chave = t.codigo_cliente
      ? `${t.codigo_cliente}::${t.vencimento}`
      : `singleton::${proximoIdSingleton++}`

    if (!grupos.has(chave)) grupos.set(chave, [])
    grupos.get(chave).push(t)
  }

  const resultado = []
  for (const membros of grupos.values()) {
    const analise = analisarIdentificadores(membros)
    if (analise.ambiguo) {
      resultado.push({ ambiguo: true, motivo: analise.motivo, titulos: membros })
      continue
    }

    const deduplicados = analise.deduplicados
    const telefones = new Set(deduplicados.map((t) => t.telefone_cobranca).filter(Boolean))
    if (telefones.size > 1) {
      resultado.push({ ambiguo: true, motivo: 'telefone_divergente', titulos: deduplicados })
      continue
    }

    const valorTotal = deduplicados.reduce((soma, t) => soma + calcularSaldo(t), 0)
    // id é uuid, não sequencial — "menor" aqui não tem significado de negócio,
    // só precisa ser DETERMINÍSTICO (mesmo grupo sempre escolhe o mesmo
    // representante entre execuções) pra idempotência funcionar corretamente.
    const tituloRepresentante = deduplicados.reduce(
      (min, t) => (min === null || String(t.id) < String(min.id) ? t : min),
      null,
    )

    resultado.push({
      ambiguo: false,
      titulos: deduplicados,
      quantidadeTitulos: deduplicados.length,
      valorTotal,
      vencimento: deduplicados[0].vencimento,
      telefone: deduplicados[0].telefone_cobranca || null,
      nome: deduplicados[0].pessoa_nome,
      tituloRepresentante,
    })
  }
  return resultado
}
