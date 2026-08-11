// Hard cap de spend diário do Meta Ads da Vivenzza — teto de negócio R$150/dia,
// alerta em R$115, proteção (pausa) em R$125 (thresholds conservadores, ver
// PLANO_HARD_CAP_META_ADS.md na raiz do repo para a arquitetura completa,
// rollback e estimativa de atraso).
//
// meta_budget_guard_enabled=false (default) -> pulado inteiro, zero efeito.
// meta_budget_guard_dry_run=true (default, só importa se enabled=true) -> loga
// tudo que faria (inclusive no meta_budget_guard_log) mas NÃO chama a Graph API
// de escrita nem manda WhatsApp — permite validar em produção sem risco antes
// de ligar de vez.
//
// runMetaBudgetGuard aceita `deps` sobrescrevendo store/metaClient/notificar —
// é o que permite scripts/teste-meta-budget-guard.mjs simular todos os cenários
// de DRY RUN rodando a função inteira (fail-safes inclusos) sem tocar Supabase
// nem a Graph API de verdade. Em produção, os defaults abaixo (store/metaClient
// reais) são usados.
import { supabase } from '../lib/supabase-admin.server.js'
import * as metaAdsGuardClient from '../lib/metaAdsGuardClient.js'
import { decidirNivel, diaContaBrt, pausasPendentesDeReativacao, decidirDesfechoDeReset } from '../lib/metaBudgetGuard.js'
import { obterConfigMetaGuard } from '../lib/metaBudgetGuardConfig.js'
import { enviarAlertaWhatsapp } from '../lib/whatsappAlert.js'

const AD_ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID
const REASON_PAUSED = 'DAILY_BUDGET_GUARD'
const REASON_MANUAL_OVERRIDE = 'MANUAL_OVERRIDE_DETECTED'

const storeReal = {
  async lerLogsAnteriores(diaContaAtual) {
    const { data, error } = await supabase
      .from('meta_budget_guard_log')
      .select('id,entity_id,entity_type,action,dia_conta,pause_action_id')
      .lt('dia_conta', diaContaAtual)
    if (error) throw error
    return data || []
  },
  async jaExisteLog({ entity_id, entity_type, action, dia_conta }) {
    const { data, error } = await supabase
      .from('meta_budget_guard_log')
      .select('id')
      .match({ entity_id, entity_type, action, dia_conta })
      .maybeSingle()
    if (error) {
      // Fail-safe: se não consigo checar idempotência, não arrisco duplicar a ação.
      console.error('[meta-budget-guard] erro checando idempotência:', error.message)
      return true
    }
    return !!data
  },
  async registrarLog(linha) {
    const { error } = await supabase.from('meta_budget_guard_log').insert(linha)
    // 23505 = unique_violation — outra execução já registrou a mesma ação hoje,
    // não é erro real (mesmo padrão de registrarEventoExterno em idempotency.js).
    if (error && error.code !== '23505') {
      console.error('[meta-budget-guard] erro gravando log:', error.message)
      return false
    }
    return true
  },
}

const metaClientReal = {
  obterTimezoneConta: metaAdsGuardClient.obterTimezoneConta,
  lerSpendHoje: metaAdsGuardClient.lerSpendHoje,
  listarCampanhasAtivas: metaAdsGuardClient.listarCampanhasAtivas,
  obterStatusCampanha: metaAdsGuardClient.obterStatusCampanha,
  pausarCampanha: metaAdsGuardClient.pausarCampanha,
  reativarCampanha: metaAdsGuardClient.reativarCampanha,
}

function formatarHorario(date, timezone) {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date)
}

