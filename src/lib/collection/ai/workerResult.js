// IA WhatsApp MVP — aplica o resultado bruto devolvido pelo worker local.
// Reaproveita EXATAMENTE a mesma validação/guardrail/persistência da chamada
// direta (montarSugestaoFinal em replySuggestion.js) — o worker nunca decide
// nada, só devolve texto bruto do modelo; toda autoridade continua aqui.
import { carregarContextoCliente } from './collectionContext.js'
import { validarClassificacao, resolverClassificacao } from './intentClassifier.js'
import { validarGeracao, montarSugestaoFinal } from './replySuggestion.js'
import { marcarJobConcluido, marcarJobFalhou } from './jobQueue.js'

function parseSeguro(texto) {
  try {
    return JSON.parse(texto ?? '')
  } catch {
    return null
  }
}

export async function aplicarResultadoDoWorker(job, { rawClassifyResponse, rawGenerateResponse }) {
  try {
    // Recarrega o contexto NA HORA do resultado, não usa um snapshot do
    // momento do enfileiramento — título pode ter sido pago ou promessa
    // criada entre o job ser enfileirado e o worker responder.
    const contexto = await carregarContextoCliente({ contasFinanceirasId: job.contas_financeiras_id })

    const classificacao = resolverClassificacao(validarClassificacao(parseSeguro(rawClassifyResponse)))
    const geracaoValidada = validarGeracao(parseSeguro(rawGenerateResponse))
    const geracao = geracaoValidada ?? { suggestedReply: null, extractedDate: null, motivo: 'json_invalido_do_worker' }

    const registro = await montarSugestaoFinal({
      contasFinanceirasId: job.contas_financeiras_id,
      clienteTelefone: job.cliente_telefone,
      mensagemCliente: job.mensagem_cliente,
      contexto,
      classificacao,
      geracao,
      aiProviderNome: 'ollama-worker-local',
    })

    await marcarJobConcluido(job.id, { suggestionId: registro.id, rawClassifyResponse, rawGenerateResponse })
    return registro
  } catch (err) {
    await marcarJobFalhou(job.id, { erro: err.message, rawClassifyResponse, rawGenerateResponse })
    throw err
  }
}
