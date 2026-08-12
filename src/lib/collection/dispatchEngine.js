// Motor de tentativas — o coração da FASE 2. Uma cobrança lógica
// (collection_dispatches) tem 1 dispatch principal e N tentativas
// (collection_dispatch_attempts), cada uma em uma instância WhatsApp diferente.
//
// Regras (todas do pedido original, implementadas literalmente):
// - Idempotência: idempotency_key único por (título, etapa, dia) — nenhum retry,
//   restart de worker ou dois cliques manuais simultâneos criam dois dispatches.
// - Falha explícita ou instância indisponível: pode tentar a próxima instância
//   saudável (se whatsapp_failover=true).
// - Mensagem só SENT/PENDING: NUNCA considerado falha — não tenta próxima
//   instância só porque a confirmação de entrega ainda não chegou.
// - Se qualquer tentativa virar DELIVERED/READ: encerra, nunca tenta de novo.
// - Número inválido (problema do dado, não da instância): falha definitiva, não
//   itera por outras instâncias (nenhuma vai resolver).
// - Antes de qualquer tentativa, sempre reconsulta se o título já foi pago.
import { supabase } from '../supabase-admin.server.js'
import { obterConfigCobranca } from './featureFlags.js'
import { idempotencyKeyDispatch, registrarEventoExterno } from './idempotency.js'
import { selecionarProximaInstancia, registrarSucessoEnvio, registrarFalhaEnvio } from './whatsappInstances.js'
import { enviarTexto, classifyEvolutionFailure, normalizarStatusAck } from './evolutionAdapter.js'
import { tituloEstaQuitado } from './paymentGuard.js'
import { promessaAtivaPara } from './promises.js'
import { registrarEvento, ORIGEM } from './timeline.js'
import { hojeBrtISO } from './collectionContactPolicy.js'

const MAX_TENTATIVAS = 3

// Retorna o dispatch existente (idempotência) OU cria um novo em 'queued'.
// `criarNovo=false` faz retornar null em vez de criar, útil pra checagem sem
// efeito colateral (ex: UI perguntando "já foi enviado hoje?").
async function obterOuCriarDispatch({ contasFinanceirasId, etapa, canal, origem, mensagem, clienteNome, clienteTelefone, valor }) {
  const idempotencyKey = idempotencyKeyDispatch({ contasFinanceirasId, etapa, diaBrt: hojeBrtISO() })

  const { data: existente } = await supabase
    .from('collection_dispatches')
    .select('*')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle()
  if (existente) return { dispatch: existente, novo: false }

  const { data: criado, error } = await supabase
    .from('collection_dispatches')
    .insert({
      contas_financeiras_id: contasFinanceirasId, etapa, canal, idempotency_key: idempotencyKey,
      status: 'queued', origem, mensagem, cliente_nome: clienteNome, cliente_telefone: clienteTelefone, valor,
    })
    .select()
    .single()

  if (error) {
    // 23505 = corrida concorrente inserindo a mesma chave entre a checagem acima e
    // este insert — outra execução venceu, busca o que ela criou.
    if (error.code === '23505') {
      const { data: concorrente } = await supabase.from('collection_dispatches').select('*').eq('idempotency_key', idempotencyKey).single()
      return { dispatch: concorrente, novo: false }
    }
    throw error
  }
  return { dispatch: criado, novo: true }
}

async function atualizarDispatch(id, campos) {
  const { error } = await supabase.from('collection_dispatches').update({ ...campos, atualizado_em: new Date().toISOString() }).eq('id', id)
  if (error) throw error
}

async function registrarTentativa(dispatchId, numero, instanciaId) {
  const { data, error } = await supabase
    .from('collection_dispatch_attempts')
    .insert({ dispatch_id: dispatchId, attempt_number: numero, whatsapp_instance_id: instanciaId, status: 'sending' })
    .select()
    .single()
  if (error) throw error
  return data
}

async function atualizarTentativa(id, campos) {
  const { error } = await supabase.from('collection_dispatch_attempts').update(campos).eq('id', id)
  if (error) throw error
}

