import { supabase } from './supabase.js'
import { normalizarTelefone, candidatosTelefone } from './telefone.js'

// Valores reais encontrados em clientes_erp.contatos.tipo (verificado direto no banco):
// celular (1577), email (588), fone (152), contato (77 — campo livre, mistura telefone
// e nome de pessoa; normalizarTelefone já retorna null pra valor sem dígito, então incluir
// aqui é seguro). "telefone" nunca apareceu de fato, mas mantido por segurança.
const TIPOS_TELEFONE = ['celular', 'fone', 'telefone', 'contato']

// Busca 1x todos os clientes_erp e monta um mapa telefone(dígitos)→cliente.
// 2.034 linhas — trivial em memória, não precisa de índice em contatos (jsonb).
export async function construirMapaTelefonesClientesErp() {
  // Supabase limita a 1000 linhas por resposta — sem paginar, ~metade dos 2.034
  // clientes_erp nunca entrava no mapa (bug real: achado ao investigar por que um
  // match confirmado manualmente não aparecia no backfill).
  const clientes = []
  const PAGE = 1000
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase
      .from('clientes_erp')
      .select('id, legacy_id, razao_social, cnpj_cpf, data_ultima_compra, contatos')
      .range(offset, offset + PAGE - 1)
    if (error) throw error
    clientes.push(...data)
    if (data.length < PAGE) break
  }

  const mapa = new Map()
  for (const cliente of clientes) {
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
