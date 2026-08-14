/**
 * Fase 3 do atendimento avançado no WhatsApp: monitora leads ativos cuja última
 * mensagem foi do CLIENTE (direcao='entrada') e escalona notificações in-app
 * conforme o tempo sem resposta: 15min (vendedor), 30min (vendedor+admins),
 * 2h (admins, crítico). Reaproveita a RPC get_ultima_mensagem_por_lead (Fase 1).
 *
 * escalation_log garante 1 notificação por nível por "episódio" de espera — quando
 * o lead volta a ser respondido (última mensagem passa a ser 'saida'), suas linhas
 * são apagadas, liberando os níveis pra dispararem de novo na próxima espera.
 */
import { supabase } from '../lib/supabase-admin.server.js'

const LIMIAR_15MIN = 15
const LIMIAR_30MIN = 30
const LIMIAR_2H = 120

const TITULOS_POR_NIVEL = {
  1: 'Cliente aguardando resposta',
  2: 'Cliente aguardando há 30 min',
  3: 'Alerta crítico — 2h sem resposta',
}

async function buscarUltimaMensagemEntradaId(leadId) {
  const { data } = await supabase
    .from('whatsapp_mensagens')
    .select('id')
    .eq('lead_id', leadId)
    .eq('direcao', 'entrada')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data?.id ?? null
}

// Trava de reentrância. O cron dispara a cada minuto; se uma execução demorar
// mais que isso, a próxima começava por cima e as duas passavam a disputar o
// mesmo banco. Foi assim que este job derrubou o CRM em 14/08: as execuções
// empilharam e o Supabase passou a receber ~70 requisições por segundo,
// esgotando o pool de conexões pra todo mundo — inclusive pras vendedoras.
let emExecucao = false

export async function runMonitoramentoResposta() {
  if (emExecucao) {
    console.log('[monitoramento-resposta] execução anterior ainda rodando — pulando este ciclo')
    return { verificados: 0, notificados: 0, pulado: true }
  }
  emExecucao = true
  try {
    return await executar()
  } finally {
    emExecucao = false
  }
}

