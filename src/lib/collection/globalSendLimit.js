// Teto GLOBAL de envio financeiro — soma TODOS os envios reais de cobrança
// (cron, /disparar, /disparar-individual — qualquer origem, qualquer
// instância/motor legado ou v2) contra automacoes_config.global_daily_limit/
// global_hourly_limit.
//
// ACHADO (2026-08-15): esses dois campos já existiam em automacoes_config —
// inclusive um comentário em whatsappInstances.js afirmava que "o
// dispatchEngine já aplica [o limite por hora] de forma exata" — mas nenhum
// arquivo de src/ jamais lia global_daily_limit/global_hourly_limit. O único
// teto que de fato existia (LIMITE_DIARIO/LIMITE_POR_HORA, hardcoded em
// cobranca-whatsapp.js) protege o caminho cron/disparo em massa, mas nunca
// cobriu /disparar-individual (disparo manual por cliente) — esse caminho
// não tinha NENHUM teto.
//
// Este módulo fecha as duas lacunas de uma vez, chamado do ponto único de
// roteamento (collectionRouting.js), ANTES de escolher motor legado ou v2 —
// protege os dois caminhos de forma idêntica e continua valendo se/quando
// multi_whatsapp for ativado. O contador nunca reinicia ao trocar de
// instância: cobrancas_whatsapp não tem coluna de instância nem de motor —
// é uma tabela por natureza agnóstica a isso, contando o resultado final de
// cada cobrança lógica (1 linha por dispatch bem-sucedido, nunca 1 por
// tentativa/retry/failover interno).
//
// NÃO substitui limites por instância (whatsappInstances.js:instanciaApta) —
// os dois precisam permitir para o envio prosseguir. A ordem natural (global
// checado aqui, antes de qualquer seleção de instância) já implementa
// "global AND instância" por curto-circuito, sem precisar combinar as duas
// checagens numa função só.
//
// CORREÇÃO 2026-08-18 — gap comprovado: contarEnviosDesde() só contava
// SUCESSO (cobrancas_whatsapp), então uma rajada de falhas reais (número
// inválido, timeout, 429...) nunca consumia o teto, mesmo cada uma sendo
// uma chamada HTTP real contra o provedor. Delega pra
// providerAttemptCounter.js (fonte canônica de tentativa real, engine-aware
// — ver comentário lá pro racional completo e o gap conhecido/não fechado
// do motor legado).
import { obterConfigCobranca } from './featureFlags.js'
import { contarTentativasReaisDesde } from './providerAttemptCounter.js'

function inicioDoDiaBrtISO() {
  const hojeBrt = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
  return `${hojeBrt}T03:00:00.000Z` // meia-noite BRT = 03:00 UTC (BRT fixo UTC-3, sem DST desde 2019)
}

function inicioDaHoraAtualISO() {
  const agora = new Date()
  agora.setUTCMinutes(0, 0, 0)
  return agora.toISOString()
}

// TODA origem (cron + manual) — é isso que torna o teto verdadeiramente
// global, ao contrário do contador só-cron que já existia em
// cobranca-whatsapp.js (contarEnviadasCronDesde, .eq('origem','cron')).
async function contarEnviosDesde(isoDesde) {
  return contarTentativasReaisDesde({ desde: isoDesde })
}

/**
 * Único ponto de decisão do teto GLOBAL. `null`/ausente em
 * global_daily_limit ou global_hourly_limit desativa aquele teto específico
 * (mesma semântica de daily_limit por instância em whatsappInstances.js) —
 * os defaults em featureFlags.js (30/10) garantem que nunca fica
 * "ausente == sem limite" por acidente de configuração vazia.
 */
export async function verificarLimiteGlobalEnvio() {
  const config = await obterConfigCobranca()
  const limiteDiario = config.global_daily_limit
  const limiteHorario = config.global_hourly_limit

  const contagemDia = await contarEnviosDesde(inicioDoDiaBrtISO())
  if (limiteDiario != null && contagemDia >= limiteDiario) {
    return { permitido: false, motivo: 'limite_global_diario', contagem_dia: contagemDia, limite_dia: limiteDiario }
  }

  const contagemHora = await contarEnviosDesde(inicioDaHoraAtualISO())
  if (limiteHorario != null && contagemHora >= limiteHorario) {
    return { permitido: false, motivo: 'limite_global_horario', contagem_hora: contagemHora, limite_hora: limiteHorario }
  }

  return {
    permitido: true, motivo: null,
    contagem_dia: contagemDia, contagem_hora: contagemHora,
    limite_dia: limiteDiario, limite_hora: limiteHorario,
  }
}
