import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.SUPABASE_URL

// Prioridade: chaves JWT legacy (eyJ...) primeiro, depois novo formato sb_secret
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_PUBLISHABLE_KEY

if (!supabaseUrl || !supabaseKey) {
  throw new Error(
    'Configure SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY (chave JWT eyJ...) no Railway.'
  )
}

export const supabase = createClient(supabaseUrl, supabaseKey)
