// Cria um usuário admin sintético temporário só pra login do Playwright tirar
// screenshots do redesign visual (as credenciais do super-admin salvas no
// script antigo de screenshot estão desatualizadas). Apaga com
// scripts/apagar-usuario-teste-screenshot.mjs assim que as capturas terminarem.
import 'dotenv/config'
import bcrypt from 'bcryptjs'
import { supabase } from '../src/lib/supabase-admin.server.js'

const EMAIL = 'teste.screenshot@vivenzzaprofessional.com.br'
const SENHA = 'TesteScreenshot2026!'

const hash = await bcrypt.hash(SENHA, 10)

const { data: existente } = await supabase.from('usuarios').select('id').eq('email', EMAIL).maybeSingle()
if (existente) {
  await supabase.from('usuarios').update({ senha_hash: hash, ativo: true, role: 'admin' }).eq('id', existente.id)
  console.log('Usuário de teste já existia — senha redefinida. id:', existente.id)
} else {
  const { data, error } = await supabase.from('usuarios').insert({
    nome: 'Teste Screenshot - APAGAR', email: EMAIL, senha_hash: hash, role: 'admin', ativo: true,
  }).select('id').single()
  if (error) throw error
  console.log('Usuário de teste criado. id:', data.id)
}

console.log('EMAIL:', EMAIL)
console.log('SENHA:', SENHA)
