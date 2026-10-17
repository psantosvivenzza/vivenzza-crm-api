// Envio de WhatsApp via Evolution API — mesmo padrão de src/jobs/meta-report.js
// (mesmas env vars, já configuradas no Railway para o relatório diário). Extraído
// para lib porque o guard de budget (src/jobs/meta-budget-guard.js) precisa do
// mesmo envio e não faz sentido duplicar a chamada axios.
import axios from 'axios'

const { EVOLUTION_API_URL, EVOLUTION_API_KEY, EVOLUTION_INSTANCE, WHATSAPP_REPORT_NUMBER } = process.env

export async function enviarAlertaWhatsapp(texto) {
  if (!EVOLUTION_API_URL || !EVOLUTION_INSTANCE || !WHATSAPP_REPORT_NUMBER) {
    console.warn('[whatsapp-alert] WhatsApp não configurado — pulando envio:', texto)
    return
  }
  await axios.post(
    `${EVOLUTION_API_URL}/message/sendText/${EVOLUTION_INSTANCE}`,
    { number: WHATSAPP_REPORT_NUMBER, text: texto },
    {
      headers: { apikey: EVOLUTION_API_KEY },
      // O alerta não pode prender indefinidamente o ciclo financeiro ou os
      // outros jobs que o aguardam. Cancela o transporte, sem retry: timeout
      // não comprova que o destinatário deixou de receber a mensagem.
      timeout: 15000,
      signal: AbortSignal.timeout(15000),
    }
  )
}
