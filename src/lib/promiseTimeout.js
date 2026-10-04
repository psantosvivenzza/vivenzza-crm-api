// Timeout fail-fast genérico via corrida manual (Promise.race), não
// `.abortSignal()` — usado nos poucos lugares onde a chamada protegida NÃO é
// necessariamente um builder encadeável do supabase-js/postgrest-js (ex:
// src/lib/distribuicao.js chama `fn()`, que em teste é frequentemente um
// mock simples `async (fnName, params) => ({data, error})`, sem `.abortSignal`
// nem qualquer outro método — só uma Promise crua). `.abortSignal(AbortSignal
// .timeout(ms))` (o padrão usado em routes/leads.js, dashboard.js, sdr.js)
// continua sendo a escolha certa em qualquer lugar que sempre recebe o
// builder real — só troca por isto onde o valor "abortável" não é garantido.
//
// Mesma semântica de cancelamento do `.abortSignal()` real: só desiste de
// ESPERAR — a operação em si (RPC/query já disparada contra o Postgres)
// continua rodando até terminar sozinha, o timeout só evita que o CHAMADOR
// fique preso esperando por ela.
export function comTimeout(promiseOuThenable, ms, mensagem = 'A operação excedeu o tempo limite.') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(Object.assign(new Error(mensagem), { name: 'AbortError' }))
    }, ms)
    // unref() — não deve ser o único motivo do processo Node continuar vivo
    // (mesma preocupação já documentada em createLocalPgClient/allowExitOnIdle).
    if (typeof timer.unref === 'function') timer.unref()

    Promise.resolve(promiseOuThenable).then(
      (valor) => { clearTimeout(timer); resolve(valor) },
      (erro) => { clearTimeout(timer); reject(erro) }
    )
  })
}
