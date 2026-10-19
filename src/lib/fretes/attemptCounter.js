import { supabase } from '../supabase-admin.server.js'
import { FRETE_INSTANCE } from './domain.js'

// Instalação do schema permanece habilitada mesmo se os envios forem pausados:
// tentativas anteriores continuam no histórico de frete, sem debitar cobrança.
export async function contarTentativasFrete(desde) {
  if (process.env.FRETE_MODULO_INSTALADO !== 'true') return 0
  const { count, error } = await supabase.from('frete_envios').select('id', { count: 'exact', head: true }).gte('attempted_at', desde).eq('instance_name', FRETE_INSTANCE)
  if (error) throw error
  return count ?? 0
}
