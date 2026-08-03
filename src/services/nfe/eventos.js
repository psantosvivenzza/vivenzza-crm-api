import { supabase } from '../../lib/supabase-admin.server.js'

// Registra um evento fiscal em nfe_eventos (append-only — ver migration
// nfe_eventos.sql). Nunca lança: um erro ao registrar auditoria não pode
// derrubar a operação fiscal em si (a nota já está autorizada/cancelada de
// verdade na SEFAZ nesse ponto, isso não pode ser desfeito por uma falha de log).
export async function registrarEvento({
  nfeId, tipoEvento, statusAnterior, statusNovo,
  cstat, xMotivo, protocolo, correlationId, usuarioId, motivo, ip,
}) {
  try {
    const { error } = await supabase.from('nfe_eventos').insert({
      nfe_id: nfeId,
      tipo_evento: tipoEvento,
      status_anterior: statusAnterior ?? null,
      status_novo: statusNovo ?? null,
      cstat: cstat ?? null,
      xmotivo: xMotivo ?? null,
      protocolo: protocolo ?? null,
      correlation_id: correlationId ?? null,
      usuario_id: usuarioId ?? null,
      motivo: motivo ?? null,
      ip: ip ?? null,
    })
    if (error) console.error('[nfe-eventos] falha ao registrar evento:', error.message)
  } catch (err) {
    console.error('[nfe-eventos] falha ao registrar evento:', err.message)
  }
}
