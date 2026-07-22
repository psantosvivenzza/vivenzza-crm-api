import axios from 'axios'

// Resolve o código IBGE de 7 dígitos (cMun) de um município a partir do nome + UF —
// usado pra preencher o cMun do destinatário na NFe dinamicamente, em vez de um
// valor fixo (ver auditoria do módulo NF-e). API pública, sem chave.
const BASE_URL = 'https://servicodados.ibge.gov.br/api/v1/localidades/estados'

const _cachePorUf = new Map() // UF -> [{ id, nome }]

function normalizar(s) {
  return (s || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
}

async function municipiosDaUf(uf) {
  const ufNorm = normalizar(uf)
  if (_cachePorUf.has(ufNorm)) return _cachePorUf.get(ufNorm)

  const { data } = await axios.get(`${BASE_URL}/${ufNorm}/municipios`, { timeout: 10000 })
  const lista = (data || []).map((m) => ({ id: String(m.id), nome: normalizar(m.nome) }))
  _cachePorUf.set(ufNorm, lista)
  return lista
}

// Retorna o código de 7 dígitos ou null se não encontrar (UF inválida, nome não bate,
// API fora do ar etc.) — o chamador decide o que fazer com null, nunca inventa um código.
export async function buscarCodigoMunicipio(uf, nomeMunicipio) {
  if (!uf || !nomeMunicipio) return null
  try {
    const lista = await municipiosDaUf(uf)
    const alvo = normalizar(nomeMunicipio)
    const match = lista.find((m) => m.nome === alvo) || lista.find((m) => m.nome.includes(alvo) || alvo.includes(m.nome))
    return match?.id ?? null
  } catch (err) {
    console.error('[ibge] falha ao resolver cMun:', err.message)
    return null
  }
}
