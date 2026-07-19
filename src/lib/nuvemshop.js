import axios from 'axios'
import { supabase } from './supabase.js'

const API_VERSION = '2025-03'
const USER_AGENT = 'VivenzzaContentBot (psantos@vivenzzaprofessional.com.br)'
const MIN_INTERVAL_MS = 550 // ~2 req/s com folga

let _lastRequestAt = 0

async function throttle() {
  const espera = MIN_INTERVAL_MS - (Date.now() - _lastRequestAt)
  if (espera > 0) await new Promise((r) => setTimeout(r, espera))
  _lastRequestAt = Date.now()
}

// Credenciais são salvas no Supabase (não em env var do Railway) para que o
// callback OAuth funcione sem precisar de redeploy manual logo após o
// "Aceitar" na tela de autorização da loja.
export async function saveCredentials({ storeId, accessToken, tokenType, scope }) {
  const { error } = await supabase
    .from('nuvemshop_credentials')
    .upsert(
      {
        store_id: String(storeId),
        access_token: accessToken,
        token_type: tokenType ?? null,
        scope: scope ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'store_id' }
    )
  if (error) throw new Error(`Falha ao salvar credenciais Nuvemshop no Supabase: ${error.message}`)
}

export async function getCredentials() {
  const { data, error } = await supabase
    .from('nuvemshop_credentials')
    .select('store_id, access_token, token_type, scope')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`Falha ao buscar credenciais Nuvemshop no Supabase: ${error.message}`)
  return data
}

// Requisição autenticada à API da Nuvemshop.
// Atenção: o header de auth é "Authentication" (não "Authorization"), valor
// "bearer {token}" em minúsculas — desvio da convenção usual documentado pela
// Nuvemshop que costuma gerar 401 se implementado como "Authorization: Bearer".
export async function nuvemshopRequest({ method, path, data, params, headers }) {
  const creds = await getCredentials()
  if (!creds?.access_token || !creds?.store_id) {
    throw new Error('Integração Nuvemshop ainda não conectada — complete o fluxo OAuth em /api/nuvemshop/oauth/callback primeiro')
  }

  await throttle()

  const baseURL = `https://api.nuvemshop.com.br/${API_VERSION}/${creds.store_id}`

  return axios({
    method,
    url: `${baseURL}${path}`,
    data,
    params,
    headers: {
      'User-Agent': USER_AGENT,
      Authentication: `bearer ${creds.access_token}`,
      ...(headers ?? { 'Content-Type': 'application/json' }),
    },
    timeout: 30000,
  })
}
