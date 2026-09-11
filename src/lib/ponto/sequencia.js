// Os 4 tipos organizam a interface, mas uma sequência inesperada NUNCA
// apaga nem impede uma marcação legítima — só sinaliza para revisão humana
// (ver docs/meu-ponto/ESPECIFICACAO_MEU_PONTO.md, seção 2.3/2.6). Isto é
// puramente informativo: o retorno é usado para marcar
// sinalizado_para_revisao, nunca para bloquear o insert.
const SEQUENCIA = ['entrada', 'saida_intervalo', 'retorno_intervalo', 'saida']

export function proximoTipoEsperado(ultimoTipo) {
  if (!ultimoTipo) return 'entrada'
  const indice = SEQUENCIA.indexOf(ultimoTipo)
  if (indice === -1) return null
  return SEQUENCIA[(indice + 1) % SEQUENCIA.length]
}

export function avaliarSequencia(ultimoTipo, tipoAtual) {
  const esperado = proximoTipoEsperado(ultimoTipo)
  if (esperado === null || esperado === tipoAtual) {
    return { sinalizar: false, motivo: null }
  }
  return {
    sinalizar: true,
    motivo: `sequencia_inesperada: esperava "${esperado}" (após "${ultimoTipo}"), recebeu "${tipoAtual}"`,
  }
}
