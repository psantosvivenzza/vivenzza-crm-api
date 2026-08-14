import { supabase } from '../lib/supabase-admin.server.js'
import { calcularEtapa, montarMensagem } from '../lib/reguaCobranca.js'
import { enviarCobrancaComRoteamento } from '../lib/collection/collectionRouting.js'
import { verificarFrescorSync, logBloqueioSyncStale } from '../lib/collection/financialSyncGuard.js'

// CORREÇÃO URGENTE 2026-07-30: o número 5551983270024 foi suspenso temporariamente
// por enviar ~50 mensagens em rajada (sem intervalo). Limites abaixo existem
// especificamente pra evitar um novo ban — não afrouxar sem confirmar com o
// financeiro que a instância está estável.
const LIMITE_DIARIO = 30
const LIMITE_POR_HORA = 10
const HORA_INICIO_BRT = 8
const HORA_FIM_BRT = 17 // exclusivo — não dispara mais a partir das 17h

// Kill-switch — ao contrário de automacoes_config.reativacao_ativa (que é opt-out,
// default true), este é opt-in: uma automação nova que manda mensagem financeira
// pra cliente real não deve nunca ligar sozinha. Só true explícito ativa.
async function cobrancaEstaAtiva() {
  const { data } = await supabase.from('automacoes_config').select('cobranca_whatsapp_ativa').eq('id', 1).maybeSingle()
  return data?.cobranca_whatsapp_ativa === true
}

function diasAtrasoDe(vencimento) {
  const hojeBrt = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }) // YYYY-MM-DD
  const umDia = 24 * 60 * 60 * 1000
  return Math.floor((new Date(hojeBrt) - new Date(vencimento)) / umDia)
}

// Brasil não observa horário de verão desde 2019 — BRT = UTC-3 fixo, então dá pra
// calcular a hora local só com aritmética, sem Intl.
function horaBrtAgora() {
  return (new Date().getUTCHours() - 3 + 24) % 24
}

function dentroDoHorarioPermitido() {
  const hora = horaBrtAgora()
  return hora >= HORA_INICIO_BRT && hora < HORA_FIM_BRT
}

// Meia-noite BRT = 03:00 UTC do mesmo dia (BRT = UTC-3).
function inicioDoDiaBrtISO() {
  const hojeBrt = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
  return `${hojeBrt}T03:00:00.000Z`
}

// Início da hora corrente é a mesma marca de tempo em qualquer fuso de offset
// inteiro (ex: 14:23 UTC e 11:23 BRT começaram a hora atual no mesmo instante:
// 14:00 UTC / 11:00 BRT) — não precisa de conversão de fuso, só zerar min/seg.
function inicioDaHoraAtualISO() {
  const agora = new Date()
  agora.setUTCMinutes(0, 0, 0)
  return agora.toISOString()
}

async function contarEnviadasCronDesde(isoDesde) {
  const { count, error } = await supabase
    .from('cobrancas_whatsapp')
    .select('id', { count: 'exact', head: true })
    .eq('origem', 'cron')
    .gte('data_envio', isoDesde)
  if (error) throw error
  return count ?? 0
}

async function telefonesJaContatadosHoje(isoInicioDia) {
  const { data, error } = await supabase
    .from('cobrancas_whatsapp')
    .select('cliente_telefone')
    .eq('origem', 'cron')
    .gte('data_envio', isoInicioDia)
  if (error) throw error
  return new Set((data || []).map((r) => r.cliente_telefone))
}

