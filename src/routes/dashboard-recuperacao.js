// GET /api/financeiro/dashboard-recuperacao — painel operacional agregado de
// recuperação financeira/cobrança. 100% leitura — nenhuma escrita, nenhum
// disparo de WhatsApp, nenhuma alteração de título/pagamento/promessa.
// Reaproveita as mesmas fontes de verdade já estabelecidas no módulo
// (statusQuitacaoTitulo/aging.js para "em aberto", providerAttemptCounter.js/
// doNotContactGuard.js para cobrança/contato) em vez de inventar novas.
//
// Revisão semântica 2026-09-02 — auditoria explícita encontrou uma
// atribuição causal indevida (baixa tardia "= recuperada pela cobrança") e
// uma exclusão faltando em "em cobrança" (títulos com promessa ativa não
// entram na régua — ver dispatchEngine.js). Corrigido abaixo, com o raciocínio
// documentado em cada bloco pra não repetir o erro numa próxima revisão.
import { Router } from 'express'
import { supabase } from '../lib/supabase-admin.server.js'
import { registroAindaValido } from '../lib/collection/doNotContactGuard.js'
import { obterConfigCobranca } from '../lib/collection/featureFlags.js'

const router = Router()

const TIMEZONE = 'America/Sao_Paulo'
const UM_DIA_MS = 24 * 60 * 60 * 1000
const PERIODOS_VALIDOS = ['hoje', '7dias', '30dias', 'mes']

function hojeBrtISO() {
  return new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE })
}

