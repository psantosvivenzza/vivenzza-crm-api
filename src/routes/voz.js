// Painel da Central de Voz — leitura das views de auditoria das ligações de
// cobrança por IA.
//
// POR QUE ESTE PAINEL EXISTE: até 18/09/2026, saber o que as ligações
// estavam fazendo dependia de alguém consultar o banco à mão. No primeiro
// dia de operação real isso já custou caro — uma ligação conversou 36s com
// uma caixa postal e dois números nunca tocaram (cadastro provavelmente
// desativado), e nada disso apareceria para a equipe.
//
// Só LEITURA. Nenhuma rota aqui dispara ligação: quem dispara é o script da
// fila, com a régua e os tetos. Um painel que liga é um painel que um clique
// errado transforma em incidente.
import { Router } from 'express'
import { supabase } from '../lib/supabase-admin.server.js'

const router = Router()

const LIMITE_DETALHE_MAX = 200

async function lerView(nome, montar) {
  const query = montar(supabase.from(nome).select('*'))
  const { data, error } = await query
  if (error) throw new Error(`${nome}: ${error.message}`)
  return data ?? []
}

// GET /api/voz/painel — tudo que a tela precisa, numa chamada só.
// Evita 6 requisições em sequência cada vez que alguém abre a página.
router.get('/painel', async (req, res) => {
  try {
    const dias = Math.min(Math.max(Number(req.query.dias) || 14, 1), 90)
    const desde = new Date(Date.now() - dias * 86400000).toISOString().slice(0, 10)

    const [operacao, faixas, saude, risco, foraDaJanela] = await Promise.all([
      lerView('vw_voice_operacao_dia', (q) => q.gte('dia', desde).order('dia', { ascending: false })),
      lerView('vw_voice_atendimento_por_faixa', (q) => q),
      lerView('vw_voice_saude_ia', (q) => q),
      lerView('vw_voice_risco', (q) => q),
      lerView('vw_voice_fora_da_janela_legal', (q) => q.order('quando_brt', { ascending: false }).limit(50)),
    ])

    res.json({
      periodoDias: dias,
      operacaoPorDia: operacao,
      atendimentoPorFaixa: faixas,
      saudeIa: saude?.[0] ?? null,
      risco: risco?.[0] ?? null,
      // Ligação fora da janela legal (seg-sex, 08:00-18:40) é o alarme mais
      // sério do painel: é risco jurídico, não métrica. Vazio é o esperado.
      foraDaJanelaLegal: foraDaJanela,
    })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/voz/chamadas — detalhe chamada a chamada, com filtros.
router.get('/chamadas', async (req, res) => {
  try {
    const limite = Math.min(Math.max(Number(req.query.limite) || 100, 1), LIMITE_DETALHE_MAX)
    let q = supabase.from('vw_voice_chamadas_detalhe').select('*')

    if (req.query.desde) q = q.gte('quando_brt', req.query.desde)
    if (req.query.status) q = q.eq('status', req.query.status)
    if (req.query.campanha) q = q.eq('campanha', req.query.campanha)
    if (req.query.atendidas === 'true') q = q.eq('atendida', true)
    if (req.query.pediuHumano === 'true') q = q.eq('pediu_humano', true)
    if (req.query.cliente) q = q.ilike('cliente', `%${req.query.cliente}%`)

    const { data, error } = await q.order('quando_brt', { ascending: false }).limit(limite)
    if (error) throw new Error(error.message)
    res.json({ total: data?.length ?? 0, chamadas: data ?? [] })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/voz/fila — quem está na fila agora e quem está bloqueado, e por quê.
// É a pergunta que a equipe faz primeiro: "por que fulano não foi chamado?"
router.get('/fila', async (req, res) => {
  try {
    const limite = Math.min(Math.max(Number(req.query.limite) || 50, 1), LIMITE_DETALHE_MAX)
    const { data, error } = await supabase
      .from('vw_fila_ligacao_cobranca')
      .select('cliente, codigo_cliente, telefone_mascarado, titulos, valor_total, dias_atraso_max, faixa, tentativas_ciclo, ultima_ligacao, promessa_ate, motivo_bloqueio')
      .order('valor_total', { ascending: false })
      .limit(limite)
    if (error) throw new Error(error.message)

    const liberados = (data ?? []).filter((c) => !c.motivo_bloqueio)
    res.json({
      total: data?.length ?? 0,
      liberados: liberados.length,
      bloqueados: (data?.length ?? 0) - liberados.length,
      fila: data ?? [],
    })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/voz/telefones-suspeitos — números que nunca chegaram a tocar.
// Achado do 1o dia real: "Unknown" sem nunca ter tocado costuma ser linha
// desativada, ou seja, CADASTRO para corrigir — não é falha de telefonia.
// Sem isto, esses clientes queimam tentativa da régua todo ciclo, para sempre.
router.get('/telefones-suspeitos', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('vw_voice_chamadas_detalhe')
      .select('cliente, codigo_cliente, telefone_mascarado, quando_brt, status, hangup_cause')
      .eq('status', 'FAILED')
      .order('quando_brt', { ascending: false })
      .limit(LIMITE_DETALHE_MAX)
    if (error) throw new Error(error.message)

    const porCliente = new Map()
    for (const c of data ?? []) {
      const chave = c.codigo_cliente ?? c.cliente
      const atual = porCliente.get(chave) ?? { ...c, falhas: 0, ultima: c.quando_brt }
      atual.falhas += 1
      porCliente.set(chave, atual)
    }
    const lista = [...porCliente.values()].sort((a, b) => b.falhas - a.falhas)
    res.json({ total: lista.length, clientes: lista })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// --- Retornos humanos -----------------------------------------------------
// Quando o cliente pede atendente, o robo PROMETE que alguem retorna. Estas
// duas rotas sao o que fecha esse ciclo: a lista do que esta prometido e nao
// foi feito, e o registro do que aconteceu no retorno.
//
// O desfecho NAO e so historico: promessa de pagamento grava data_prometida e
// contato efetivo grava contato_humano_efetivo, os dois campos que a regua de
// tentativas ja le. E o que impede o robo de ligar amanha para o cliente com
// quem o financeiro acabou de falar.

const DESFECHOS = {
  PROMETEU_PAGAR: { efetivo: true, exigeData: true },
  JA_PAGOU: { efetivo: true, exigeData: false },
  CONTESTOU: { efetivo: true, exigeData: false },
  SEM_CONDICAO: { efetivo: true, exigeData: false },
  FALADO_SEM_DEFINICAO: { efetivo: true, exigeData: false },
  NAO_ATENDEU: { efetivo: false, exigeData: false },
  TELEFONE_ERRADO: { efetivo: false, exigeData: false },
}

// GET /api/voz/retornos-pendentes — o que foi prometido ao cliente e ainda
// nao foi cumprido. Lista curta de proposito: e uma fila de trabalho, nao um
// relatorio.
router.get('/retornos-pendentes', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('voice_calls')
      .select('call_id, cliente_nome, codigo_cliente, destination_masked, started_at, intent_final, transcricao')
      .eq('requires_human', true)
      .is('retorno_humano_em', null)
      .order('started_at', { ascending: false })
      .limit(100)
    if (error) throw new Error(error.message)
    res.json({ total: data?.length ?? 0, retornos: data ?? [] })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// POST /api/voz/retornos/:callId — registra o que aconteceu no retorno.
router.post('/retornos/:callId', async (req, res) => {
  try {
    const { desfecho, dataPrometida, valorPrometido, observacao } = req.body ?? {}
    const regra = DESFECHOS[String(desfecho || '').toUpperCase()]
    if (!regra) {
      return res.status(400).json({ erro: `desfecho inválido — use um de: ${Object.keys(DESFECHOS).join(', ')}` })
    }
    if (regra.exigeData && !dataPrometida) {
      return res.status(400).json({ erro: 'promessa de pagamento exige a data prometida' })
    }
    if (dataPrometida && !/^\d{4}-\d{2}-\d{2}$/.test(dataPrometida)) {
      return res.status(400).json({ erro: 'dataPrometida deve estar no formato AAAA-MM-DD' })
    }

    const patch = {
      retorno_humano_em: new Date().toISOString(),
      retorno_humano_desfecho: String(desfecho).toUpperCase(),
      retorno_humano_por: req.user?.id ?? null,
      retorno_humano_observacao: observacao ? String(observacao).slice(0, 1000) : null,
      contato_humano_efetivo: regra.efetivo,
    }
    // Só grava promessa quando houve promessa: um null aqui apagaria uma
    // promessa que a propria ligacao tinha capturado.
    if (dataPrometida) patch.data_prometida = dataPrometida
    if (valorPrometido != null && !Number.isNaN(Number(valorPrometido))) {
      patch.valor_prometido = Number(valorPrometido)
    }

    const { data, error } = await supabase
      .from('voice_calls')
      .update(patch)
      .eq('call_id', req.params.callId)
      .select('call_id, cliente_nome, tarefa_id, retorno_humano_desfecho, data_prometida')
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) return res.status(404).json({ erro: 'ligação não encontrada' })

    // Fecha a tarefa junto, para o financeiro nao ter de marcar concluida em
    // dois lugares. Best-effort: o registro do desfecho e o que importa.
    if (data.tarefa_id) {
      await supabase.from('tarefas').update({ status: 'concluida' }).eq('id', data.tarefa_id)
    }

    res.json({ ok: true, retorno: data })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

export default router
