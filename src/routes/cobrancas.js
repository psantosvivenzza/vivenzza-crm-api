import { Router } from 'express'
import { supabase } from '../lib/supabase-admin.server.js'
import { calcularEtapa, montarMensagem } from '../lib/reguaCobranca.js'
import { enviarCobrancaComRoteamento } from '../lib/collection/collectionRouting.js'
import { executarReguaCobranca } from '../jobs/cobranca-whatsapp.js'
import { verificarFrescorSync } from '../lib/collection/financialSyncGuard.js'
import { analisarIdentificadores } from '../lib/collection/consolidacaoParcelas.js'
import { adminOnly } from '../middleware/auth.js'

const router = Router()

// Chave de comparação de vencimento: o driver pode devolver string ou Date.
function chaveVencimento(v) {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '').slice(0, 10)
}

function diasAtrasoDe(vencimento) {
  const hojeBrt = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
  const umDia = 24 * 60 * 60 * 1000
  return Math.floor((new Date(hojeBrt) - new Date(vencimento)) / umDia)
}

// POST /api/cobrancas/disparar — roda a régua agora (mesmo gate do switch que o cron usa).
// Política aprovada (2026-09-08, revisão do controle de acesso financeiro):
// disparo em massa da régua inteira é operação de AUTOMAÇÃO GLOBAL (afeta
// todos os clientes elegíveis de uma vez), diferente de "gerenciar contas
// financeiras" — por isso `adminOnly` aqui, além (e antes) do
// `adminOuFinanceiro` já aplicado no mount do router inteiro em
// src/index.js. financeiro continua com a cobrança individual abaixo
// (disparar-individual), que preserva o comportamento anterior.
router.post('/disparar', adminOnly, async (req, res) => {
  try {
    const resumo = await executarReguaCobranca()
    res.json(resumo)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// POST /api/cobrancas/disparar-individual/:pessoaNome — ação manual por cliente.
// Agrupado por pessoa_nome (não por título) porque um cliente pode ter vários títulos
// em aberto — soma só os do mesmo vencimento (o mais atrasado), manda 1
// mensagem consolidada. Não passa pelo switch (é ação humana pontual) nem pela trava
// de "1x por etapa" do cron (origem='manual' fica fora do índice único).
router.post('/disparar-individual/:pessoaNome', async (req, res) => {
  try {
    const pessoaNome = decodeURIComponent(req.params.pessoaNome)

    const { data: contas, error } = await supabase
      .from('contas_financeiras')
      .select('id, valor, valor_pago, vencimento, telefone_cobranca, legacy_id')
      .eq('tipo', 'receber')
      .in('status', ['aberta', 'vencida', 'pago_parcial'])
      .eq('em_revisao_financeira', false)
      .eq('pessoa_nome', pessoaNome)

    if (error) throw error
    if (!contas?.length) return res.status(404).json({ erro: 'Nenhum título em aberto para este cliente' })

    const telefone = req.body?.telefone || contas.find((c) => c.telefone_cobranca)?.telefone_cobranca
    if (!telefone) return res.status(400).json({ erro: 'Telefone não configurado para este cliente' })

    // Baixa parcial pode já ter quitado alguns títulos mesmo com status ainda
    // aberto — soma só o saldo real, e ignora títulos já quitados na prática.
    const comSaldo = contas
      .map((c) => ({ ...c, saldo: Number(c.valor || 0) - Number(c.valor_pago || 0) }))
      .filter((c) => c.saldo > 0)
    if (!comSaldo.length) return res.status(400).json({ erro: 'Todos os títulos deste cliente já estão quitados (baixa parcial cobre o valor total)' })

    // Regra de negócio: só soma títulos do MESMO vencimento (o do título mais
    // atrasado) — títulos de outros vencimentos não entram no valor cobrado
    // (a mensagem cita um único vencimento; somar vencimentos distintos
    // geraria um valor que não corresponde a nenhuma parcela real).
    const piorBruto = comSaldo.reduce((a, b) => (diasAtrasoDe(a.vencimento) > diasAtrasoDe(b.vencimento) ? a : b))
    const doMesmoVencimento = comSaldo.filter((c) => chaveVencimento(c.vencimento) === chaveVencimento(piorBruto.vencimento))

    // Mesma proteção do cron (ver consolidacaoParcelas.js): duplicata técnica de
    // sync (mesmo legacy_id repetido) não pode dobrar o valor cobrado, e 2+
    // títulos sem legacy_id no grupo não têm como provar que são distintos —
    // nesses casos, bloqueia e pede revisão humana em vez de arriscar somar errado.
    const analise = analisarIdentificadores(doMesmoVencimento)
    if (analise.ambiguo) {
      return res.status(409).json({
        erro: 'Não foi possível determinar com segurança os títulos distintos deste cliente (duplicata sem identificador) — revise manualmente antes de cobrar.',
        motivo: analise.motivo,
      })
    }
    const deduplicados = analise.deduplicados

    // Centavos inteiros: evita deriva de ponto flutuante na soma.
    const valorTotal = deduplicados.reduce((soma, c) => soma + Math.round(c.saldo * 100), 0) / 100
    const pior = deduplicados[0]
    const diasAtraso = diasAtrasoDe(pior.vencimento)
    // Disparo manual pode ser clicado fora das janelas exatas da régua (ex.: título vence
    // daqui a 10 dias) — nesse caso não há template aplicável ainda; usa a etapa 1 como
    // lembrete antecipado em vez de bloquear a ação do admin.
    const etapa = calcularEtapa(diasAtraso) ?? 1

    const mensagem = montarMensagem(etapa, { nome: pessoaNome, valor: valorTotal, vencimento: pior.vencimento, diasAtraso })

    try {
      const resultadoEnvio = await enviarCobrancaComRoteamento({
        contasFinanceirasId: pior.id, etapa, clienteNome: pessoaNome,
        clienteTelefone: telefone, valor: valorTotal, mensagem, origem: 'manual',
      })
      if (resultadoEnvio.status !== 'sent') {
        return res.status(400).json({ erro: resultadoEnvio.erro || resultadoEnvio.motivo || 'Falha ao enviar cobrança' })
      }
    } catch (erroEnvio) {
      // Número inválido/sem WhatsApp é problema do dado, não do servidor — 400 com
      // mensagem clara em vez do 500 genérico que a Evolution API devolveria.
      return res.status(400).json({ erro: erroEnvio.message })
    }

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
// 2026-08-16 — sync_financeiro adicionado: distingue "régua configurada como
// ativa" (cobranca_whatsapp_ativa) de "envio de fato permitido agora" (guard
// de frescor do sync financeiro) — achado real, o frontend mostrava "próximo
// disparo hoje às 08h" mesmo com financialSyncGuard.allowed=false, o que é
// enganoso. Só LEITURA (verificarFrescorSync() já é cacheado, 45s) — não
// muda nenhum comportamento de envio, só expõe o estado que já existe.
router.get('/status', async (req, res) => {
  try {
    const { data } = await supabase.from('automacoes_config').select('cobranca_whatsapp_ativa').eq('id', 1).maybeSingle()
    const guardSync = await verificarFrescorSync()
    res.json({
      cobranca_whatsapp_ativa: data?.cobranca_whatsapp_ativa === true,
      sync_financeiro: {
        allowed: guardSync.allowed,
        reason: guardSync.reason,
        last_sync_at: guardSync.last_sync_at,
        age_minutes: guardSync.age_minutes,
        max_age_minutes: guardSync.max_age_minutes,
      },
    })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// POST /api/cobrancas/toggle — liga/desliga o kill-switch da régua
// automática. Política aprovada (2026-09-08): é configuração global de
// automação (afeta a régua inteira, não uma conta/cliente específico) — só
// admin, mesmo raciocínio de POST /disparar acima. `adminOnly` aqui, além
// do `adminOuFinanceiro` do mount do router em src/index.js.
router.post('/toggle', adminOnly, async (req, res) => {
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