function adicionarDiasISO(dataISO, dias) {
  const d = new Date(`${dataISO}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + dias)
  return d.toISOString().slice(0, 10)
}

// Sempre "desde uma data até hoje (BRT)" — nunca uma janela arbitrária no
// passado, coerente com o resto do módulo (contarTentativasReaisDesde etc.
// também são sempre "desde X até agora").
function intervaloPeriodo(chaveBruta) {
  const chave = PERIODOS_VALIDOS.includes(chaveBruta) ? chaveBruta : 'mes'
  const hoje = hojeBrtISO()
  if (chave === 'hoje') return { chave, data_inicio: hoje, data_fim: hoje }
  if (chave === '7dias') return { chave, data_inicio: adicionarDiasISO(hoje, -6), data_fim: hoje }
  if (chave === '30dias') return { chave, data_inicio: adicionarDiasISO(hoje, -29), data_fim: hoje }
  return { chave: 'mes', data_inicio: `${hoje.slice(0, 7)}-01`, data_fim: hoje }
}

function diasAtrasoDe(vencimento) {
  return Math.floor((new Date(hojeBrtISO()) - new Date(vencimento)) / UM_DIA_MS)
}

// Faixas D+ pedidas nesta tarefa — mais finas que as do Aging Report
// (/api/financeiro/aging usa a_vencer/1-30/31-60/61-90/90+); os dois convivem,
// mesma fonte (vencimento vs hoje BRT), nunca confiam em `status` (título
// legado importado sempre como 'aberta' independente do atraso real).
function faixaDiasAtraso(dias) {
  if (dias <= 0) return null
  if (dias <= 7) return '1_7'
  if (dias <= 15) return '8_15'
  if (dias <= 30) return '16_30'
  if (dias <= 60) return '31_60'
  if (dias <= 90) return '61_90'
  return '90_mais'
}
const faixasVazias = () => ({ '1_7': 0, '8_15': 0, '16_30': 0, '31_60': 0, '61_90': 0, '90_mais': 0 })

function round2(n) {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100
}
function mapRound2(obj) {
  const out = {}
  for (const k of Object.keys(obj)) out[k] = round2(obj[k])
  return out
}

// PostgREST limita a 1000 linhas por resposta — paginar sempre (mesmo padrão
// já usado em aging.js/collection-shadow-reports.js) pra nunca truncar em
// silêncio quando a tabela crescer além do limite.
async function buscarTodasAsLinhas(tabela, colunas, filtro) {
  const linhas = []
  const PAGE = 1000
  for (let offset = 0; ; offset += PAGE) {
    let query = supabase.from(tabela).select(colunas).range(offset, offset + PAGE - 1)
    if (filtro) query = filtro(query)
    const { data, error } = await query
    if (error) throw error
    linhas.push(...(data ?? []))
    if (!data || data.length < PAGE) break
  }
  return linhas
}

router.get('/', async (req, res) => {
  try {
    const periodo = intervaloPeriodo(req.query.periodo)

    // ---- A/B/C/D/G/R — universo de títulos "receber" em aberto (snapshot
    // atual, não depende do período escolhido). Fonte: contas_financeiras,
    // status IN (aberta,vencida,pago_parcial) — mesmo predicado de "em
    // aberto" usado por statusQuitacaoTitulo()/aging.js. saldo = valor -
    // valor_pago, a única verdade financeira do projeto (nunca `valor` só). ----
    const contasAbertas = await buscarTodasAsLinhas(
      'contas_financeiras',
      'id, valor, valor_pago, vencimento, telefone_cobranca, em_revisao_financeira',
      (q) => q.eq('tipo', 'receber').in('status', ['aberta', 'vencida', 'pago_parcial'])
    )

    let totalAberto = 0
    let totalVencido = 0
    let totalAVencer = 0
    let emRevisaoTitulos = 0
    let emRevisaoValor = 0
    const aging = faixasVazias()

    for (const c of contasAbertas) {
      const saldo = Number(c.valor || 0) - Number(c.valor_pago || 0)
      totalAberto += saldo
      const dias = diasAtrasoDe(c.vencimento)
      if (dias > 0) {
        totalVencido += saldo
        const faixa = faixaDiasAtraso(dias)
        if (faixa) aging[faixa] += saldo
      } else {
        totalAVencer += saldo
      }
      if (c.em_revisao_financeira) {
        emRevisaoTitulos++
        emRevisaoValor += saldo
      }
    }

    // ---- L — contatos inválidos/bloqueados. Fonte: collection_do_not_contact,
    // só registros AINDA válidos (reusa registroAindaValido() — mesma lógica
    // de expiração de quarentena/opt-out do guard real de disparo, nunca
    // reimplementada aqui). ----
    const registrosDnc = await buscarTodasAsLinhas('collection_do_not_contact', 'cliente_telefone, expira_em')
    const telefonesBloqueados = new Set(registrosDnc.filter(registroAindaValido).map((r) => r.cliente_telefone))

    // ---- I/J/K — promessas. "Ativas" é sempre SNAPSHOT do estado atual (não
    // tem sentido de período — uma promessa ou está ativa agora, ou não
    // está); "cumpridas"/"quebradas" são FLUXO — contadas pela data real da
    // transição (fulfilled_at/broken_at) que caiu dentro do período
    // escolhido. Nunca misturar os dois sentidos numa mesma leitura. ----
    const [{ data: promessasAtivasLinhas, count: promessasAtivas, error: erroAtivas }, { count: promessasCumpridas, error: erroCumpridas }, { count: promessasQuebradas, error: erroQuebradas }] =
      await Promise.all([
        supabase.from('collection_promises').select('contas_financeiras_id', { count: 'exact' }).eq('status', 'ativa'),
        supabase.from('collection_promises').select('id', { count: 'exact', head: true }).eq('status', 'cumprida').gte('fulfilled_at', periodo.data_inicio),
        supabase.from('collection_promises').select('id', { count: 'exact', head: true }).eq('status', 'quebrada').gte('broken_at', periodo.data_inicio),
      ])
    if (erroAtivas) throw erroAtivas
    if (erroCumpridas) throw erroCumpridas
    if (erroQuebradas) throw erroQuebradas
    const contasComPromessaAtiva = new Set((promessasAtivasLinhas ?? []).map((p) => p.contas_financeiras_id))

    // ---- G — títulos/clientes atualmente "em cobrança": em aberto, com
    // telefone cadastrado, fora de revisão financeira, fora de bloqueio de
    // contato E fora de "silêncio inteligente" — dispatchEngine.js consulta
    // promessaAtivaPara() ANTES de qualquer envio e pula o título
    // (status:'skipped', motivo:'promessa_ativa') quando há promessa ativa.
    // Um título com promessa ativa NÃO está sendo contatado agora — contá-lo
    // aqui inflaria a métrica com títulos pausados, não elegíveis de fato. ----
    let titulosElegiveisCobranca = 0
    const clientesElegiveis = new Set()
    for (const c of contasAbertas) {
      if (
        !c.em_revisao_financeira &&
        c.telefone_cobranca &&
        !telefonesBloqueados.has(c.telefone_cobranca) &&
        !contasComPromessaAtiva.has(c.id)
      ) {
        titulosElegiveisCobranca++
        clientesElegiveis.add(c.telefone_cobranca)
      }
    }

    // ---- E/Q — recebido no período (+ quebra por faixa de atraso NO
    // MOMENTO DO PAGAMENTO). Fonte: baixas_financeiras com status='ativa'
    // (nunca 'estornada') — é literalmente o mesmo predicado que
    // fn_baixar_titulo/fn_estornar_baixa usam pra recalcular valor_pago da
    // conta, a MESMA verdade financeira, não uma aproximação; período pela
    // data real da baixa (data_pagamento), nunca por status textual.
    //
    // NÃO existe "valor recuperado (pela cobrança)" aqui — auditoria
    // 2026-09-02 confirmou que não há vínculo estrutural entre
    // baixas_financeiras e collection_dispatches/collection_promises (sem FK,
    // sem coluna própria), e o job cobranca-whatsapp.js dispara pra
    // essencialmente TODO título vencido como política de rotina — então
    // "existia um dispatch antes desta baixa" seria verdade pra quase
    // qualquer pagamento tardio, não discrimina "pago por causa da cobrança"
    // de "pago tarde por outro motivo". Sem atribuição confiável, chamar isso
    // de "recuperado" seria inventar causalidade — por isso a quebra abaixo é
    // só uma faixa de RECEBIMENTOS por atraso (dado factual: quanto foi
    // recebido enquanto o título estava com N dias de atraso), nunca uma
    // alegação de causa. Ver `nao_implementados` na resposta. ----
    const fimExclusivo = adicionarDiasISO(periodo.data_fim, 1)
    const baixasPeriodo = await buscarTodasAsLinhas(
      'baixas_financeiras',
      'conta_financeira_id, valor_baixado, data_pagamento',
      (q) => q.eq('status', 'ativa').gte('data_pagamento', periodo.data_inicio).lt('data_pagamento', fimExclusivo)
    )

    let recebidoPeriodo = 0
    const recebidoPorFaixa = faixasVazias()
    if (baixasPeriodo.length) {
      const idsContas = [...new Set(baixasPeriodo.map((b) => b.conta_financeira_id))]
      const contaPorId = new Map()
      const LOTE = 200
      for (let i = 0; i < idsContas.length; i += LOTE) {
        const lote = idsContas.slice(i, i + LOTE)
        const { data, error } = await supabase.from('contas_financeiras').select('id, vencimento, tipo').in('id', lote)
        if (error) throw error
        for (const c of data ?? []) contaPorId.set(c.id, c)
      }
      for (const b of baixasPeriodo) {
        const conta = contaPorId.get(b.conta_financeira_id)
        if (!conta || conta.tipo !== 'receber') continue // baixa de conta a pagar não é "recebido"
        const valor = Number(b.valor_baixado || 0)
        recebidoPeriodo += valor
        const diasNoPagamento = Math.floor((new Date(b.data_pagamento) - new Date(conta.vencimento)) / UM_DIA_MS)
        const faixa = faixaDiasAtraso(diasNoPagamento) // null quando pago em dia — não entra em nenhuma faixa
        if (faixa) recebidoPorFaixa[faixa] += valor
      }
    }

    // ---- M/N/O/P — performance de cobrança. Fonte EXCLUSIVA (nunca soma com
    // cobrancas_whatsapp — o mesmo envio real do motor v2 grava as duas
    // tabelas pelo mesmo evento, ver providerAttemptCounter.js): motor v2
    // (multi_whatsapp=true, automacoes_config.multi_whatsapp — não existe
    // nem é usada nenhuma flag "collection_engine_v2") → collection_dispatch_attempts,
    // purpose='collection' (exclui internal_test).
    //
    // "Entrega" aqui é REAL, não "provider aceitou o envio": status='sent'
    // só significa que a Evolution aceitou a chamada de envio — 'delivered'/
    // 'read' só são escritos por aplicarAckDeEntrega() (dispatchEngine.js),
    // chamada exclusivamente a partir de um webhook real de ACK da Evolution
    // (messages.update, códigos 3=DELIVERY_ACK/4=READ, ver webhook-handler.js
    // e evolutionAdapter.js/MAPA_STATUS_EVOLUTION) — nunca inferida a partir
    // do sucesso da chamada de envio. Por isso 'sent'/'sending' NUNCA contam
    // como entrega abaixo, só 'delivered'/'read'. (Os contadores
    // whatsapp_instances.delivered_today/read_today são mortos — nunca
    // incrementados em lugar nenhum do código — e por isso deliberadamente
    // NÃO usados aqui.)
    //
    // Motor legado não tem tabela de tentativa (gap conhecido e já
    // documentado em providerAttemptCounter.js) — sem fonte confiável pra
    // entregas/falhas/taxa nesse caso; reportado como NÃO IMPLEMENTADO em vez
    // de inventado. ----
    const config = await obterConfigCobranca()
    let tentativas = 0
    let entregas = null
    let falhas = null
    let taxaEntrega = null
    const naoImplementados = [
      { kpi: 'valor_recuperado', motivo: 'Não há atribuição confiável entre uma baixa e uma ação de cobrança: baixas_financeiras não tem vínculo estrutural (FK/coluna) com collection_dispatches/collection_promises, e o job de cobrança dispara para essencialmente todo título vencido como rotina — a mera existência de um dispatch antes do pagamento não distingue "pago por causa da cobrança" de "pago tarde por outro motivo". Ver recebimentos.recebido_por_faixa_dias_atraso para a quebra factual (sem causalidade) por atraso.' },
    ]

    if (config.multi_whatsapp === true) {
      // Brasil não observa horário de verão desde 2019 — BRT é sempre -03:00,
      // seguro fixar o offset aqui pra montar o timestamp de corte.
      const inicioISO = new Date(`${periodo.data_inicio}T00:00:00-03:00`).toISOString()
      const dispatchesPeriodo = await buscarTodasAsLinhas('collection_dispatches', 'id', (q) => q.eq('purpose', 'collection').gte('criado_em', inicioISO))
      const idsDispatch = new Set(dispatchesPeriodo.map((d) => d.id))
      entregas = 0
      falhas = 0
      if (idsDispatch.size) {
        const tentativasPeriodo = await buscarTodasAsLinhas('collection_dispatch_attempts', 'dispatch_id, status', (q) => q.gte('criado_em', inicioISO))
        for (const t of tentativasPeriodo) {
          if (!idsDispatch.has(t.dispatch_id)) continue
          tentativas++
          if (t.status === 'delivered' || t.status === 'read') entregas++
          else if (t.status === 'failed') falhas++
        }
      }
      taxaEntrega = tentativas > 0 ? Number(((entregas / tentativas) * 100).toFixed(1)) : null
    } else {
      const { count, error } = await supabase.from('cobrancas_whatsapp').select('id', { count: 'exact', head: true }).gte('data_envio', periodo.data_inicio)
      if (error) throw error
      tentativas = count ?? 0
      naoImplementados.push(
        { kpi: 'entregas_confirmadas_periodo', motivo: 'Motor legado de WhatsApp (multi_whatsapp=false) não grava tentativa/entrega/falha em tabela própria — só sucesso em cobrancas_whatsapp.' },
        { kpi: 'falhas_periodo', motivo: 'Mesmo motivo acima — sem fonte confiável no motor legado.' },
        { kpi: 'taxa_entrega_pct', motivo: 'Depende de entregas_confirmadas_periodo, indisponível no motor legado.' },
      )
    }

    res.json({
      periodo: { ...periodo, timezone: TIMEZONE },
      saldo: {
        total_aberto: round2(totalAberto),
        total_vencido: round2(totalVencido),
        total_a_vencer: round2(totalAVencer),
        inadimplencia_pct: totalAberto > 0 ? Number(((totalVencido / totalAberto) * 100).toFixed(1)) : null,
      },
      aging: mapRound2(aging),
      recebimentos: {
        recebido_periodo: round2(recebidoPeriodo),
        recebido_por_faixa_dias_atraso: mapRound2(recebidoPorFaixa),
      },
      promessas: {
        ativas: promessasAtivas ?? 0,
        cumpridas_periodo: promessasCumpridas ?? 0,
        quebradas_periodo: promessasQuebradas ?? 0,
      },
      contatos: {
        invalidos_ou_bloqueados: telefonesBloqueados.size,
        titulos_em_revisao_financeira: emRevisaoTitulos,
        valor_em_revisao_financeira: round2(emRevisaoValor),
      },
      cobranca: {
        titulos_em_cobranca: titulosElegiveisCobranca,
        clientes_em_cobranca: clientesElegiveis.size,
        tentativas_periodo: tentativas,
        entregas_confirmadas_periodo: entregas,
        falhas_periodo: falhas,
        taxa_entrega_pct: taxaEntrega,
      },
      nao_implementados: naoImplementados,
    })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

export default router
