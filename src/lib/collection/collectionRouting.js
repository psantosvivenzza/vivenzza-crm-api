// Ponte ÚNICA entre o sender legado (evolutionFinanceiro.js — 1 instância
// fixa via env, sem idempotência própria) e o motor novo (dispatchEngine —
// collection_dispatches/collection_dispatch_attempts, multi-instância,
// idempotência global). Decisão determinística via
// automacoes_config.multi_whatsapp: um caminho OU o outro, nunca os dois na
// mesma execução lógica.
//
// multi_whatsapp=false preserva o comportamento anterior a esta integração
// byte a byte (mesma função, mesmo cliente HTTP, nenhuma escrita nova em
// collection_dispatches). multi_whatsapp=true delega para enviarComFailover,
// que por sua vez só troca de instância se automacoes_config.whatsapp_failover
// também estiver true — reaproveita as regras já homologadas na FASE C.3D,
// sem redesenhar nada aqui.
import { enviarTextoFinanceiro } from '../evolutionFinanceiro.js'
import { enviarComFailover } from './dispatchEngine.js'
import { obterConfigCobranca } from './featureFlags.js'

export async function enviarCobrancaComRoteamento({ contasFinanceirasId, etapa, clienteNome, clienteTelefone, valor, mensagem, origem }) {
  const config = await obterConfigCobranca()

  if (config.multi_whatsapp !== true) {
    await enviarTextoFinanceiro(clienteTelefone, mensagem)
    return { status: 'sent', motor: 'legado' }
  }

  const resultado = await enviarComFailover({ contasFinanceirasId, etapa, clienteNome, clienteTelefone, valor, mensagem, origem })
  return { ...resultado, motor: 'v2' }
}
