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
//
// 2026-09-02 — camada operacional ADITIVA sobre o status derivado acima:
// collection_contact_review_actions (append-only, nunca UPDATE/DELETE)
// registra que um operador olhou o caso — nunca altera telefone_cobranca,
// nunca escreve/apaga collection_do_not_contact, nunca dispara WhatsApp.
// `status_operacional` combina os dois: resolvido_automaticamente sempre
// vence (é verdade verificada pelo sistema); senão, a última ação manual
// só conta se for MAIS RECENTE que a última falha do cliente (uma falha
// nova depois da revisão invalida a revisão — o caso volta a pendente/
// possivelmente_corrigido sozinho, sem precisar de outra ação manual pra
// "reabrir").
import { Router } from 'express'
import { supabase } from '../lib/supabase-admin.server.js'
import { normalizarTelefone } from '../lib/telefone.js'

const router = Router()
const PAGE_SUPABASE = 1000
const MOTIVO_NUMERO_INVALIDO = 'numero_invalido_whatsapp'
const TRINTA_DIAS_MS = 30 * 24 * 60 * 60 * 1000
const ACOES_VALIDAS = ['revisado', 'sem_contato_valido', 'aguardando_atualizacao_origem']
const TAMANHO_MAX_MOTIVO = 500

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

// Última ação registrada por cliente (append-only — pega só a mais recente
// por codigo_cliente via reduce em memória, nunca UPDATE/DELETE na tabela).
// Nome do operador via join manual em usuarios (mesmo padrão de
// estornos_financeiros) — nunca expõe o UUID de registrado_por na resposta.
async function buscarUltimasAcoes(codigosClientes) {
  if (!codigosClientes.length) return new Map()
  const linhas = await buscarTudoPaginado(
    supabase.from('collection_contact_review_actions').select('codigo_cliente, acao, motivo, registrado_por, registrado_em').in('codigo_cliente', codigosClientes).order('registrado_em', { ascending: false })
  )
  const idsUsuarios = [...new Set(linhas.map((l) => l.registrado_por))]
  const { data: usuarios, error } = idsUsuarios.length ? await supabase.from('usuarios').select('id, nome').in('id', idsUsuarios) : { data: [] }
  if (error) throw error
  const nomePorId = new Map((usuarios ?? []).map((u) => [u.id, u.nome]))

  const porCliente = new Map()
  for (const l of linhas) {
    if (porCliente.has(l.codigo_cliente)) continue // já tem a mais recente (linhas vêm ordenadas desc)
    porCliente.set(l.codigo_cliente, { ...l, registrado_por_nome: nomePorId.get(l.registrado_por) ?? null })
  }
  return porCliente
}

// resolvido_automaticamente sempre vence (verdade verificada pelo sistema,
// mais confiável que uma nota manual). Senão, a ação manual só é "atual" se
// for mais recente que a última falha do cliente — uma falha nova depois da
// revisão reabre o caso sozinho (nunca precisa de ação manual pra reabrir).
function calcularStatusOperacional(statusAutomatico, ultimaAcao, ultimaFalhaEm) {
  if (statusAutomatico === 'resolvido_automaticamente') return 'resolvido_automaticamente'
  const revisaoAindaValida = ultimaAcao && (!ultimaFalhaEm || new Date(ultimaAcao.registrado_em) > new Date(ultimaFalhaEm))
  if (revisaoAindaValida) return ultimaAcao.acao
  return statusAutomatico // 'pendente' | 'possivelmente_corrigido'
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
  const ultimaAcaoPorCliente = await buscarUltimasAcoes(codigosClientes)

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

    const ultimaAcao = ultimaAcaoPorCliente.get(codigo) ?? null
    const statusOperacional = calcularStatusOperacional(status, ultimaAcao, ultimaFalhaEm)

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
      status_operacional: statusOperacional,
      revisao_manual: ultimaAcao
        ? { acao: ultimaAcao.acao, motivo: ultimaAcao.motivo, registrado_por_nome: ultimaAcao.registrado_por_nome, registrado_em: ultimaAcao.registrado_em }
        : null,
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
      revisados: todos.filter((i) => i.status_operacional === 'revisado').length,
      sem_contato_valido: todos.filter((i) => i.status_operacional === 'sem_contato_valido').length,
      aguardando_atualizacao_origem: todos.filter((i) => i.status_operacional === 'aguardando_atualizacao_origem').length,
    }

    let filtrados = todos
    const { status, alternativa, quarentena } = req.query
    // Filtra por status_operacional (superset do status automático — quando
    // não há ação manual válida, status_operacional === status mesmo).
    if (status && status !== 'todos') filtrados = filtrados.filter((i) => i.status_operacional === status)
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

function validarMotivo(valor) {
  if (valor === undefined || valor === null || valor === '') return { valido: true, valorLimpo: null }
  if (typeof valor !== 'string') return { valido: false, erro: '"motivo" precisa ser texto' }
  const limpo = valor.trim()
  if (limpo.length === 0) return { valido: true, valorLimpo: null }
  if (limpo.length > TAMANHO_MAX_MOTIVO) return { valido: false, erro: `"motivo" excede o limite de ${TAMANHO_MAX_MOTIVO} caracteres` }
  if (/[<>]/.test(limpo)) return { valido: false, erro: '"motivo" não pode conter os caracteres < ou >' }
  return { valido: true, valorLimpo: limpo }
}

// POST /api/collection-contact-review/:codigoCliente/acao — registra que um
// operador revisou o caso. NUNCA altera contas_financeiras.telefone_cobranca,
// NUNCA escreve/apaga collection_do_not_contact, NUNCA dispara WhatsApp —
// só um INSERT append-only em collection_contact_review_actions (auditável:
// quem = req.user.id, quando = default now(), qual cliente = codigoCliente,
// qual ação + motivo). adminOnly (mount-level, igual ao resto do router).
router.post('/:codigoCliente/acao', async (req, res) => {
  try {
    const { codigoCliente } = req.params
    const { acao, motivo, telefone_revisado } = req.body ?? {}

    if (!ACOES_VALIDAS.includes(acao)) {
      return res.status(400).json({ erro: `"acao" precisa ser uma de: ${ACOES_VALIDAS.join(', ')}` })
    }
    const validacaoMotivo = validarMotivo(motivo)
    if (!validacaoMotivo.valido) return res.status(400).json({ erro: validacaoMotivo.erro })

    // Valida contra contas_financeiras (a mesma fonte de codigo_cliente que
    // a fila usa), não clientes_erp — a fila já tolera título sem match em
    // clientes_erp (cai no fallback pessoa_nome), então exigir clientes_erp
    // aqui seria mais restritivo que a própria fila que este botão serve.
    const { data: existe, error: erroExiste } = await supabase.from('contas_financeiras').select('id').eq('codigo_cliente', codigoCliente).limit(1).maybeSingle()
    if (erroExiste) throw erroExiste
    if (!existe) return res.status(404).json({ erro: 'Cliente não encontrado' })

    const { data, error } = await supabase
      .from('collection_contact_review_actions')
      .insert({
        codigo_cliente: codigoCliente,
        telefone_revisado: typeof telefone_revisado === 'string' ? telefone_revisado.slice(0, 40) : null,
        acao,
        motivo: validacaoMotivo.valorLimpo,
        registrado_por: req.user.id,
      })
      .select('id, acao, motivo, registrado_em')
      .single()
    if (error) throw error

    res.status(201).json({ acao: data })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

export default router
