// Política de contato centralizada — horário, dia da semana e timezone (America/Sao_Paulo)
// num único lugar. A auditoria encontrou isso espalhado e inconsistente:
// src/jobs/cobranca-whatsapp.js calcula hora BRT por aritmética (UTC-3 fixo, Brasil não
// observa DST desde 2019) mas NUNCA checa dia da semana em JS — depende 100% da
// expressão cron (`*/15 11-20 * * 1-5`) pra não rodar fim de semana. Isso significa que
// um disparo manual em massa num sábado passaria pela checagem de horário sem bloqueio
// algum. Este módulo corrige isso oferecendo uma checagem completa (hora + dia) que
// TODO caminho de disparo (cron, manual, NBA) deve usar a partir de agora — sem
// remover a proteção do cron em si (defesa em profundidade, não substituição).
//
// Mensagens/WhatsApp e ligações têm janelas potencialmente diferentes — por isso
// aceitam overrides, mas os defaults reproduzem exatamente o comportamento atual.
const TIMEZONE = 'America/Sao_Paulo'

// Brasil não observa horário de verão desde 2019 — BRT = UTC-3 fixo.
function horaBrtAgora() {
  return (new Date().getUTCHours() - 3 + 24) % 24
}

// getUTCDay() em UTC-3: só vira o dia seguinte às 21h UTC (18h BRT) — dentro da
// janela comercial (até 17h59 BRT) o dia UTC e o dia BRT são sempre os mesmos,
// então dá pra usar getUTCDay() direto sem conversão adicional.
function diaDaSemanaBrtAgora() {
  return new Date().getUTCDay() // 0=domingo ... 6=sábado
}

export function diaUtilBrt() {
  const dia = diaDaSemanaBrtAgora()
  return dia >= 1 && dia <= 5
}

export function dentroDaJanela({ horaInicio, horaFim, somenteDiasUteis = true }) {
  if (somenteDiasUteis && !diaUtilBrt()) return false
  const hora = horaBrtAgora()
  return hora >= horaInicio && hora < horaFim
}

// Janela padrão do WhatsApp de cobrança — idêntica ao que já existe em
// cobranca-whatsapp.js (HORA_INICIO_BRT=8, HORA_FIM_BRT=17), agora com a checagem
// de dia útil que faltava.
export function dentroDaJanelaWhatsapp() {
  return dentroDaJanela({ horaInicio: 8, horaFim: 17, somenteDiasUteis: true })
}

// Janela de ligações — configurável separadamente (FASE 9/10), default igual à de
// WhatsApp até haver necessidade de diferenciar.
export function dentroDaJanelaLigacao({ horaInicio = 8, horaFim = 17 } = {}) {
  return dentroDaJanela({ horaInicio, horaFim, somenteDiasUteis: true })
}

export function hojeBrtISO() {
  return new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE }) // YYYY-MM-DD
}

export function diasAtrasoDe(vencimento) {
  const hojeBrt = hojeBrtISO()
  const umDia = 24 * 60 * 60 * 1000
  return Math.floor((new Date(hojeBrt) - new Date(vencimento)) / umDia)
}

export const COLLECTION_TIMEZONE = TIMEZONE
