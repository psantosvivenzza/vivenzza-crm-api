import { Router } from 'express'
import { supabase } from '../lib/supabase.js'
import { calcularEtapa, montarMensagem } from '../lib/reguaCobranca.js'
import { enviarTextoFinanceiro } from '../lib/evolutionFinanceiro.js'
import { executarReguaCobranca } from '../jobs/cobranca-whatsapp.js'

const router = Router()

function diasAtrasoDe(vencimento) {
  const hojeBrt = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
  const umDia = 24 * 60 * 60 * 1000
  return Math.floor((new Date(hojeBrt) - new Date(vencimento)) / umDia)
}

// POST /api/cobrancas/disparar — roda a régua agora (mesmo gate do switch que o cron usa)
router.post('/disparar', async (req, res) => {
  try {
    const resumo = await executarReguaCobranca()
    res.json(resumo)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// POST /api/cobrancas/disparar-individual/:pessoaNome — ação manual por cliente.
// Agrupado por pessoa_nome (não por título) porque um cliente pode ter vários títulos
// em aberto — soma o total devido, usa o pior atraso pra decidir a mensagem, manda 1
// mensagem consolidada. Não passa pelo switch (é ação humana pontual) nem pela trava
// de "1x por etapa" do cron (origem='manual' fica fora do índice único).
router.post('/disparar-individual/:pessoaNome', async (req, res) => {
  try {
    const pessoaNome = decodeURIComponent(req.params.pessoaNome)

    const { data: contas, error } = await supabase
      .from('contas_financeiras')
      .select('id, valor, vencimento, telefone_cobranca')
      .eq('tipo', 'receber')
      .in('status', ['aberta', 'vencida'])
      .eq('pessoa_nome', pessoaNome)

    if (error) throw error
    if (!contas?.length) return res.status(404).json({ erro: 'Nenhum título em aberto para este cliente' })

    const telefone = req.body?.telefone || contas.find((c) => c.telefone_cobranca)?.telefone_cobranca
    if (!telefone) return res.status(400).json({ erro: 'Telefone não configurado para este cliente' })

    const valorTotal = contas.reduce((soma, c) => soma + Number(c.valor || 0), 0)
    const pior = contas.reduce((a, b) => (diasAtrasoDe(a.vencimento) > diasAtrasoDe(b.vencimento) ? a : b))
    const diasAtraso = diasAtrasoDe(pior.vencimento)
    // Disparo manual pode ser clicado fora das janelas exatas da régua (ex.: título vence
    // daqui a 10 dias) — nesse caso não há template aplicável ainda; usa a etapa 1 como
    // lembrete antecipado em vez de bloquear a ação do admin.
    const etapa = calcularEtapa(diasAtraso) ?? 1

    const mensagem = montarMensagem(etapa, { nome: pessoaNome, valor: valorTotal, vencimento: pior.vencimento, diasAtraso })
    await enviarTextoFinanceiro(telefone, mensagem)

    const { data: registro, error: erroInsert } = await supabase.from('cobrancas_whatsapp').insert({
      contas_financeiras_id: pior.id,
      cliente_nome: pessoaNome,
      cliente_telefone: telefone,
      valor: valorTotal,
      vencimento: pior.vencimento,
      dias_atraso: diasAtraso,
      etapa,
      status: 'enviada',
      origem: 'manual',
      data_envio: new Date().toISOString(),
      mensagem_enviada: mensagem,
    }).select().single()
    if (erroInsert) throw erroInsert

    res.status(201).json(registro)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/cobrancas — histórico com filtros
router.get('/', async (req, res) => {
  try {
    const { status, etapa, data_inicio, data_fim, page = 1, limit = 100 } = req.query
    const offset = (Number(page) - 1) * Number(limit)

    let query = supabase
      .from('cobrancas_whatsapp')
      .select('*', { count: 'exact' })
      .order('data_envio', { ascending: false })
      .range(offset, offset + Number(limit) - 1)

    if (status) query = query.eq('status', status)
    if (etapa) query = query.eq('etapa', etapa)
    if (data_inicio) query = query.gte('data_envio', `${data_inicio}T00:00:00-03:00`)
    if (data_fim) query = query.lte('data_envio', `${data_fim}T23:59:59-03:00`)

    const { data, error, count } = await query
    if (error) throw error

    res.json({ data, total: count, page: Number(page), limit: Number(limit) })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// PATCH /api/cobrancas/:id/status — marcar respondida/paga manualmente.
// Detecção automática de resposta (via webhook) fica fora de escopo por agora.
router.patch('/:id/status', async (req, res) => {
  try {
    const { status } = req.body
    if (!['pendente', 'enviada', 'respondida', 'paga'].includes(status)) {
      return res.status(400).json({ erro: 'Status inválido' })
    }

    const campos = { status }
    if (status === 'respondida') campos.data_resposta = new Date().toISOString()

    const { data, error } = await supabase
      .from('cobrancas_whatsapp')
      .update(campos)
      .eq('id', req.params.id)
      .select()
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ erro: 'Cobrança não encontrada' })

    res.json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/cobrancas/status — estado atual do kill-switch da régua automática
router.get('/status', async (req, res) => {
  try {
    const { data } = await supabase.from('automacoes_config').select('cobranca_whatsapp_ativa').eq('id', 1).maybeSingle()
    res.json({ cobranca_whatsapp_ativa: data?.cobranca_whatsapp_ativa === true })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// POST /api/cobrancas/toggle — liga/desliga o kill-switch da régua automática
router.post('/toggle', async (req, res) => {
  try {
    const { data: atual } = await supabase.from('automacoes_config').select('cobranca_whatsapp_ativa').eq('id', 1).maybeSingle()
    const novoValor = !(atual?.cobranca_whatsapp_ativa === true)

    const { error } = await supabase.from('automacoes_config').update({ cobranca_whatsapp_ativa: novoValor }).eq('id', 1)
    if (error) throw error

    res.json({ cobranca_whatsapp_ativa: novoValor })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

export default router
