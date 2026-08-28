// 2026-08-27 — Fila operacional "Revisão de Contatos": clientes cujo
// telefone foi CONFIRMADO pelo provider (Evolution/WhatsApp) como
// PERMANENT_RECIPIENT (não registrado no WhatsApp), pra o Financeiro
// corrigir o cadastro na fonte correta (NetVision). Só GET, 100%
// derivado — nenhuma escrita, nenhum campo novo persistido.
//
// Fonte ÚNICA e exclusiva de inclusão: collection_do_not_contact com
// motivo='numero_invalido_whatsapp' (só existe esse valor de motivo quando
// registrarBloqueioNumeroInvalidoHoje() — chamada só na categoria
// PERMANENT_RECIPIENT, ver dispatchEngine.js/evolutionAdapter.js — grava a
// linha) e collection_dispatch_attempts com failure_kind='permanent_recipient'.
// Nunca opt-out, nunca pagamento/promessa, nunca 429/401/403/timeout/5xx/
// UNKNOWN — essas categorias nunca geram nenhuma das duas fontes acima (ver
// PR #55/#57).
//
// Status (A/B/C) é DERIVADO em tempo de leitura, nunca persistido — compara
// o telefone_cobranca ATUAL de cada título com o telefone que efetivamente
// falhou na tentativa mais recente daquele título:
//   pendente                  = telefone atual é o mesmo que falhou
//   resolvido_automaticamente = telefone mudou E o novo não tem DNC próprio
//   possivelmente_corrigido   = telefone mudou mas o novo também tem alguma
//                                linha em DNC (precisa checar manualmente)
import { Router } from 'express'
import { supabase } from '../lib/supabase-admin.server.js'
import { normalizarTelefone } from '../lib/telefone.js'

const router = Router()
const PAGE_SUPABASE = 1000
const MOTIVO_NUMERO_INVALIDO = 'numero_invalido_whatsapp'
const TRINTA_DIAS_MS = 30 * 24 * 60 * 60 * 1000

async function buscarTudoPaginado(query) {
  const linhas = []
  for (let offset = 0; ; offset += PAGE_SUPABASE) {
    const { data, error } = await query.range(offset, offset + PAGE_SUPABASE - 1)
    if (error) throw error
    linhas.push(...data)
    if (data.length < PAGE_SUPABASE) break
  }
  return linhas
}

// Mesma elegibilidade da régua real (cobranca-whatsapp.js) — "conta a
// receber relevante" = exatamente o que a régua tentaria cobrar hoje.
async function buscarContasElegiveis() {
  return buscarTudoPaginado(
    supabase
      .from('contas_financeiras')
      .select('id, codigo_cliente, pessoa_nome, telefone_cobranca, valor, valor_pago, vencimento, status')
      .eq('tipo', 'receber')
      .in('status', ['aberta', 'vencida', 'pago_parcial'])
      .eq('em_revisao_financeira', false)
  )
}

