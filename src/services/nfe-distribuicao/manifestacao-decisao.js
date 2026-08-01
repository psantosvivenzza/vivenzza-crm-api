// Decide se um documento recebido via Distribuição DF-e deve disparar
// manifestação automática do destinatário — pura lógica de decisão, sem
// chamada de rede nem efeito colateral. A chamada real ao webservice de
// manifestação (Fase B, ainda não implementada) usa o resultado disto.
//
// Regra de segurança inegociável (definida com o Peterson): manifestação
// automática, quando ligada, SÓ pode ser "Ciência da Operação" — o único
// evento que não afirma nada sobre a operação em si e é livremente
// reversível. "Confirmação da Operação" e "Desconhecimento da Operação"
// nunca são automáticos, mesmo com a trava geral ligada — exigem decisão
// humana explícita por nota, porque têm consequência fiscal/contratual real.

const CIENCIA_DA_OPERACAO = 'ciencia_operacao'

// configuracoesFiscais: linha da tabela `configuracoes_fiscais`
//   { entrada_sync_ativa, entrada_manifestacao_automatica, entrada_manifestacao_tipo_automatico }
// documento: { tipo: 'resNFe'|'resEvento', chave_acesso, ja_manifestado: boolean }
export function decidirManifestacaoAutomatica(configuracoesFiscais, documento) {
  if (!configuracoesFiscais.entrada_sync_ativa) {
    return { deveManifestarAutomaticamente: false, motivo: 'sincronização automática está desligada' }
  }

  if (!configuracoesFiscais.entrada_manifestacao_automatica) {
    return { deveManifestarAutomaticamente: false, motivo: 'manifestação automática está desligada — precisa ser liberada explicitamente pelo Peterson' }
  }

  if (documento.tipo !== 'resNFe') {
    return { deveManifestarAutomaticamente: false, motivo: `documento do tipo "${documento.tipo}" não é uma NF-e destinada à Vivenzza — nada a manifestar` }
  }

  if (documento.ja_manifestado) {
    return { deveManifestarAutomaticamente: false, motivo: 'nota já foi manifestada anteriormente — evita manifestação duplicada' }
  }

  // Trava inegociável: mesmo que a configuração algum dia viesse com um valor
  // diferente (bug de UI, dado corrompido, etc.), o único tipo que sai daqui
  // é Ciência da Operação. Isto não é configurável para nenhum outro valor.
  if (configuracoesFiscais.entrada_manifestacao_tipo_automatico !== CIENCIA_DA_OPERACAO) {
    return {
      deveManifestarAutomaticamente: false,
      motivo: `tipo de manifestação automática configurado ("${configuracoesFiscais.entrada_manifestacao_tipo_automatico}") não é "ciencia_operacao" — por segurança, só Ciência da Operação pode ser automática; corrija a configuração`,
    }
  }

  return {
    deveManifestarAutomaticamente: true,
    tipoEvento: CIENCIA_DA_OPERACAO,
    motivo: 'sincronização e manifestação automática ligadas, documento é uma NF-e nova, ainda não manifestada',
  }
}
