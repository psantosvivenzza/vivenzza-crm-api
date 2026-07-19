import axios from 'axios'

export function wordpressConfigurado() {
  const { WORDPRESS_URL, WORDPRESS_USER, WORDPRESS_APP_PASSWORD } = process.env
  return !!(WORDPRESS_URL && WORDPRESS_USER && WORDPRESS_APP_PASSWORD)
}

function authHeader() {
  const { WORDPRESS_USER, WORDPRESS_APP_PASSWORD } = process.env
  const token = Buffer.from(`${WORDPRESS_USER}:${WORDPRESS_APP_PASSWORD}`).toString('base64')
  return `Basic ${token}`
}

// Requisição autenticada à REST API do WordPress (wp-json/wp/v2), via
// Basic Auth com usuário + Application Password (não a senha normal da conta).
export async function wordpressRequest({ method, path, data, params, headers }) {
  if (!wordpressConfigurado()) {
    throw new Error('WordPress não configurado — defina WORDPRESS_URL, WORDPRESS_USER e WORDPRESS_APP_PASSWORD')
  }

  const baseURL = process.env.WORDPRESS_URL.replace(/\/$/, '')

  return axios({
    method,
    url: `${baseURL}/wp-json/wp/v2${path}`,
    data,
    params,
    headers: {
      Authorization: authHeader(),
      ...(headers ?? { 'Content-Type': 'application/json' }),
    },
    timeout: 30000,
  })
}
