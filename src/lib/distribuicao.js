import { supabase } from './supabase.js'

// Rodízio atômico entre vendedores ativos — ver função proximo_vendedor_atomic()
// no Postgres (lock FOR UPDATE em distribuicao_leads.id=1, evita race condition
// entre chamadas concorrentes). Usado por qualquer fluxo de criação de lead que
// precise de distribuição automática (webhook do WhatsApp, formulário público).
export async function proximoVendedor() {
  const { data, error } = await supabase.rpc('proximo_vendedor_atomic')
  if (error) {
    console.error('[distribuicao] proximoVendedor RPC erro:', error.message)
    return null
  }
  return data?.[0] ?? null
}