export async function runMetaBudgetGuard(deps = {}) {
  const store = { ...storeReal, ...deps.store }
  const meta = { ...metaClientReal, ...deps.metaClient }
  const notificar = deps.notificar || enviarAlertaWhatsapp
  const config = deps.config || (await obterConfigMetaGuard())
  const agora = deps.agora || new Date()

  if (!config.meta_budget_guard_enabled) {
    return { pulado: true, motivo: 'meta_budget_guard_enabled=false' }
  }
  const dryRun = config.meta_budget_guard_dry_run

  // Fail-safe explícito: timezone indeterminado -> não agir (nem reset, nem
  // avaliação). Sem timezone confiável não dá pra saber com segurança qual é
  // "o dia" da conta, e todo o resto (idempotência diária, reset) depende disso.
  let timezone
  try {
    timezone = await meta.obterTimezoneConta()
    if (!timezone) throw new Error('timezone_name veio vazio da Graph API')
  } catch (err) {
    console.error('[meta-budget-guard] timezone indeterminado — nenhuma ação tomada:', err.message)
    return { erro: 'timezone_indeterminado', detalhe: err.message }
  }
  const diaContaAtual = diaContaBrt(agora, timezone)

  // ── 1) Reset: reativa pausas de dias anteriores ainda não desfeitas ──────
  let logsAnteriores
  try {
    logsAnteriores = await store.lerLogsAnteriores(diaContaAtual)
  } catch (err) {
    // Fail-safe: banco falhou -> não faço nenhuma alteração às cegas.
    console.error('[meta-budget-guard] erro lendo log de pausas anteriores — nenhuma ação tomada:', err.message)
    return { erro: 'leitura_log_falhou', detalhe: err.message }
  }

  const pendentes = pausasPendentesDeReativacao({ logsAnteriores, diaContaAtual })
  const reativadas = []
  const overridesDetectados = []
  for (const pausa of pendentes) {
    try {
      // Leitura de status é sempre feita (mesmo em dry run) — é read-only e dá
      // diagnóstico real do que o guard faria; só a ESCRITA (reativarCampanha)
      // fica atrás do `if (!dryRun)`.
      const atual = await meta.obterStatusCampanha(pausa.entity_id)
      const desfecho = decidirDesfechoDeReset({ statusAtual: atual.effective_status })

      if (desfecho === 'MANUAL_OVERRIDE_DETECTED') {
        const ok = await store.registrarLog({
          entity_id: pausa.entity_id, entity_type: pausa.entity_type, action: 'manual_override',
          status_before_guard: atual.effective_status,
          reason: `${REASON_MANUAL_OVERRIDE} (status atual: ${atual.effective_status}, esperado PAUSED)`,
          dia_conta: diaContaAtual, pause_action_id: pausa.id,
        })
        if (ok) overridesDetectados.push({ entity_id: pausa.entity_id, status_atual: atual.effective_status })
        continue
      }

      if (!dryRun) await meta.reativarCampanha(pausa.entity_id)
      const ok = await store.registrarLog({
        entity_id: pausa.entity_id,
        entity_type: pausa.entity_type,
        action: 'resumed',
        reason: dryRun
          ? `[DRY RUN] reativaria (pausada em ${pausa.dia_conta})`
          : `reset do dia seguinte (pausada em ${pausa.dia_conta})`,
        dia_conta: diaContaAtual,
        pause_action_id: pausa.id,
      })
      if (ok) reativadas.push({ entity_id: pausa.entity_id, dry_run: dryRun })
    } catch (err) {
      console.error(`[meta-budget-guard] falha ao reativar ${pausa.entity_id}:`, err.message)
      await store.registrarLog({
        entity_id: pausa.entity_id, entity_type: pausa.entity_type, action: 'write_failed',
        reason: `falha ao reativar: ${err.message}`, dia_conta: diaContaAtual, pause_action_id: pausa.id,
      })
      if (!dryRun) {
        await notificar(`⚠️ Guard Meta Ads: FALHA ao reativar campanha ${pausa.entity_id} — ${err.message}. Verificar manualmente.`).catch(() => {})
      }
    }
  }

  // ── 2) Avaliação do dia corrente ─────────────────────────────────────────
  let spend
  try {
    spend = await meta.lerSpendHoje()
  } catch (err) {
    // Fail-safe explícito: leitura de spend falhou -> NENHUMA mudança de campanha.
    console.error('[meta-budget-guard] falha ao ler spend — nenhuma ação tomada:', err.message)
    return { erro: 'leitura_spend_falhou', detalhe: err.message, reativadas, overridesDetectados }
  }

  const nivel = decidirNivel({
    spend,
    alertaThreshold: config.meta_budget_guard_alert_threshold,
    protecaoThreshold: config.meta_budget_guard_protect_threshold,
  })

  if (nivel === 'NENHUMA') return { nivel, spend, dia_conta: diaContaAtual, reativadas, overridesDetectados }

  // Campanhas ativas AGORA — usado tanto na mensagem de alerta (contexto) quanto,
  // se for o caso, na proteção (quem pausar).
  const ativas = await meta.listarCampanhasAtivas()
  const percentualTeto = ((spend / config.meta_budget_guard_hard_cap) * 100).toFixed(1)
  const horario = formatarHorario(agora, timezone)

  // ALERTA — idempotente por dia (mesmo quando nivel === PROTECAO: cobre o caso
  // de spend saltar direto de <115 pra >=125 entre duas leituras, e ainda assim
  // registrar/mandar o alerta antes da proteção).
  const jaAlertou = await store.jaExisteLog({ entity_id: AD_ACCOUNT_ID, entity_type: 'account', action: 'alerted', dia_conta: diaContaAtual })
  if (!jaAlertou) {
    if (!dryRun) {
      await notificar(
        `🟡 Vivenzza Meta Ads — ALERTA de gasto\n` +
        `Spend hoje: R$${spend.toFixed(2)} (${percentualTeto}% do teto de R$${config.meta_budget_guard_hard_cap})\n` +
        `Horário (conta): ${horario}\n` +
        `Limiar de alerta: R$${config.meta_budget_guard_alert_threshold} | Proteção em: R$${config.meta_budget_guard_protect_threshold}\n` +
        `Campanhas ativas agora: ${ativas.map((c) => c.name).join(', ') || '(nenhuma)'}`
      ).catch((err) => console.error('[meta-budget-guard] falha ao enviar WhatsApp de alerta:', err.message))
    }
    await store.registrarLog({
      entity_id: AD_ACCOUNT_ID, entity_type: 'account', action: 'alerted',
      spend_at_action: spend,
      reason: dryRun ? `[DRY RUN] alertaria (spend ${spend})` : `spend ${spend} >= alerta ${config.meta_budget_guard_alert_threshold}`,
      dia_conta: diaContaAtual,
    })
  }

  if (nivel !== 'PROTECAO') return { nivel, spend, dia_conta: diaContaAtual, reativadas, overridesDetectados }

  // ── 3) PROTEÇÃO — pausa (reversível) tudo que estiver ACTIVE agora ──────
  const pausadasAgora = []
  for (const campanha of ativas) {
    const jaPausou = await store.jaExisteLog({ entity_id: campanha.id, entity_type: 'campaign', action: 'paused', dia_conta: diaContaAtual })
    if (jaPausou) continue
    try {
      if (!dryRun) await meta.pausarCampanha(campanha.id)
      const ok = await store.registrarLog({
        entity_id: campanha.id, entity_type: 'campaign', action: 'paused',
        status_before_guard: campanha.effective_status, spend_at_action: spend,
        reason: dryRun ? `[DRY RUN] ${REASON_PAUSED}` : REASON_PAUSED,
        dia_conta: diaContaAtual,
      })
      if (ok) {
        pausadasAgora.push({ id: campanha.id, name: campanha.name })
      } else if (!dryRun) {
        // Pausamos de verdade na Meta mas não conseguimos gravar o log — não é
        // "write_failed" da Meta (essa parte funcionou), é uma pausa órfã que
        // o reset de amanhã não vai saber que existe. Alerta imediato pra
        // intervenção manual, já que o dado nunca ficou "cego" sem avisar.
        await notificar(`⚠️ Guard Meta Ads: pausei "${campanha.name}" (${campanha.id}) mas FALHEI ao gravar o log — reset automático de amanhã não vai reconhecer essa pausa. Verificar manualmente.`).catch(() => {})
      }
    } catch (err) {
      console.error(`[meta-budget-guard] falha ao pausar ${campanha.id}:`, err.message)
      await store.registrarLog({
        entity_id: campanha.id, entity_type: 'campaign', action: 'write_failed',
        spend_at_action: spend, reason: `falha ao pausar: ${err.message}`, dia_conta: diaContaAtual,
      })
      if (!dryRun) {
        await notificar(`🔴 Guard Meta Ads: FALHA ao pausar "${campanha.name}" (${campanha.id}) com spend R$${spend.toFixed(2)} — ${err.message}. Ação manual necessária.`).catch(() => {})
      }
    }
  }

  if (pausadasAgora.length > 0 && !dryRun) {
    await notificar(
      `🔴 Vivenzza Meta Ads — PROTEÇÃO ativada\n` +
      `Spend hoje: R$${spend.toFixed(2)} (${percentualTeto}% do teto de R$${config.meta_budget_guard_hard_cap})\n` +
      `Horário (conta): ${horario}\n` +
      `Pausadas (reversível, reativa amanhã): ${pausadasAgora.map((p) => p.name).join(', ')}`
    ).catch((err) => console.error('[meta-budget-guard] falha ao enviar WhatsApp de proteção:', err.message))
  }

  return { nivel, spend, dia_conta: diaContaAtual, reativadas, overridesDetectados, pausadasAgora, dry_run: dryRun }
}
