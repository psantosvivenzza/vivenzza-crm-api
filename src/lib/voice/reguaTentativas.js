// Régua de tentativas de ligação de cobrança — lógica PURA (sem rede/ARI/DB
// aqui), mesmo princípio de externalPilotGuardrails.js: recebe o histórico
// como parâmetro e nunca consulta nada sozinha, pra ser 100% testável.
//
// DECISÃO DE NEGÓCIO (17/09/2026, com base na carteira real e na pesquisa de
// mercado — ver doc "Central de Voz" no projeto):
//
// - 10 tentativas por ciclo, distribuídas ao longo de 30 dias. Dez tentativas
//   em uma semana é assédio e é a assinatura que faz a operadora marcar o
//   número como spam; dez ao longo de 30 dias é cobrança profissional.
// - ROTAÇÃO DE FAIXA DE HORÁRIO é a maior alavanca sobre taxa de atendimento:
//   quem não atendeu às 9h dificilmente atende às 9h de novo, mas pode
//   atender às 17h. Por isso duas tentativas seguidas nunca caem na mesma
//   faixa.
// - Contato efetivo trava o ciclo por 7 dias (padrão da Regulation F
//   americana; o Brasil não exige, e é exatamente por isso que adotá-lo por
//   escolha própria vira critério objetivo e defensável contra alegação de
//   cobrança vexatória no Art. 42 do CDC).
// - Promessa de pagamento trava até a data prometida + 1 dia. Ligar para quem
//   já se comprometeu é o jeito mais rápido de perder um cliente bom.
import { createHash } from 'node:crypto'
import { TIMEZONE_COBRANCA, partesHorarioBrt } from './externalPilotGuardrails.js'

export const MAX_TENTATIVAS_CICLO = 10
export const DIAS_TRAVA_POS_CONTATO = 7
export const DIAS_DURACAO_CICLO = 30

// Faixas dentro da janela legal (seg-sex 08:00–18:40). Servem para duas
// coisas: rotacionar as tentativas e MEDIR taxa de atendimento por faixa —
// que é o dado que vai dizer, com evidência, qual o melhor horário para
// falar com salão e distribuidor (a literatura de cobrança é toda de
// consumidor final, e o pico do salão é justamente a tarde/noite).
export const FAIXAS_HORARIO = {
  INICIO_DIA: { inicioMinutos: 8 * 60, fimMinutos: 9 * 60 },
  MANHA: { inicioMinutos: 9 * 60, fimMinutos: 11 * 60 },
  TARDE: { inicioMinutos: 14 * 60, fimMinutos: 16 * 60 },
  FIM_TARDE: { inicioMinutos: 17 * 60, fimMinutos: 18 * 60 + 30 },
}

export const CADENCIA_PADRAO = [
  { tentativa: 1, diaDoCiclo: 0, faixa: 'MANHA' },
  { tentativa: 2, diaDoCiclo: 1, faixa: 'TARDE' },
  { tentativa: 3, diaDoCiclo: 3, faixa: 'INICIO_DIA' },
  { tentativa: 4, diaDoCiclo: 5, faixa: 'FIM_TARDE' },
  { tentativa: 5, diaDoCiclo: 8, faixa: 'MANHA' },
  { tentativa: 6, diaDoCiclo: 11, faixa: 'TARDE' },
  { tentativa: 7, diaDoCiclo: 15, faixa: 'MANHA' },
  { tentativa: 8, diaDoCiclo: 19, faixa: 'TARDE' },
  { tentativa: 9, diaDoCiclo: 24, faixa: 'MANHA' },
  { tentativa: 10, diaDoCiclo: 30, faixa: 'TARDE' },
]

// Chave de contagem por cliente SEM guardar o telefone em texto plano em
// lugar nenhum — nem no banco, nem em log. Normaliza antes pra que
// "+5551991567661" e "51991567661" nunca virem dois clientes diferentes.
export function hashTelefone(numero) {
  const digitos = String(numero ?? '').replace(/\D/g, '')
  if (!digitos) return null
  const semDDI = digitos.startsWith('55') && (digitos.length === 12 || digitos.length === 13)
    ? digitos.slice(2)
    : digitos
  return createHash('sha256').update(semDDI).digest('hex')
}

export function faixaDoHorario(data) {
  const { minutoDoDia } = partesHorarioBrt(data)
  for (const [nome, faixa] of Object.entries(FAIXAS_HORARIO)) {
    if (minutoDoDia >= faixa.inicioMinutos && minutoDoDia < faixa.fimMinutos) return nome
  }
  return 'FORA_DE_FAIXA'
}

// BUG REAL pego pelo teste da cadência: uma data de calendário pura
// ("2026-09-17") é parseada como meia-noite UTC, que em BRT é o dia ANTERIOR
// às 21h. Sem este atalho, o ciclo inteiro andava um dia para trás e toda
// tentativa saía um dia antes do previsto na régua.
function diaBrtISO(data) {
  if (typeof data === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data)) return data
  return new Date(data).toLocaleDateString('en-CA', { timeZone: TIMEZONE_COBRANCA })
}