// Ponto de entrada único usado pelo job da régua (v2) e pelo disparo manual v2.
// Retorna { status, motivo?, dispatchId?, tentativas? }.
export async function enviarComFailover({ contasFinanceirasId, etapa, clienteNome, clienteTelefone, valor, mensagem, origem, instanciaUnicaLegado = null }) {
  if (await tituloEstaQuitado(contasFinanceirasId)) {
    return { status: 'skipped', motivo: 'quitado' }
  }
  const promessa = await promessaAtivaPara(contasFinanceirasId)
  if (promessa) {
    return { status: 'skipped', motivo: 'promessa_ativa', promessaId: promessa.id }
  }

  const config = await obterConfigCobranca()
  const { dispatch, novo } = await obterOuCriarDispatch({
    contasFinanceirasId, etapa, canal: 'whatsapp', origem, mensagem, clienteNome, clienteTelefone, valor,
  })
  if (!novo) {
    return { status: dispatch.status, motivo: 'idempotencia_existente', dispatchId: dispatch.id }
  }

  if (['sent', 'delivered', 'read'].includes(dispatch.status)) {
    return { status: dispatch.status, motivo: 'ja_concluido', dispatchId: dispatch.id }
  }

  await atualizarDispatch(dispatch.id, { status: 'sending' })

  const tentadas = []
  let ultimoErro = null

  for (let numero = 1; numero <= MAX_TENTATIVAS; numero++) {
    // Instância única legado: usada quando multi_whatsapp=false, para não mudar
    // comportamento em produção enquanto a flag estiver desligada.
    const instancia = instanciaUnicaLegado
      ? (numero === 1 ? instanciaUnicaLegado : null)
      : await selecionarProximaInstancia({ excluirIds: tentadas })

    if (!instancia) {
      await atualizarDispatch(dispatch.id, { status: 'failed' })
      await registrarEvento({
        contasFinanceirasId, clienteTelefone, tipo: 'MENSAGEM_FALHOU', origem: ORIGEM.SYSTEM,
        descricao: 'Nenhuma instância WhatsApp saudável disponível para envio',
        dados: { dispatch_id: dispatch.id },
      })
      return { status: 'failed', motivo: 'sem_instancia_saudavel', dispatchId: dispatch.id }
    }
    tentadas.push(instancia.id)

    const tentativa = await registrarTentativa(dispatch.id, numero, instancia.id)

    try {
      const resultado = await enviarTexto(instancia, clienteTelefone, mensagem)
      await atualizarTentativa(tentativa.id, {
        status: 'sent', provider_message_id: resultado.providerMessageId, enviado_em: new Date().toISOString(),
      })
      await registrarSucessoEnvio(instancia.id)
      await atualizarDispatch(dispatch.id, { status: 'sent' })
      await registrarEvento({
        contasFinanceirasId, clienteTelefone, tipo: 'MENSAGEM_ENVIADA', origem: origem === 'manual' ? ORIGEM.HUMAN : ORIGEM.AUTOMATION,
        canal: 'whatsapp', descricao: `Cobrança etapa ${etapa} enviada via ${instancia.name}`,
        dados: { dispatch_id: dispatch.id, attempt_id: tentativa.id, instance_id: instancia.id, provider_message_id: resultado.providerMessageId },
      })
      return { status: 'sent', dispatchId: dispatch.id, tentativas: numero, instancia: instancia.name }
    } catch (err) {
      const classificado = classifyEvolutionFailure(err)
      ultimoErro = classificado.mensagem

      await atualizarTentativa(tentativa.id, {
        status: 'failed', failure_kind: classificado.failureKind, erro: classificado.mensagem, falhou_em: new Date().toISOString(),
      })
      await registrarFalhaEnvio(instancia.id)

      // FASE C.1 (homologação) — só failoverEligible=true (categoria
      // TECHNICAL_RETRYABLE) autoriza tentar outra instância. Rate limit,
      // auth, número permanente e restrição de plataforma sempre terminam
      // aqui, mesmo com whatsapp_failover=true — trocar de instância nunca
      // resolve esses casos, e insistir pode mascarar um bloqueio deliberado
      // do provedor (pedido explícito de não construir isso pra burlar
      // limitação/bloqueio).
      const podeTentarOutra = classificado.failoverEligible && !instanciaUnicaLegado && config.whatsapp_failover === true && numero < MAX_TENTATIVAS
      if (!podeTentarOutra) {
        await atualizarDispatch(dispatch.id, { status: 'failed' })
        await registrarEvento({
          contasFinanceirasId, clienteTelefone, tipo: 'MENSAGEM_FALHOU', origem: ORIGEM.SYSTEM,
          descricao: `Falha ao enviar via ${instancia.name} [${classificado.category}]: ${classificado.mensagem}`,
          dados: { dispatch_id: dispatch.id, attempt_id: tentativa.id, category: classificado.category },
        })
        return { status: 'failed', motivo: classificado.failureKind, categoria: classificado.category, dispatchId: dispatch.id, erro: classificado.mensagem }
      }
      // continua o loop — tenta a próxima instância (só chega aqui se failoverEligible)
    }
  }

  await atualizarDispatch(dispatch.id, { status: 'failed' })
  return { status: 'failed', motivo: 'max_tentativas', dispatchId: dispatch.id, erro: ultimoErro }
}

