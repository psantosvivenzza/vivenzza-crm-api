// Circuit breaker genérico — contenção de cascata quando o Supabase está
// degradado ou fora do ar.
//
// Motivação (incidente de 2026-09-28): o host do Supabase respondeu com
// Cloudflare 522 (origem inalcançável) por um período, e as respostas que
// chegavam a completar ficavam entre 90-300s de latência. GET /api/leads —
// pollado e paginado pelo frontend (ver src/routes/leads.js) — continuou
// disparando uma chamada nova a cada requisição, cada uma esperando o
// timeout inteiro antes de desistir. Isso empilhou centenas de conexões
// simultâneas contra um backend que já estava afogado, e o efeito colateral
// foi pior que a causa original: webhooks da Evolution API (que têm seu
// próprio prazo de resposta) expiraram porque o processo Node estava
// ocupado esperando essas chamadas.
//
// `.abortSignal(AbortSignal.timeout(ms))` (já usado em dashboard.js, sdr.js,
// monitoramento-resposta.js) resolve a metade do problema: nenhuma chamada
// INDIVIDUAL trava pra sempre. Mas sozinho, cada requisição nova ainda espera
// o timeout inteiro antes de falhar — sob rajada, N requisições concorrentes
// = N esperas completas em paralelo, continuando a bater no Supabase mesmo
// sabendo (pelas falhas recentes) que ele está indisponível. O circuit
// breaker fecha essa lacuna: depois de `falhasParaAbrir` falhas/timeouts
// consecutivos, abre o circuito e passa a REJEITAR IMEDIATAMENTE — sem
// nunca chamar o Supabase — até o cooldown passar. Dá alívio ao backend
// (menos conexões concorrentes) e devolve erro rápido pro cliente em vez de
// pendurar a requisição pelo timeout inteiro.
//
// Três estados (padrão clássico de circuit breaker):
// - fechado:     opera normalmente; cada falha incrementa um contador
//                consecutivo, cada sucesso zera.
// - aberto:      rejeita toda chamada sem executar `fn`, até o cooldown
//                atual (`cooldownAtualMs`) passar desde que abriu.
// - meio-aberto: cooldown passou — deixa exatamente UMA chamada de teste
//                passar (outras concorrentes continuam rejeitadas). Sucesso
//                fecha o circuito por completo (reset). Falha reabre com
//                cooldown maior (backoff exponencial, até `cooldownMaxMs`)
//                — evita bater no Supabase a cada poucos segundos enquanto
//                ele ainda está indisponível.
export class CircuitBreakerAbertoError extends Error {
  constructor(chave, retryAposMs) {
    super(`circuito aberto para "${chave}" — Supabase considerado indisponível no momento, tente novamente em ${Math.ceil(retryAposMs / 1000)}s`)
    this.name = 'CircuitBreakerAbertoError'
    this.chave = chave
    this.retryAposMs = retryAposMs
  }
}

export function criarCircuitBreaker({
  chave = 'supabase',
  falhasParaAbrir = 5,
  cooldownMs = 15000,
  cooldownMaxMs = 120000,
} = {}) {
  if (falhasParaAbrir < 1) throw new Error('criarCircuitBreaker: falhasParaAbrir precisa ser >= 1')
  if (cooldownMs < 1) throw new Error('criarCircuitBreaker: cooldownMs precisa ser >= 1')

  let estado = 'fechado' // 'fechado' | 'aberto' | 'meio-aberto'
  let falhasConsecutivas = 0
  let abriuEm = 0
  let cooldownAtualMs = cooldownMs
  // Trava a concorrência do estado meio-aberto: só 1 chamada de "prova" por
  // vez pode estar em andamento — sem isto, várias chamadas concorrentes
  // chegando logo depois do cooldown todas passariam como "teste", cada uma
  // batendo no Supabase de novo (exatamente o cenário que o breaker existe
  // pra evitar).
  let provaEmAndamento = false

  function podeExecutar() {
    if (estado === 'fechado') return { ok: true }

    if (estado === 'aberto') {
      const decorrido = Date.now() - abriuEm
      if (decorrido < cooldownAtualMs) {
        return { ok: false, retryAposMs: cooldownAtualMs - decorrido }
      }
      if (provaEmAndamento) {
        return { ok: false, retryAposMs: 1000 }
      }
      estado = 'meio-aberto'
      provaEmAndamento = true
      return { ok: true }
    }

    // meio-aberto: só a chamada que já ganhou o slot de prova executa.
    return { ok: false, retryAposMs: 1000 }
  }

  function registrarSucesso() {
    falhasConsecutivas = 0
    cooldownAtualMs = cooldownMs
    estado = 'fechado'
    provaEmAndamento = false
  }

  function registrarFalha() {
    if (estado === 'meio-aberto') {
      // A prova falhou — Supabase ainda indisponível. Reabre com backoff
      // exponencial (até o teto), não faz sentido testar de novo em cooldownMs.
      estado = 'aberto'
      abriuEm = Date.now()
      cooldownAtualMs = Math.min(cooldownAtualMs * 2, cooldownMaxMs)
      provaEmAndamento = false
      return
    }
    falhasConsecutivas++
    if (falhasConsecutivas >= falhasParaAbrir) {
      estado = 'aberto'
      abriuEm = Date.now()
      provaEmAndamento = false
    }
  }

  // Executa `fn` protegido pelo circuito. `fn` deve LANÇAR (throw) em caso
  // de erro — mesmo padrão já usado no resto do código (`if (error) throw
  // error` depois de cada chamada ao Supabase), nunca devolver
  // `{data, error}` sem lançar.
  async function executar(fn) {
    const permissao = podeExecutar()
    if (!permissao.ok) {
      throw new CircuitBreakerAbertoError(chave, permissao.retryAposMs)
    }
    try {
      const resultado = await fn()
      registrarSucesso()
      return resultado
    } catch (err) {
      registrarFalha()
      throw err
    }
  }

  function estadoAtual() {
    return { estado, falhasConsecutivas, cooldownAtualMs, chave }
  }

  // Exposto só pra teste/observabilidade — nunca deve ser chamado pelo
  // código de aplicação real (sempre passar por `executar`).
  function _reset() {
    estado = 'fechado'
    falhasConsecutivas = 0
    abriuEm = 0
    cooldownAtualMs = cooldownMs
    provaEmAndamento = false
  }

  return { executar, estadoAtual, _reset }
}