async function executar() {
  const agora = Date.now()

  // Só leads ativos — 'fechado'/'perdido' são os estados terminais do funil (leads.js).
  // Paginado: PostgREST limita a 1000 linhas por padrão — sem isso, com milhares de
  // leads ativos, só os primeiros 1000 eram verificados e o resto nunca escalonava.
  const leadsAtivos = []
  const PAGE_LEADS = 1000
  for (let offset = 0; ; offset += PAGE_LEADS) {
    const { data, error } = await supabase
      .from('leads')
      .select('id, nome, responsavel_id')
      .not('etapa', 'in', '(fechado,perdido)')
      .range(offset, offset + PAGE_LEADS - 1)
    if (error) {
      console.error('[monitoramento-resposta] erro ao buscar leads:', error.message)
      return { verificados: 0, notificados: 0 }
    }
    leadsAtivos.push(...data)
    if (data.length < PAGE_LEADS) break
  }
  if (leadsAtivos.length === 0) return { verificados: 0, notificados: 0 }

  const leadsPorId = new Map(leadsAtivos.map((l) => [l.id, l]))
  const leadIds = leadsAtivos.map((l) => l.id)

  // Última mensagem por lead — mesma RPC usada em GET /api/whatsapp/status-espera.
  // Paginado por segurança: PostgREST limita a 1000 linhas por padrão, inclusive em RPC.
  const ultimaPorLead = []
  const PAGE = 1000
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase
      .rpc('get_ultima_mensagem_por_lead', { p_lead_ids: leadIds })
      .range(offset, offset + PAGE - 1)
    if (error) {
      console.error('[monitoramento-resposta] erro na RPC:', error.message)
      return { verificados: 0, notificados: 0 }
    }
    ultimaPorLead.push(...data)
    if (data.length < PAGE) break
  }

  const { data: admins } = await supabase.from('usuarios').select('id').eq('role', 'admin')
  const adminIds = (admins || []).map((a) => a.id)

  // Quais leads REALMENTE têm episódio de escalonamento aberto.
  //
  // Antes, todo lead já respondido levava um DELETE individual em
  // escalation_log a cada minuto — 3.500 chamadas HTTP por ciclo, das quais
  // ~99% não apagavam nada. Uma consulta só resolve: a tabela tem poucas
  // dezenas de linhas, então dá pra saber de antemão quem precisa de limpeza.
  const leadsComEscalonamento = new Set()
  {
    const PAGE = 1000
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await supabase
        .from('escalation_log')
        .select('lead_id, level')
        .range(offset, offset + PAGE - 1)
      if (error) {
        console.error('[monitoramento-resposta] erro ao ler escalation_log:', error.message)
        return { verificados: leadsAtivos.length, notificados: 0 }
      }
      for (const r of data) leadsComEscalonamento.add(`${r.lead_id}|${r.level}`)
      if (data.length < PAGE) break
    }
  }
  const temAlgumNivel = (leadId) =>
    [1, 2, 3].some((n) => leadsComEscalonamento.has(`${leadId}|${n}`))

  let notificados = 0
  const aLimpar = []
  const aInserir = []

  for (const item of ultimaPorLead) {
    const lead = leadsPorId.get(item.lead_id)
    if (!lead) continue

    if (item.direcao !== 'entrada') {
      // Cliente já foi respondido — libera o próximo episódio de espera.
      // Só entra na lista quem de fato tem linha pra apagar; apagar "por via
      // das dúvidas" em todo lead respondido é o que gerava milhares de
      // chamadas inúteis por minuto.
      if (temAlgumNivel(lead.id)) aLimpar.push(lead.id)
      continue
    }

    const minutos = (agora - new Date(item.created_at).getTime()) / 60000
    let nivelAtual = null
    if (minutos >= LIMIAR_2H) nivelAtual = 3
    else if (minutos >= LIMIAR_30MIN) nivelAtual = 2
    else if (minutos >= LIMIAR_15MIN) nivelAtual = 1
    if (!nivelAtual) continue

    // Só busca a mensagem se houver mesmo algum nível novo a notificar. Antes
    // essa consulta rodava pra todo lead em espera a cada minuto — sozinha,
    // eram ~500 leituras por minuto em whatsapp_mensagens, pra na maioria das
    // vezes descobrir que já estava tudo notificado.
    const temNivelNovo = Array.from({ length: nivelAtual }, (_, i) => i + 1)
      .some((n) => !leadsComEscalonamento.has(`${lead.id}|${n}`))
    if (!temNivelNovo) continue

    const mensagemId = await buscarUltimaMensagemEntradaId(lead.id)
    const descricao = `${lead.nome} está sem resposta há ${Math.floor(minutos)} minutos.`

    // Dispara todos os níveis até o atual ainda não notificados nesse episódio — se o
    // job ficar parado e o lead pular direto pra 2h, o vendedor ainda recebe o nível 1.
    //
    // upsert(ignoreDuplicates) em vez de insert(): com milhares de leads ativos e o job
    // rodando a cada 1 min, a maioria dos leads já escalonados batia em UNIQUE(lead_id,
    // level) TODA execução — um INSERT que sempre falha ainda gera uma linha de ERRO no
    // log do Postgres mesmo quando a aplicação trata o 23505 sem logar nada. Com
    // ignoreDuplicates, em conflito o Postgres simplesmente não escreve (sem erro) e o
    // .select() volta vazio — mesmo sinal de "já notificado", sem gerar erro nenhum.
    for (let nivel = 1; nivel <= nivelAtual; nivel++) {
      // O conjunto lido no início já diz quais níveis foram notificados neste
      // episódio. Consultar isso em memória evita um upsert por lead por nível
      // por minuto — que era a outra metade da enxurrada de requisições.
      if (leadsComEscalonamento.has(`${lead.id}|${nivel}`)) {
        continue // já notificado esse nível nesse episódio, segue pro próximo
      }
      aInserir.push({ lead_id: lead.id, level: nivel })
      leadsComEscalonamento.add(`${lead.id}|${nivel}`)

      const destinatarios = new Set()
      if (nivel === 1) {
        if (lead.responsavel_id) destinatarios.add(lead.responsavel_id)
      } else if (nivel === 2) {
        if (lead.responsavel_id) destinatarios.add(lead.responsavel_id)
        adminIds.forEach((id) => destinatarios.add(id))
      } else {
        adminIds.forEach((id) => destinatarios.add(id))
      }

      for (const userId of destinatarios) {
        const { error: notifError } = await supabase.from('notifications').insert({
          user_id: userId,
          type: 'aguardando_resposta',
          title: TITULOS_POR_NIVEL[nivel],
          description: descricao,
          conversation_id: lead.id,
          message_id: mensagemId,
          escalation_level: nivel,
        })
        if (notifError) {
          console.error('[monitoramento-resposta] erro ao criar notificação:', notifError.message)
          continue
        }
        notificados++
      }
    }
  }

  // ── Escrita em lote, no fim ────────────────────────────────────────────
  // Um DELETE e um UPSERT para o ciclo inteiro, em vez de um por lead. Com
  // 3.543 leads ativos isso sai de ~3.500 chamadas por minuto para 2.
  if (aLimpar.length) {
    for (let i = 0; i < aLimpar.length; i += 200) {
      const { error } = await supabase
        .from('escalation_log')
        .delete()
        .in('lead_id', aLimpar.slice(i, i + 200))
      if (error) console.error('[monitoramento-resposta] erro ao limpar escalation_log:', error.message)
    }
  }

  if (aInserir.length) {
    for (let i = 0; i < aInserir.length; i += 200) {
      const { error } = await supabase
        .from('escalation_log')
        .upsert(aInserir.slice(i, i + 200), { onConflict: 'lead_id,level', ignoreDuplicates: true })
      if (error) console.error('[monitoramento-resposta] erro ao gravar escalation_log:', error.message)
    }
  }

  const resultado = {
    verificados: leadsAtivos.length,
    notificados,
    episodios_limpos: aLimpar.length,
    niveis_registrados: aInserir.length,
  }
  console.log('[monitoramento-resposta] concluído:', resultado)
  return resultado
}
