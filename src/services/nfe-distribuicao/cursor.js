// Lógica pura de controle do cursor de NSU e da trava anti "consumo indevido"
// do webservice nacional NFeDistribuicaoDFe (NT 2014.002, vigente desde
// 10/03/2022). Sem I/O — só decide QUANDO é seguro consultar e COMO avançar
// o cursor, dado o estado salvo em `nfe_distribuicao_nsu`.
//
// Regra confirmada (busca web, 01/08/2026, NT 2014.002):
// - Depois de um retorno cStat=137 ("nenhum documento localizado"), é preciso
//   esperar 1 HORA COMPLETA antes de consultar de novo — bater antes disso
//   gera cStat=656 (consumo indevido) e um bloqueio de 60min que REINICIA a
//   contagem se insistir antes de completar a hora.
// - Toda consulta subsequente tem que usar o ultNSU da resposta anterior —
//   nunca pular ou repetir fora de ordem.
// - Limite de ~20 consultas/hora por chave/NSU.

const UMA_HORA_MS = 60 * 60 * 1000

// Decide se é seguro fazer uma nova consulta agora, dado o estado salvo.
// estado: { ultima_sincronizacao: Date|string|null, ultimo_cstat: string|null }
// agora: Date (injetado para ser testável sem depender do relógio real)
export function podeConsultar(estado, agora) {
  if (!estado.ultima_sincronizacao) {
    return { pode: true, motivo: 'primeira consulta — nenhum histórico de sincronização' }
  }

  const ultimaSync = new Date(estado.ultima_sincronizacao)
  const decorridoMs = agora.getTime() - ultimaSync.getTime()

  // Regra NT 2014.002: cStat=137 (nada novo) exige esperar 1h completa.
  // Tratamos qualquer último status diferente de "138 — documentos localizados"
  // com a mesma cautela (inclui erros e 656) — nunca reduzimos o intervalo de
  // segurança por otimismo.
  if (decorridoMs < UMA_HORA_MS) {
    const restanteMs = UMA_HORA_MS - decorridoMs
    return {
      pode: false,
      motivo: `última consulta há ${Math.round(decorridoMs / 60000)}min (cStat=${estado.ultimo_cstat || 'desconhecido'}) — NT 2014.002 exige aguardar 1h completa entre consultas`,
      proximaTentativaEmMs: restanteMs,
    }
  }

  return { pode: true, motivo: `${Math.round(decorridoMs / 60000)}min desde a última consulta — dentro da janela segura` }
}

// Avança o cursor de NSU com base na resposta da SEFAZ, validando que o NSU
// nunca regride (proteção contra reprocessar o mesmo lote por engano ou
// aplicar uma resposta corrompida/fora de ordem).
// estadoAtual: { ult_nsu: string (15 dígitos) }
// respostaSefaz: { ultNSU: string, maxNSU: string, cStat: string }
export function avancarCursor(estadoAtual, respostaSefaz) {
  const ultNsuAtual = BigInt(estadoAtual.ult_nsu)
  const ultNsuNovo = BigInt(respostaSefaz.ultNSU)
  const maxNsuNovo = BigInt(respostaSefaz.maxNSU)

  if (ultNsuNovo < ultNsuAtual) {
    throw new Error(
      `NSU da resposta (${respostaSefaz.ultNSU}) é MENOR que o NSU já processado (${estadoAtual.ult_nsu}) — ` +
      'isso não deveria acontecer nunca; resposta rejeitada para não reprocessar ou corromper o cursor.'
    )
  }

  const sincronizadoAteOFim = ultNsuNovo >= maxNsuNovo

  return {
    ult_nsu: respostaSefaz.ultNSU.padStart(15, '0'),
    max_nsu: respostaSefaz.maxNSU.padStart(15, '0'),
    sincronizado_ate_o_fim: sincronizadoAteOFim,
    avancou: ultNsuNovo > ultNsuAtual,
  }
}