async function montarDados() {
  const agora = Date.now()

  const [{ data: dncTodos, error: e1 }, { data: tentativasFalhas, error: e2 }] = await Promise.all([
    // Única fonte de "telefone confirmado inválido pelo provider" — nunca
    // opt-out (motivo diferente), nunca outra categoria de falha.
    supabase.from('collection_do_not_contact').select('cliente_telefone, expira_em, solicitado_em').eq('motivo', MOTIVO_NUMERO_INVALIDO),
    supabase.from('collection_dispatch_attempts').select('dispatch_id, criado_em').eq('status', 'failed').eq('failure_kind', 'permanent_recipient'),
  ])
  if (e1) throw e1
  if (e2) throw e2

  const dispatchIds = [...new Set((tentativasFalhas ?? []).map((t) => t.dispatch_id))]
  const { data: dispatchesRelevantes, error: e3 } = dispatchIds.length
    ? await supabase.from('collection_dispatches').select('id, contas_financeiras_id, cliente_telefone, criado_em').in('id', dispatchIds)
    : { data: [] }
  if (e3) throw e3
  const dispatchPorId = new Map((dispatchesRelevantes ?? []).map((d) => [d.id, d]))

  // Por título (contas_financeiras_id): telefone que falhou mais
  // recentemente + contagem de falhas 30d/total. Uma tentativa sem dispatch
  // correspondente (não deveria acontecer, FK garante) é ignorada.
  const falhasPorConta = new Map()
  for (const t of tentativasFalhas ?? []) {
    const dispatch = dispatchPorId.get(t.dispatch_id)
    if (!dispatch?.contas_financeiras_id) continue
    const chave = dispatch.contas_financeiras_id
    if (!falhasPorConta.has(chave)) falhasPorConta.set(chave, { telefoneMaisRecente: null, ultimaFalhaEm: null, total: 0, ultimos30d: 0 })
    const acc = falhasPorConta.get(chave)
    acc.total++
    if (agora - new Date(t.criado_em).getTime() <= TRINTA_DIAS_MS) acc.ultimos30d++
    if (!acc.ultimaFalhaEm || t.criado_em > acc.ultimaFalhaEm) {
      acc.ultimaFalhaEm = t.criado_em
      acc.telefoneMaisRecente = dispatch.cliente_telefone
    }
  }

  const dncPorDigitos = new Map()
  for (const d of dncTodos ?? []) {
    const digitos = normalizarTelefone(d.cliente_telefone)
    if (digitos) dncPorDigitos.set(digitos, d)
  }

  const contas = await buscarContasElegiveis()
  // Cliente ENTRA na fila se algum dos seus títulos tem falha PERMANENT_
  // RECIPIENT própria, OU o telefone atual está numa linha de DNC de número
  // inválido. Uma vez que o cliente qualifica, titulos_em_aberto/valor_em_
  // aberto somam TODOS os títulos elegíveis dele (não só o(s) que falharam
  // individualmente) — corrigir o telefone destrava a cobrança da carteira
  // inteira daquele cliente, não só do título que por acaso já tentou.
  const codigosQueQualificam = new Set()
  for (const c of contas) {
    if (falhasPorConta.has(c.id)) { codigosQueQualificam.add(c.codigo_cliente); continue }
    const digitosAtual = normalizarTelefone(c.telefone_cobranca)
    if (digitosAtual && dncPorDigitos.has(digitosAtual)) codigosQueQualificam.add(c.codigo_cliente)
  }
  codigosQueQualificam.delete(undefined)
  codigosQueQualificam.delete(null)

  const codigosClientes = [...codigosQueQualificam]
  const clientesErp = codigosClientes.length
    ? await buscarTudoPaginado(supabase.from('clientes_erp').select('legacy_id, razao_social, nome_fantasia, contatos, vendedor_responsavel').in('legacy_id', codigosClientes))
    : []
  const clientePorCodigo = new Map(clientesErp.map((c) => [String(c.legacy_id).trim(), c]))

  // Agrupa por cliente (codigo_cliente) — a fila é por CLIENTE, não por
  // título; um cliente pode ter vários títulos em aberto.
  const porCliente = new Map()
  for (const conta of contas) {
    if (!conta.codigo_cliente || !codigosQueQualificam.has(conta.codigo_cliente)) continue
    if (!porCliente.has(conta.codigo_cliente)) porCliente.set(conta.codigo_cliente, [])
    porCliente.get(conta.codigo_cliente).push(conta)
  }

  const itens = []
  for (const [codigo, contasDoCliente] of porCliente.entries()) {
    const cliente = clientePorCodigo.get(codigo)
    const contatos = Array.isArray(cliente?.contatos) ? cliente.contatos : []

    const telefoneAtualRaw = contasDoCliente[0]?.telefone_cobranca ?? null
    const digitosAtual = normalizarTelefone(telefoneAtualRaw)

    let ultimaFalhaEm = null, telefoneQueFalhou = null, falhasTotal = 0, falhas30d = 0
    for (const conta of contasDoCliente) {
      const acc = falhasPorConta.get(conta.id)
      if (!acc) continue
      falhasTotal += acc.total
      falhas30d += acc.ultimos30d
      if (!ultimaFalhaEm || acc.ultimaFalhaEm > ultimaFalhaEm) {
        ultimaFalhaEm = acc.ultimaFalhaEm
        telefoneQueFalhou = acc.telefoneMaisRecente
      }
    }
    const digitosQueFalhou = normalizarTelefone(telefoneQueFalhou)

    let status
    if (!digitosQueFalhou || digitosAtual === digitosQueFalhou) {
      status = 'pendente'
    } else if (!dncPorDigitos.has(digitosAtual)) {
      status = 'resolvido_automaticamente'
    } else {
      status = 'possivelmente_corrigido'
    }

    const dncAtual = digitosAtual ? dncPorDigitos.get(digitosAtual) : null
    const quarentenaAtiva = Boolean(dncAtual?.expira_em && new Date(dncAtual.expira_em).getTime() > agora)

    const contatoAtual = contatos.find((c) => normalizarTelefone(c?.valor) === digitosAtual)
    const tipoContatoAtual = contatoAtual ? String(contatoAtual.tipo || '').trim().toLowerCase() || null : null

    const outrosContatosValidos = contatos.filter((c) => {
      const d = normalizarTelefone(c?.valor)
      return d && d !== digitosAtual
    })
    const celularAlternativoExiste = outrosContatosValidos.some((c) => String(c?.tipo || '').trim().toLowerCase() === 'celular')

    const valorEmAberto = contasDoCliente.reduce((soma, c) => soma + (Number(c.valor || 0) - Number(c.valor_pago || 0)), 0)
    const vencimentoMaisAntigo = contasDoCliente.reduce((min, c) => (!min || c.vencimento < min ? c.vencimento : min), null)
    const diasAtraso = vencimentoMaisAntigo ? Math.floor((agora - new Date(`${vencimentoMaisAntigo}T00:00:00-03:00`).getTime()) / 86400000) : 0

    itens.push({
      codigo_cliente: codigo,
      nome: cliente?.razao_social || cliente?.nome_fantasia || contasDoCliente[0]?.pessoa_nome || null,
      telefone_cobranca_atual: telefoneAtualRaw,
      tipo_contato_atual: tipoContatoAtual,
      ultima_falha_em: ultimaFalhaEm,
      falhas_30_dias: falhas30d,
      falhas_total: falhasTotal,
      quarentena_expira_em: dncAtual?.expira_em ?? null,
      quarentena_ativa: quarentenaAtiva,
      titulos_em_aberto: contasDoCliente.length,
      valor_em_aberto: Math.round(valorEmAberto * 100) / 100,
      vencimento_mais_antigo: vencimentoMaisAntigo,
      dias_atraso: Math.max(0, diasAtraso),
      outro_contato_existe: outrosContatosValidos.length > 0,
      celular_alternativo_existe: celularAlternativoExiste,
      vendedor_responsavel: cliente?.vendedor_responsavel ?? null,
      status,
    })
  }

  return itens
}

