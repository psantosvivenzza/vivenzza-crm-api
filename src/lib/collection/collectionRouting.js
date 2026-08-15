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
import { verificarFrescorSync, logBloqueioSyncStale } from './financialSyncGuard.js'
import { verificarLimiteGlobalEnvio } from './globalSendLimit.js'
import { estaEmDoNotContact, registrarBloqueioOptOutSeNecessario } from './doNotContactGuard.js'

// Ponto único de verdade pra TODO envio real de cobrança (cron, /disparar,
// /disparar-individual — todos chegam aqui) — por isso é o lugar certo pro
// guard de frescor do sync financeiro E pro teto global de envio
// (globalSendLimit.js): protege os 3 caminhos de uma vez, sem duplicar a
// checagem em cada um. Também serve como revalidação "antes do envio" pra
// lotes longos (a régua chama isso 1x por conta) — cacheado em
// financialSyncGuard.js/featureFlags.js pra não consultar o banco a cada
// mensagem.
export async function enviarCobrancaComRoteamento({ contasFinanceirasId, etapa, clienteNome, clienteTelefone, valor, mensagem, origem }) {
  const guardSync = await verificarFrescorSync()
  if (!guardSync.allowed) {
    logBloqueioSyncStale(origem, guardSync)
    return { status: 'blocked', motor: null, reason: guardSync.reason, motivo: 'Sincronização financeira desatualizada — cobrança bloqueada (fail-closed)', guard: guardSync }
  }

  // 2026-08-15 — teto GLOBAL (soma de todas as instâncias/motores), checado
  // antes de decidir legado x v2 pra cobrir os dois caminhos igualmente.
  // Nunca reinicia ao trocar de instância (cobrancas_whatsapp é agnóstica a
  // isso) — ver globalSendLimit.js pro racional completo.
  const limiteGlobal = await verificarLimiteGlobalEnvio()
  if (!limiteGlobal.permitido) {
    return {
      status: 'blocked', motor: null, reason: limiteGlobal.motivo,
      motivo: `Teto global de envio atingido (${limiteGlobal.motivo})`, limite: limiteGlobal,
    }
  }

  // 2026-08-15 — DNC/opt-out (collection_do_not_contact), checado ANTES da
  // escolha de motor de propósito: cobre os dois motores (legado
  // enviarTextoFinanceiro E v2 enviarComFailover) de uma vez, igual ao guard
  // de sync/teto global acima — mesma razão, mesmo ponto. Fail-closed: erro
  // na consulta também bloqueia (estaEmDoNotContact nunca deixa passar por
  // falha técnica do próprio guard). Nunca conta como falha técnica de
  // instância/provider — bloqueia ANTES de qualquer seleção de instância,
  // dispatch ou tentativa (nenhum failover, nenhum retry, nenhum provider
  // attempt chega a existir pra esta cobrança).
  const dnc = await estaEmDoNotContact(clienteTelefone)
  if (dnc.blocked) {
    await registrarBloqueioOptOutSeNecessario({ contasFinanceirasId, clienteTelefone, reason: dnc.reason })
    return { status: 'blocked', motor: null, reason: 'opt_out', motivo: `Cliente em opt-out/DNC (${dnc.reason})` }
  }

  const config = await obterConfigCobranca()

  if (config.multi_whatsapp !== true) {
    await enviarTextoFinanceiro(clienteTelefone, mensagem)
    return { status: 'sent', motor: 'legado' }
  }

  const resultado = await enviarComFailover({ contasFinanceirasId, etapa, clienteNome, clienteTelefone, valor, mensagem, origem })
  return { ...resultado, motor: 'v2' }
}
