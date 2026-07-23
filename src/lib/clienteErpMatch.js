import { supabase } from './supabase.js'
import { normalizarTelefone, candidatosTelefone } from './telefone.js'

const TIPOS_TELEFONE = ['celular', 'telefone']

// Busca 1x todos os clientes_erp e monta um mapa telefone(dígitos)→cliente.
// 2.034 linhas — trivial em memória, não precisa de índice em contatos (jsonb).
export async function construirMapaTelefonesClientesErp() {
  const { data } = await supabase
    .from('clientes_erp')
    .select('id, legacy_id, razao_social, cnpj_cpf, data_ultima_compra, contatos')

  const mapa = new Map()
  for (const cliente of data ?? []) {
    for (const contato of cliente.contatos ?? []) {
      if (!TIPOS_TELEFONE.includes(contato.tipo)) continue
      const chave = normalizarTelefone(contato.valor)
      if (chave && !mapa.has(chave)) mapa.set(chave, cliente)
    }
  }
  return mapa
}

// candidatosTelefone espera dígitos já limpos — normaliza antes de gerar as variações.
export function encontrarClienteNoMapa(mapa, telefone) {
  const digitos = normalizarTelefone(telefone)
  if (!digitos) return null
  for (const candidato of candidatosTelefone(digitos)) {
    const achado = mapa.get(candidato)
    if (achado) return achado
  }
  return null
}

// Uso pontual (1 lead por vez, ex: lead novo via webhook) — monta o mapa a cada chamada.
export async function buscarClienteErpPorTelefone(telefone) {
  const mapa = await construirMapaTelefonesClientesErp()
  return encontrarClienteNoMapa(mapa, telefone)
}
