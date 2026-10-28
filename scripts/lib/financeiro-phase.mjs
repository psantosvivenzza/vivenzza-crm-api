const ETAPAS = new Set(['sincronizacao_completa', 'sincronizacao_incremental', 'conferencia', 'alerta'])

// Observa a Promise original até seu término. Não cancela, reinicia ou cria retry.
// log deve ser síncrono (console.error por padrão); erros de telemetria são isolados.
export function criarObservadorFinanceiro({ log = linha => console.error(linha), agora = () => performance.now() } = {}) {
  function emitir(etapa, evento, inicio) {
    try {
      log(JSON.stringify({
        tipo: 'financeiro_etapa', etapa, evento, em: new Date().toISOString(),
        ...(inicio === undefined ? {} : { duracao_ms: Math.max(0, Math.round(agora() - inicio)) }),
      }))
    } catch { /* Telemetria nunca muda o resultado financeiro. */ }
  }
  return async function observar(etapa, executar) {
    const segura = ETAPAS.has(etapa) ? etapa : 'desconhecida'
    let inicio
    try { inicio = agora() } catch { /* Ainda executar a operação original. */ }
    emitir(segura, 'inicio')
    try {
      const resultado = await executar()
      emitir(segura, 'fim', inicio)
      return resultado
    } catch (erro) {
      emitir(segura, 'erro', inicio)
      throw erro
    }
  }
}