// Chamado pelo webhook (messages.update) quando chega um ACK de entrega/leitura da
// Evolution. Localiza a tentativa por provider_message_id e propaga pro dispatch —
// "se qualquer attempt virar DELIVERED: cancelar novas tentativas" já é natural
// aqui porque o dispatch já teria saído de 'sending' assim que o primeiro envio
// teve sucesso (status 'sent'); isto só avança sent -> delivered -> read.
export async function aplicarAckDeEntrega(providerMessageId, statusBruto) {
  if (!providerMessageId) return
  const statusNormalizado = normalizarStatusAck(statusBruto)
  if (!statusNormalizado) return

  const { data: tentativa } = await supabase
    .from('collection_dispatch_attempts')
    .select('id, dispatch_id, status')
    .eq('provider_message_id', providerMessageId)
    .maybeSingle()
  if (!tentativa) return // mensagem não veio do motor de cobrança v2 — nada a fazer

  const ordem = { sending: 0, sent: 1, delivered: 2, read: 3, failed: -1, expired: -1, cancelled: -1 }
  if ((ordem[statusNormalizado] ?? -1) <= (ordem[tentativa.status] ?? -1)) return // nunca regride status

  const campos = { status: statusNormalizado }
  if (statusNormalizado === 'delivered') campos.entregue_em = new Date().toISOString()
  if (statusNormalizado === 'read') campos.lido_em = new Date().toISOString()
  await atualizarTentativa(tentativa.id, campos)
  await atualizarDispatch(tentativa.dispatch_id, { status: statusNormalizado })
}

// Timeout de entrega (delivery_timeout_minutes) — só age quando
// failover_on_delivery_timeout=true, e mesmo assim só CRIA uma nova tentativa
// (não cancela a anterior, que pode entregar depois). Risco de duplicidade
// documentado em ARCHITECTURE.md/OPERATIONS.md — por isso a flag é false por padrão.
export async function reavaliarTimeoutsDeEntrega() {
  const config = await obterConfigCobranca()
  if (!config.failover_on_delivery_timeout) return { reavaliados: 0 }

  const limite = new Date(Date.now() - config.delivery_timeout_minutes * 60 * 1000).toISOString()
  const { data: presos, error } = await supabase
    .from('collection_dispatches')
    .select('*')
    .eq('status', 'sent')
    .lt('atualizado_em', limite)
  if (error) throw error

  let reavaliados = 0
  for (const dispatch of presos ?? []) {
    const { data: tentativasAnteriores } = await supabase
      .from('collection_dispatch_attempts')
      .select('whatsapp_instance_id')
      .eq('dispatch_id', dispatch.id)
    const idsExcluidos = (tentativasAnteriores ?? []).map((t) => t.whatsapp_instance_id).filter(Boolean)
    const proxima = await selecionarProximaInstancia({ excluirIds: idsExcluidos })
    if (!proxima) continue

    await atualizarDispatch(dispatch.id, { status: 'sending' })
    const numero = (tentativasAnteriores?.length ?? 0) + 1
    const tentativa = await registrarTentativa(dispatch.id, numero, proxima.id)
    try {
      const resultado = await enviarTexto(proxima, dispatch.cliente_telefone, dispatch.mensagem)
      await atualizarTentativa(tentativa.id, { status: 'sent', provider_message_id: resultado.providerMessageId, enviado_em: new Date().toISOString() })
      await registrarSucessoEnvio(proxima.id)
      await atualizarDispatch(dispatch.id, { status: 'sent' })
      await registrarEvento({
        contasFinanceirasId: dispatch.contas_financeiras_id, clienteTelefone: dispatch.cliente_telefone,
        tipo: 'MENSAGEM_REENVIADA_TIMEOUT', origem: ORIGEM.SYSTEM,
        descricao: `Timeout de entrega (${config.delivery_timeout_minutes}min) — reenviado via ${proxima.name}. Risco de duplicidade se a tentativa anterior entregar depois.`,
      })
      reavaliados++
    } catch (err) {
      const classificado = classifyEvolutionFailure(err)
      await atualizarTentativa(tentativa.id, { status: 'failed', failure_kind: classificado.failureKind, erro: classificado.mensagem, falhou_em: new Date().toISOString() })
      await registrarFalhaEnvio(proxima.id)
      await atualizarDispatch(dispatch.id, { status: 'sent' }) // volta pro estado anterior — ainda pode entregar
    }
  }
  return { reavaliados }
}
