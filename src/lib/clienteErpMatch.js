import { supabase } from './supabase-admin.server.js'
import { normalizarTelefone, candidatosTelefone } from './telefone.js'
import { criarCircuitBreaker } from './circuitBreaker.js'

// Valores reais encontrados em clientes_erp.contatos.tipo (verificado direto no banco):
// celular (1577), email (588), fone (152), contato (77 — campo livre, mistura telefone
// e nome de pessoa; normalizarTelefone já retorna null pra valor sem dígito, então incluir
// aqui é seguro). "telefone" nunca apareceu de fato, mas mantido por segurança.
const TIPOS_TELEFONE = ['celular', 'fone', 'telefone', 'contato']

// Contenção de cascata (incidente 2026-09-28, ver src/routes/leads.js): esta
// função é chamada a cada evento do webhook do WhatsApp que precisa casar o
// contato com um cliente do ERP (buscarClienteErpPorTelefone, "uso pontual")
// — sem timeout nem teto de páginas, uma degradação do Supabase deixava essa
// varredura completa da tabela clientes_erp travada por tempo indefinido,
// segurando a resposta do webhook (mesma causa dos "webhooks expirados" do
// incidente). Mesmo padrão de LEADS_QUERY_TIMEOUT_MS/ATENDIMENTO_MAX_PAGINAS.
const CLIENTE_ERP_QUERY_TIMEOUT_MS = Number(process.env.CLIENTE_ERP_QUERY_TIMEOUT_MS) || 8000
const CLIENTE_ERP_MAX_PAGINAS = 50 // 50 × 1000 linhas = 50.000, bem acima dos ~2.034 clientes_erp atuais

const breakerClienteErp = criarCircuitBreaker({
  chave: 'cliente-erp-match',
  falhasParaAbrir: Number(process.env.CLIENTE_ERP_BREAKER_FALHAS_PARA_ABRIR) || 5,
  cooldownMs: Number(process.env.CLIENTE_ERP_BREAKER_COOLDOWN_MS) || 15000,
  cooldownMaxMs: Number(process.env.CLIENTE_ERP_BREAKER_COOLDOWN_MAX_MS) || 120000,
})

// Busca 1x todos os clientes_erp e monta um mapa telefone(dígitos)→cliente.
// 2.034 linhas — trivial em memória, não precisa de índice em contatos (jsonb).
export async function construirMapaTelefonesClientesErp() {
  const clientes = await breakerClienteErp.executar(async () => {
    // Supabase limita a 1000 linhas por resposta — sem paginar, ~metade dos 2.034
    // clientes_erp nunca entrava no mapa (bug real: achado ao investigar por que um
    // match confirmado manualmente não aparecia no backfill).
    const acumulado = []
    const PAGE = 1000
    for (let offset = 0, pagina = 0; ; offset += PAGE, pagina++) {
      if (pagina >= CLIENTE_ERP_MAX_PAGINAS) {
        throw new Error(`teto de ${CLIENTE_ERP_MAX_PAGINAS} páginas atingido ao buscar clientes_erp`)
      }
      const { data, error } = await supabase
        .from('clientes_erp')
        .select('id, legacy_id, razao_social, cnpj_cpf, data_ultima_compra, contatos')
        .range(offset, offset + PAGE - 1)
        .abortSignal(AbortSignal.timeout(CLIENTE_ERP_QUERY_TIMEOUT_MS))
      if (error) throw error
      acumulado.push(...data)
      if (data.length < PAGE) break
    }
    return acumulado
  })

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
