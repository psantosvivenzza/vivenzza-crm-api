// Cache curto + single-flight por escopo, genérico.
//
// Motivação (incidente de sobrecarga do Supabase, 2026-09):
// GET /api/dashboard/atendimento é pollado pelo frontend a cada 30s — com
// várias vendedoras/admins de painel aberto ao mesmo tempo, cada poll de cada
// aba disparava, sozinho, uma consulta pesada (leads paginados + RPC +
// mensagens de 7 dias) contra o Supabase. Sem nada aqui, N abas = N execuções
// completas por janela de 30s, todas recomputando exatamente a mesma coisa
// pro mesmo escopo (mesmo vendedor_id, ou "geral").
//
// Este helper resolve dois problemas relacionados, mas distintos:
// 1. Cache curto (TTL): depois que UMA chamada termina, respostas seguintes
//    pro mesmo escopo dentro do TTL reaproveitam o resultado, sem tocar o banco.
// 2. Single-flight: se várias chamadas pro MESMO escopo chegam enquanto uma
//    computação já está em andamento (nenhum cache válido ainda), todas elas
//    aguardam a MESMA promise em vez de disparar computações redundantes em
//    paralelo — coalescimento, não fila.
//
// Escopo deliberadamente pequeno: cache em memória do processo, sem
// invalidação manual (não há mutation nenhuma que dependa de ver o efeito de
// imediato — é sempre dado derivado de leitura). Cada processo Node tem seu
// próprio cache; com múltiplas instâncias, cada uma cacheia separadamente —
// ainda reduz carga proporcionalmente, sem exigir estado compartilhado.
export function criarCacheComSingleFlight({ ttlMs, computar }) {
  if (typeof computar !== 'function') {
    throw new Error('criarCacheComSingleFlight: "computar" precisa ser uma função')
  }

  const cache = new Map() // chave -> { valor, cacheadoEm }
  const emAndamento = new Map() // chave -> Promise

  async function obter(chave, ...args) {
    const cacheado = cache.get(chave)
    if (cacheado && Date.now() - cacheado.cacheadoEm < ttlMs) {
      return cacheado.valor
    }

    const jaEmAndamento = emAndamento.get(chave)
    if (jaEmAndamento) return jaEmAndamento

    const promise = Promise.resolve()
      .then(() => computar(...args))
      .then((valor) => {
        cache.set(chave, { valor, cacheadoEm: Date.now() })
        return valor
      })
      .finally(() => {
        // Libera o slot de "em andamento" sempre — sucesso OU falha. Sem isso,
        // uma falha aqui travaria esse escopo em "em andamento" pra sempre,
        // igual ao risco documentado em monitoramento-resposta.js (emExecucao).
        emAndamento.delete(chave)
      })

    emAndamento.set(chave, promise)
    return promise
  }

  function invalidar(chave) {
    if (chave === undefined) {
      cache.clear()
    } else {
      cache.delete(chave)
    }
  }

  return { obter, invalidar }
}
