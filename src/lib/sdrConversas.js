import { supabase } from './supabase.js'
import { candidatosTelefone } from './telefone.js'

// Marca que o vendedor assumiu a conversa manualmente — usado pelo whatsapp.js (quando
// a vendedora envia mensagem pelo CRM) e pelo reativacao.js (quando o cliente responde
// a um follow-up automático). Fica num módulo sem dependência de rota pra evitar import
// circular (sdr.js -> webhook-handler.js -> reativacao.js -> sdr.js).
export async function marcarVendedorAssumiu(telefone) {
  try {
    const candidatos = candidatosTelefone(telefone)
    const { data: existentes } = await supabase
      .from('sdr_conversas')
      .select('telefone')
      .in('telefone', candidatos)
      .order('ultimo_contato', { ascending: false })
      .limit(1)

    const telefoneConversa = existentes?.[0]?.telefone || telefone
    await supabase.from('sdr_conversas').upsert(
      {
        telefone: telefoneConversa,
        status_atendimento: 'vendedor_assumiu',
        ultimo_contato: new Date().toISOString(),
      },
      { onConflict: 'telefone' }
    )
  } catch (err) {
    console.error('[sdr] erro ao marcar vendedor_assumiu:', err.message)
  }
}