function aguardarIntervaloAleatorio() {
  const ms = 45000 + Math.random() * 45000 // 45-90s — nunca rajada
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function resumoVazio(paradoPor = null) {
  return { ativo: true, elegiveis: 0, enviadas: 0, semTelefone: 0, jaEnviadas: 0, jaContatadoHoje: 0, quitados: 0, erros: 0, paradoPor }
}

// Trava de reentrância — o agendamento agora dispara a cada 15 min (ver index.js);
// se uma execução anterior ainda estiver no meio do intervalo de 45-90s entre
// mensagens quando o próximo tick chegar, esse tick só pula em vez de rodar em
// paralelo (duas execuções simultâneas somando envios é exatamente o tipo de
// rajada que causou a suspensão).
let emExecucao = false

// Núcleo da régua — usado tanto pelo cron (a cada 15 min, 08h-17h BRT, seg-sex)
// quanto por POST /api/cobrancas/disparar. `origem` sempre 'cron' aqui: disparo
// manual em massa usa a mesma função porque é o mesmo conceito de "rodar a régua
// agora" — e por isso também respeita os mesmos limites/intervalos abaixo.
export async function executarReguaCobranca() {
  if (emExecucao) {
    console.log('[cobranca-whatsapp] execução anterior ainda em andamento — pulando este ciclo')
    return resumoVazio('execucao_concorrente')
  }

  if (!(await cobrancaEstaAtiva())) {
    console.log('[cobranca-whatsapp] desligado (automacoes_config.cobranca_whatsapp_ativa=false) — nada enviado')
    return { ...resumoVazio(), ativo: false }
  }

  if (!dentroDoHorarioPermitido()) {
    console.log('[cobranca-whatsapp] fora do horário permitido (08h-17h BRT) — nada enviado, aguardando próximo ciclo')
    return resumoVazio('fora_do_horario')
  }

  // Gate de frescor do sync financeiro — checado aqui pra sair cedo e limpo
  // (sem nem consultar contas), e de novo dentro de enviarCobrancaComRoteamento
  // (collectionRouting.js) a cada envio real, como revalidação — essa segunda
  // checagem é quem realmente protege contra o sync cair NO MEIO de um lote
  // longo, já que reusa o mesmo cache curto.
  const guardSyncInicial = await verificarFrescorSync()
  if (!guardSyncInicial.allowed) {
    logBloqueioSyncStale('cron_batch_inicio', guardSyncInicial)
    return { ...resumoVazio('sync_stale'), guard: guardSyncInicial }
  }

  emExecucao = true
  try {
    const inicioDia = inicioDoDiaBrtISO()
    let enviadasHoje = await contarEnviadasCronDesde(inicioDia)
    if (enviadasHoje >= LIMITE_DIARIO) {
      console.log(`[cobranca-whatsapp] limite diário já atingido (${enviadasHoje}/${LIMITE_DIARIO}) — aguardando próximo ciclo`)
      return resumoVazio('limite_diario')
    }

    const telefonesContatados = await telefonesJaContatadosHoje(inicioDia)

    // PostgREST limita a 1000 linhas por padrão — pagina pra não deixar clientes
    // de fora da régua silenciosamente (mesmo bug corrigido em aging.js).
    const contas = []
    {
      const PAGE = 1000
      for (let offset = 0; ; offset += PAGE) {
        const { data, error } = await supabase
          .from('contas_financeiras')
          .select('id, pessoa_nome, valor, valor_pago, vencimento, telefone_cobranca')
          .eq('tipo', 'receber')
          .in('status', ['aberta', 'vencida', 'pago_parcial'])
          .eq('em_revisao_financeira', false)
          .range(offset, offset + PAGE - 1)
        if (error) throw error
        contas.push(...data)
        if (data.length < PAGE) break
      }
    }

    const resumo = resumoVazio()

    for (const conta of contas ?? []) {
      // Reavalia janela/limites a cada iteração — cada envio espera 45-90s de
      // verdade, então uma execução longa pode cruzar a virada da hora ou o
      // fim da janela no meio do caminho.
      if (!dentroDoHorarioPermitido()) {
        console.log('[cobranca-whatsapp] saiu da janela de 08h-17h BRT no meio da execução — parando, aguarda próximo ciclo')
        resumo.paradoPor = 'fora_do_horario'
        break
      }
      if (enviadasHoje >= LIMITE_DIARIO) {
        console.log(`[cobranca-whatsapp] limite diário atingido (${enviadasHoje}/${LIMITE_DIARIO}) no meio da execução — parando`)
        resumo.paradoPor = 'limite_diario'
        break
      }
      const enviadasNestaHora = await contarEnviadasCronDesde(inicioDaHoraAtualISO())
      if (enviadasNestaHora >= LIMITE_POR_HORA) {
        console.log(`[cobranca-whatsapp] limite por hora atingido (${enviadasNestaHora}/${LIMITE_POR_HORA}) — parando, aguarda próximo ciclo`)
        resumo.paradoPor = 'limite_por_hora'
        break
      }

      const diasAtraso = diasAtrasoDe(conta.vencimento)
      const etapa = calcularEtapa(diasAtraso)
      if (etapa === null) continue

      // Baixa parcial pode já ter quitado o título inteiro mesmo com status
      // ainda 'aberta/vencida' no legado (status não é atualizado em tempo real).
      const saldo = Number(conta.valor || 0) - Number(conta.valor_pago || 0)
      if (saldo <= 0) {
        resumo.quitados++
        continue
      }
      resumo.elegiveis++

      if (!conta.telefone_cobranca) {
        resumo.semTelefone++
        continue
      }

      // Um cliente pode ter vários títulos elegíveis no mesmo dia — sem essa
      // trava, ele levaria uma mensagem por título, em sequência, o que é
      // exatamente o padrão de rajada que causou a suspensão do número.
      if (telefonesContatados.has(conta.telefone_cobranca)) {
        resumo.jaContatadoHoje++
        continue
      }

      const { data: jaEnviada } = await supabase
        .from('cobrancas_whatsapp')
        .select('id')
        .eq('contas_financeiras_id', conta.id)
        .eq('etapa', etapa)
        .eq('origem', 'cron')
        .maybeSingle()
      if (jaEnviada) {
        resumo.jaEnviadas++
        continue
      }

      const mensagem = montarMensagem(etapa, {
        nome: conta.pessoa_nome, valor: saldo, vencimento: conta.vencimento, diasAtraso,
      })

      // Intervalo ANTES de cada envio (inclusive o primeiro da execução) — nunca
      // dispara duas mensagens em sequência imediata.
      await aguardarIntervaloAleatorio()

      const timestamp = new Date().toISOString()
      try {
        const resultadoEnvio = await enviarCobrancaComRoteamento({
          contasFinanceirasId: conta.id, etapa, clienteNome: conta.pessoa_nome,
          clienteTelefone: conta.telefone_cobranca, valor: saldo, mensagem, origem: 'cron',
        })
        if (resultadoEnvio.status === 'blocked' && resultadoEnvio.reason === 'sync_stale') {
          // Sync ficou velho/caiu NO MEIO da execução — para o lote inteiro
          // (não é erro desta conta, é sinal de que nenhuma conta seguinte
          // deveria ser tentada agora).
          resumo.paradoPor = 'sync_stale'
          resumo.guard = resultadoEnvio.guard
          break
        }
        if (resultadoEnvio.status !== 'sent') {
          throw new Error(`motor de envio não concluiu: ${resultadoEnvio.motivo || resultadoEnvio.status}`)
        }
        const { error: erroInsert } = await supabase.from('cobrancas_whatsapp').insert({
          contas_financeiras_id: conta.id,
          cliente_nome: conta.pessoa_nome,
          cliente_telefone: conta.telefone_cobranca,
          valor: saldo,
          vencimento: conta.vencimento,
          dias_atraso: diasAtraso,
          etapa,
          status: 'enviada',
          origem: 'cron',
          data_envio: timestamp,
          mensagem_enviada: mensagem,
        })
        // 23505 = unique_violation — corrida rara com outra execução concorrente da régua;
        // trata como "já enviada" em vez de erro.
        if (erroInsert && erroInsert.code === '23505') {
          resumo.jaEnviadas++
          console.log(`[cobranca-whatsapp] ${timestamp} | ${conta.telefone_cobranca} | etapa ${etapa} | JA_ENVIADA (corrida concorrente)`)
        } else if (erroInsert) {
          throw erroInsert
        } else {
          resumo.enviadas++
          enviadasHoje++
          telefonesContatados.add(conta.telefone_cobranca)
          console.log(`[cobranca-whatsapp] ${timestamp} | ${conta.telefone_cobranca} | etapa ${etapa} | ENVIADA`)
        }
      } catch (err) {
        resumo.erros++
        console.error(`[cobranca-whatsapp] ${timestamp} | ${conta.telefone_cobranca} | etapa ${etapa} | ERRO: ${err.message}`)
      }
    }

    console.log('[cobranca-whatsapp] execução concluída:', resumo)
    return resumo
  } finally {
    emExecucao = false
  }
}