function ordenar(itens, criterio) {
  const chaves = {
    valor: (i) => i.valor_em_aberto,
    atraso: (i) => i.dias_atraso,
    reincidencia: (i) => i.falhas_30_dias,
    data: (i) => (i.ultima_falha_em ? new Date(i.ultima_falha_em).getTime() : 0),
  }
  const principal = chaves[criterio] || chaves.valor
  // Prioridade padrão do pedido: valor > atraso > reincidência > data da
  // última falha — critério explícito só reordena a chave PRINCIPAL, as
  // demais continuam como desempate, na mesma ordem.
  const ordem = [principal, chaves.atraso, chaves.reincidencia, chaves.data].filter((f, idx, arr) => arr.indexOf(f) === idx)
  return [...itens].sort((a, b) => {
    for (const chave of ordem) {
      const diff = chave(b) - chave(a)
      if (diff !== 0) return diff
    }
    return 0
  })
}

router.get('/', async (req, res) => {
  try {
    const todos = await montarDados()

    const resumo = {
      clientes_pendentes: todos.filter((i) => i.status === 'pendente').length,
      valor_em_aberto_pendentes: Math.round(todos.filter((i) => i.status === 'pendente').reduce((s, i) => s + i.valor_em_aberto, 0) * 100) / 100,
      possivelmente_corrigidos: todos.filter((i) => i.status === 'possivelmente_corrigido').length,
      resolvidos_automaticamente: todos.filter((i) => i.status === 'resolvido_automaticamente').length,
      sem_alternativa: todos.filter((i) => i.status === 'pendente' && !i.celular_alternativo_existe).length,
      com_alternativa: todos.filter((i) => i.status === 'pendente' && i.celular_alternativo_existe).length,
      quarentena_ativa: todos.filter((i) => i.quarentena_ativa).length,
    }

    let filtrados = todos
    const { status, alternativa, quarentena } = req.query
    if (status && status !== 'todos') filtrados = filtrados.filter((i) => i.status === status)
    if (alternativa === 'com') filtrados = filtrados.filter((i) => i.celular_alternativo_existe)
    else if (alternativa === 'sem') filtrados = filtrados.filter((i) => !i.celular_alternativo_existe)
    if (quarentena === 'ativa') filtrados = filtrados.filter((i) => i.quarentena_ativa)
    else if (quarentena === 'expirada') filtrados = filtrados.filter((i) => !i.quarentena_ativa)

    filtrados = ordenar(filtrados, req.query.ordenar)

    const pagina = Math.max(1, Number(req.query.pagina) || 1)
    const tamanhoPagina = Math.min(Number(req.query.tamanho_pagina) || 25, 100)
    const inicio = (pagina - 1) * tamanhoPagina
    const paginaAtual = filtrados.slice(inicio, inicio + tamanhoPagina)

    res.json({
      resumo,
      itens: paginaAtual,
      paginacao: {
        pagina,
        tamanho_pagina: tamanhoPagina,
        total_itens: filtrados.length,
        total_paginas: Math.max(1, Math.ceil(filtrados.length / tamanhoPagina)),
      },
    })
  } catch (err) {
    // Nunca loga telefone/nome de cliente — só a mensagem de erro técnica.
    res.status(500).json({ erro: err.message })
  }
})

export default router
