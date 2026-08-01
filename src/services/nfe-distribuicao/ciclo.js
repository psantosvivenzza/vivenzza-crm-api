// Decide se um ciclo de sincronização de Distribuição DF-e deve rodar agora
// — combina a trava de negócio (entrada_sync_ativa, configuracoes_fiscais)
// com a trava técnica de throttling da SEFAZ (podeConsultar, cursor.js).
// Puro — sem I/O, sem rede — pra ser testável sem precisar de banco nem de
// um certificado válido.
import { podeConsultar } from './cursor.js'

// config: linha de `configuracoes_fiscais` (só usa entrada_sync_ativa aqui —
// a trava de manifestação automática é avaliada depois, por documento, em
// manifestacao-decisao.js).
// estadoNsu: linha de `nfe_distribuicao_nsu` para o (cnpj, ambiente) sendo
// sincronizado — ou null se ainda não existe (primeira vez).
// agora: Date injetado (testável sem depender do relógio real).
export function decidirCicloDeSincronizacao(config, estadoNsu, agora) {
  if (!config?.entrada_sync_ativa) {
    return { deveConsultar: false, motivo: 'sincronização automática está desligada em configuracoes_fiscais' }
  }

  const estado = estadoNsu || { ultima_sincronizacao: null, ultimo_cstat: null }
  const { pode, motivo, proximaTentativaEmMs } = podeConsultar(estado, agora)

  return {
    deveConsultar: pode,
    motivo,
    proximaTentativaEmMs: proximaTentativaEmMs ?? null,
    ultNsuParaConsulta: estado.ult_nsu || '000000000000000',
  }
}