function diffEmDias(maisRecente, maisAntigo) {
  const umDia = 24 * 60 * 60 * 1000
  return Math.floor((new Date(diaBrtISO(maisRecente)) - new Date(diaBrtISO(maisAntigo))) / umDia)
}

function bloqueio(motivo, extras = {}) {
  return { permitido: false, motivo, tentativaNumero: null, faixaHorario: null, ...extras }
}

/**
 * Decide se PODE fazer a próxima tentativa para este telefone agora.
 *
 * historico: lista de tentativas anteriores DESTE telefone, cada item com
 *   { criadoEm, atendida, dataPrometida, cicloIniciadoEm, faixaHorario }
 *   (ordem não importa — a função ordena).
 *
 * Fail-closed: qualquer dúvida sobre o estado do ciclo bloqueia.
 */
export function avaliarProximaTentativa({
  historico = [],
  agora = new Date(),
  cadencia = CADENCIA_PADRAO,
} = {}) {
  const tentativas = (Array.isArray(historico) ? historico : [])
    .filter((t) => t && t.criadoEm)
    .map((t) => ({ ...t, criadoEm: new Date(t.criadoEm) }))
    .sort((a, b) => b.criadoEm - a.criadoEm)

  const faixaAgora = faixaDoHorario(agora)

  // Ciclo novo: nunca ligamos para este telefone, ou o ciclo anterior expirou.
  const ultima = tentativas[0]
  const cicloExpirado = ultima
    ? diffEmDias(agora, ultima.cicloIniciadoEm ?? ultima.criadoEm) > DIAS_DURACAO_CICLO
    : true

  if (!ultima || cicloExpirado) {
    return {
      permitido: true,
      motivo: null,
      tentativaNumero: 1,
      faixaHorario: faixaAgora,
      cicloIniciadoEm: diaBrtISO(agora),
      cicloNovo: true,
    }
  }

  const cicloIniciadoEm = ultima.cicloIniciadoEm ?? diaBrtISO(ultima.criadoEm)
  const doCiclo = tentativas.filter(
    (t) => (t.cicloIniciadoEm ?? diaBrtISO(t.criadoEm)) === cicloIniciadoEm,
  )

  // 1) Promessa de pagamento trava até a data prometida + 1 dia.
  const promessaAberta = doCiclo
    .filter((t) => t.dataPrometida)
    .map((t) => t.dataPrometida)
    .sort()
    .at(-1)
  if (promessaAberta && diaBrtISO(agora) <= promessaAberta) {
    return bloqueio(`promessa_em_aberto: cliente prometeu pagar em ${promessaAberta}`, {
      cicloIniciadoEm,
      proximaTentativaEm: promessaAberta,
    })
  }

  // 2) Contato efetivo trava o ciclo por 7 dias.
  const ultimoContatoEfetivo = doCiclo.find((t) => t.atendida)
  if (ultimoContatoEfetivo) {
    const diasDesde = diffEmDias(agora, ultimoContatoEfetivo.criadoEm)
    if (diasDesde < DIAS_TRAVA_POS_CONTATO) {
      return bloqueio(
        `trava_pos_contato: falamos com o cliente há ${diasDesde} dia(s); a trava é de ${DIAS_TRAVA_POS_CONTATO}`,
        { cicloIniciadoEm },
      )
    }
  }

  // 3) Teto de tentativas do ciclo.
  const jaFeitas = doCiclo.length
  if (jaFeitas >= MAX_TENTATIVAS_CICLO) {
    return bloqueio(
      `ciclo_esgotado: ${jaFeitas} tentativas neste ciclo (teto ${MAX_TENTATIVAS_CICLO}) — precisa de decisão humana`,
      { cicloIniciadoEm },
    )
  }

  const proxima = cadencia[jaFeitas]
  if (!proxima) return bloqueio('cadencia_sem_proximo_passo', { cicloIniciadoEm })

  // 4) Espaçamento: a tentativa N só pode sair no dia previsto da cadência.
  const diasNoCiclo = diffEmDias(agora, cicloIniciadoEm)
  if (diasNoCiclo < proxima.diaDoCiclo) {
    return bloqueio(
      `cedo_demais: tentativa ${proxima.tentativa} está prevista para D+${proxima.diaDoCiclo} e estamos em D+${diasNoCiclo}`,
      { cicloIniciadoEm, tentativaPrevista: proxima.tentativa },
    )
  }

  // 5) Rotação de faixa: nunca duas seguidas no mesmo período do dia.
  if (faixaAgora !== 'FORA_DE_FAIXA' && ultima.faixaHorario === faixaAgora) {
    return bloqueio(
      `mesma_faixa_da_anterior: a tentativa anterior já foi em ${faixaAgora}; rotacionar o horário é o que aumenta a taxa de atendimento`,
      { cicloIniciadoEm, tentativaPrevista: proxima.tentativa },
    )
  }

  return {
    permitido: true,
    motivo: null,
    tentativaNumero: proxima.tentativa,
    faixaHorario: faixaAgora,
    faixaPrevista: proxima.faixa,
    cicloIniciadoEm,
    cicloNovo: false,
  }
}
