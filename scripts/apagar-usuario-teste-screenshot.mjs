import 'dotenv/config'
import { supabase } from '../src/lib/supabase.js'

const EMAIL = 'teste.screenshot@vivenzzaprofessional.com.br'
const { error } = await supabase.from('usuarios').delete().eq('email', EMAIL)
if (error) throw error
console.log('Usuário de teste removido:', EMAIL)
