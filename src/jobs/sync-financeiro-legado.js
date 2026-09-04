/**
 * Sincronização financeira: NetVision (e01, tabela CR_Duplicatas) → CRM
 * (contas_financeiras / baixas_financeiras).
 *
 * POR QUE ISSO EXISTE
 * -------------------
 * Até 13/08/2026 não havia NENHUMA sincronização financeira entre os dois
 * sistemas — só de pedidos (sync-pedidos-legado.js). O financeiro dava baixa no
 * NetVision, o CRM nunca ficava sabendo, e a régua de cobrança seguia mandando
 * WhatsApp pra cliente que já tinha pago. Este job fecha esse buraco.
 *
 * ONDE RODA
 * ---------
 * O e01 só é alcançável da rede local do escritório (mesma limitação do sync de
 * pedidos — ver nota no src/index.js). Portanto este job NÃO roda no Railway:
 * roda na máquina com acesso ao NetVision, via
 * `node scripts/sync-financeiro-legado.mjs`, agendado no Task Scheduler.
 * A API na nuvem só LÊ o resultado (tabela sincronizacoes_financeiro) pra
 * decidir se pode cobrar — ver a guarda de frescor em cobranca-whatsapp.js.
 *
 * GARANTIAS
 * ---------
 * - Idempotente: rodar 10x seguidas produz o mesmo estado (a RPC só cresce baixa).
 * - Nunca reverte pagamento: ERP dizendo "menos pago" que o CRM vira conflito
 *   sinalizado, não estorno automático.
 * - Nunca duplica dinheiro: baixa manual já lançada no CRM é descontada do que
 *   o sync espelha (lógica em fn_sincronizar_baixa_legado).
 * - Dry-run real: `{ dryRun: true }` não escreve uma linha, mas produz o mesmo
 *   relatório — dá pra conferir antes de soltar em produção.
 */
import pg from 'pg'
import { supabase } from '../lib/supabase-admin.server.js'
import {
  detectarColunas, normalizarLinhaLegado, decidirAtualizacao, chavesLegado, dataISO,
} from '../lib/financeiroLegado.js'

const TABELA_LEGADO = 'CR_Duplicatas'
const PAGE_SUPABASE = 1000
const CONCORRENCIA = 8

// Folga na leitura incremental: relógio do servidor do NetVision e do Supabase
// podem estar alguns minutos fora de sincronia, e uma baixa gravada no exato
// instante do corte ficaria de fora pra sempre. Mesma proteção do sync de
// pedidos.
const JANELA_SEGURANCA_MS = 10 * 60 * 1000

// Trava de reentrância — o agendador pode disparar de novo enquanto a execução
// anterior ainda está no meio (17k títulos levam alguns minutos).
let emExecucao = false

// CORREÇÃO 2026-09-03 (Fase 2B — auditoria de drift de migrations) — achado
// real: os dois `UPDATE`s finais em sincronizacoes_financeiro (conclusão e
// fallback de falha) espalhavam `{ error }` sem checar o retorno. Quando a
// migration 20260101000044 (total_telefone_atualizado) ainda não tinha sido
// aplicada em produção, o UPDATE de conclusão falhava com 42703 e ninguém
// percebia: a função retornava como se tivesse dado certo, logava "concluído"
// e a linha ficava presa em 'executando' pra sempre — nenhuma vez virou
// 'falhou' em toda a tabela. Helper pequeno e específico só pra este ponto
// (não generaliza pra outros módulos, pedido explícito desta fase).
async function atualizarRegistroSincronizacao(syncId, campos) {
  return supabase.from('sincronizacoes_financeiro').update(campos).eq('id', syncId)
}

async function conectarE01() {
  const pool = new pg.Pool({
    host: process.env.E01_HOST, port: process.env.E01_PORT, user: process.env.E01_USER,
    password: process.env.E01_PASSWORD, database: process.env.E01_DATABASE,
    connectionTimeoutMillis: 8000, max: 4,
  })
  try {
    await pool.query('SELECT 1')
  } catch (err) {
    await pool.end().catch(() => {})
    throw new Error(
      'Não foi possível conectar ao banco legado (e01). Este job só roda na máquina da rede local ' +
      'do servidor NetVision — não funciona no Railway. Detalhe: ' + err.message
    )
  }
  return pool
}

async function lerColunasLegado(pool) {
  const { rows } = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = $1 ORDER BY ordinal_position`,
    [TABELA_LEGADO]
  )
  if (!rows.length) {
    throw new Error(`Tabela "${TABELA_LEGADO}" não encontrada no banco ${process.env.E01_DATABASE}.`)
  }
  return rows.map((r) => r.column_name)
}

async function lerContasDoCrm() {
  const porChave = new Map()
  for (let offset = 0; ; offset += PAGE_SUPABASE) {
    const { data, error } = await supabase
      .from('contas_financeiras')
      .select('id, legacy_id, valor, valor_pago, valor_pago_legado, status, vencimento, pessoa_nome, codigo_cliente, telefone_cobranca')
      .eq('tipo', 'receber')
      .not('legacy_id', 'is', null)
      .range(offset, offset + PAGE_SUPABASE - 1)
    if (error) throw error
    for (const c of data) porChave.set(c.legacy_id, c)
    if (data.length < PAGE_SUPABASE) break
  }
  return porChave
}

/**
 * Cadastro de clientes por código do ERP — usado pra dar nome e telefone aos
 * títulos criados a partir do NetVision. A chave (codigo_cliente =
 * clientes_erp.legacy_id) é a mesma já validada em produção.
 */
async function lerClientesErp() {
  const porCodigo = new Map()
  for (let offset = 0; ; offset += PAGE_SUPABASE) {
    const { data, error } = await supabase
      .from('clientes_erp')
      .select('legacy_id, razao_social, nome_fantasia, contatos')
      .range(offset, offset + PAGE_SUPABASE - 1)
    if (error) throw error
    for (const c of data) porCodigo.set(String(c.legacy_id).trim(), c)
    if (data.length < PAGE_SUPABASE) break
  }
  return porCodigo
}

// CORREÇÃO 2026-08-27 — achado da auditoria de prioridade de telefones: a
// regra antiga pegava o 1º contato do array cujo tipo estivesse neste
// conjunto, sem prioridade real entre eles — a ORDEM do array vindo do
// NetVision decidia, não o tipo. Auditoria real (248 clientes elegíveis)
// achou 9 casos usando fixo com celular disponível no mesmo cadastro (4
// deles com número efetivamente diferente, não só categoria). Isso é
// higiene de dado, não a causa principal de PERMANENT_RECIPIENT (38/40
// clientes com essa falha não tinham NENHUMA alternativa cadastrada) — mas
// não há razão pra escolher deliberadamente um fixo quando existe celular
// no mesmo cadastro, pra um canal que é WhatsApp.
//
// PRIORIDADE_TIPO_TELEFONE: celular > fone/telefone > contato genérico.
// Dentro do MESMO grupo, preserva a primeira ocorrência do array original
// (comportamento antigo, intacto ali). Comparação de tipo é case-insensitive
// e com trim. Não inventa DDD, não infere WhatsApp, não concatena contatos —
// só decide QUAL contato existente vira telefone_cobranca.
const PRIORIDADE_TIPO_TELEFONE = [
  ['celular'],
  ['fone', 'telefone'],
  ['contato'],
]

function contatoTemValorUtilizavel(contato) {
  return typeof contato?.valor === 'string' && contato.valor.trim().length > 0
}

export function telefoneDoCliente(cliente) {
  if (!Array.isArray(cliente?.contatos)) return null
  for (const grupo of PRIORIDADE_TIPO_TELEFONE) {
    const achado = cliente.contatos.find(
      (c) => grupo.includes(String(c?.tipo || '').trim().toLowerCase()) && contatoTemValorUtilizavel(c)
    )
    if (achado) return achado.valor
  }
  return null
}

/**
 * Roda a sincronização inteira.
 * @param {object}  opts
 * @param {boolean} opts.dryRun    não escreve nada, só relata
 * @param {object}  opts.poolE01   injeta um pool já pronto (usado nos testes)
 * @param {function} opts.log      logger (default console.log)
 */
/**
 * Último ponto no tempo já sincronizado com sucesso. A leitura incremental
 * parte daí; `null` significa "nunca rodou" e força varredura completa.
 */
async function cursorDaUltimaSincronizacao() {
  const { data } = await supabase
    .from('sincronizacoes_financeiro')
    .select('cursor_final')
    .in('status', ['concluido', 'concluido_com_erros'])
    .eq('dry_run', false)
    .not('cursor_final', 'is', null)
    .order('concluido_em', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data?.cursor_final ? new Date(data.cursor_final) : null
}

/**
 * Roda a sincronização inteira.
 * @param {object}   opts
 * @param {boolean}  opts.dryRun       não escreve nada, só relata
 * @param {boolean}  opts.completo     ignora o cursor e varre a tabela toda
 * @param {object}   opts.poolE01      injeta um pool já pronto (usado nos testes)
 * @param {function} opts.log          logger (default console.log)
 */
export async function executarSincronizacaoFinanceira({ dryRun = false, completo = false, poolE01 = null, log = console.log } = {}) {
  if (emExecucao) {
    log('[sync-financeiro] execução anterior ainda em andamento — pulando este ciclo')
    return { pulado: true, motivo: 'execucao_concorrente' }
  }
  emExecucao = true

  const contadores = {
    total_lido: 0, total_atualizado: 0, total_sem_alteracao: 0,
    total_sem_match: 0, total_conflito: 0, total_cancelado: 0, total_com_erro: 0,
    // Títulos que estavam parados esperando confirmação de pagamento (cliente
    // mandou comprovante no WhatsApp) e que este ciclo confirmou como quitados.
    // Saem da lista de revisão sozinhos — ninguém precisa dar baixa a mão.
    total_revisao_resolvida: 0,
    // Encerrados no ERP sem recebimento integral (acordo/desconto). Param de
    // ser cobrados, mas o valor recebido registrado continua sendo o real —
    // vale a pena o financeiro saber quantos são.
    total_encerrado_com_saldo: 0,
    // Títulos que existiam só no NetVision e passaram a existir no CRM.
    total_criado: 0,
    // CORREÇÃO 2026-09-02 — achado de auditoria: título JÁ EXISTENTE nunca
    // tinha telefone_cobranca reatualizado por este sync (só o fn_sincronizar_
    // baixa_legado, que é só pagamento/status, e só o CAMINHO DE CRIAÇÃO usava
    // telefoneDoCliente()). Uma correção de telefone no NetVision pra um
    // cliente com títulos JÁ existentes nunca chegava na cobrança sozinha —
    // só via PATCH manual /api/financeiro/aging/telefone. Ver telefoneAtualizar abaixo.
    total_telefone_atualizado: 0,
  }
  const erros = []
  const amostraMudancas = []
  let pool = poolE01
  let poolProprio = false
  let syncId = null
  let mapa = null

  try {
    if (!pool) { pool = await conectarE01(); poolProprio = true }

    const colunas = await lerColunasLegado(pool)
    mapa = detectarColunas(colunas)
    log(`[sync-financeiro] mapeamento de colunas: ${JSON.stringify(mapa)}`)

    // Abre o registro da execução só depois de validar o schema — assim um
    // schema incompatível não polui o histórico com uma linha "falhou" a cada
    // tentativa, e a guarda de frescor da régua não é enganada.
    if (!dryRun) {
      const { data, error } = await supabase
        .from('sincronizacoes_financeiro')
        .insert({ status: 'executando', dry_run: false, mapeamento_colunas: mapa, host_origem: process.env.COMPUTERNAME || process.env.HOSTNAME || null })
        .select('id').single()
      if (error) throw error
      syncId = data.id
    }

    // ── Leitura incremental ───────────────────────────────────────────────
    // Ler os 17.725 títulos a cada ciclo inviabiliza rodar de minuto em minuto.
    // Com DataAtualizacao dá pra buscar só o que mudou — normalmente algumas
    // dezenas de linhas, o que torna o ciclo de 60s barato pros dois bancos.
    //
    // A varredura completa continua acontecendo periodicamente (ver o modo
    // --watch no CLI): se o ERP não atualizar DataAtualizacao em alguma
    // operação, o incremental sozinho perderia essa baixa pra sempre. A
    // correção não pode depender de uma coluna que não controlamos.
    const cursorAnterior = (completo || !mapa.atualizacao) ? null : await cursorDaUltimaSincronizacao()
    const desde = cursorAnterior ? new Date(cursorAnterior.getTime() - JANELA_SEGURANCA_MS) : null

    const selecionadas = [...new Set(Object.values(mapa).filter(Boolean))].map((c) => `"${c}"`).join(', ')
    const { rows: linhasLegado } = desde
      ? await pool.query(
          `SELECT ${selecionadas} FROM "${TABELA_LEGADO}" WHERE "${mapa.atualizacao}" >= $1`,
          [desde.toISOString()]
        )
      : await pool.query(`SELECT ${selecionadas} FROM "${TABELA_LEGADO}"`)

    log(
      desde
        ? `[sync-financeiro] ${linhasLegado.length} títulos alterados desde ${desde.toISOString()} (incremental)`
        : `[sync-financeiro] ${linhasLegado.length} títulos lidos do NetVision (varredura completa)`
    )

    // Avança o cursor pelo maior DataAtualizacao realmente visto, não pelo
    // relógio local — assim uma diferença de horário entre as máquinas nunca
    // pula um intervalo de alterações.
    let cursorFinal = cursorAnterior

    const contasPorChave = await lerContasDoCrm()
    log(`[sync-financeiro] ${contasPorChave.size} títulos com legacy_id no CRM`)

    // Carregado uma vez, sob demanda (evita ler clientes_erp inteiro num ciclo
    // que não precisa) — reusado tanto pela criação (aCriar) quanto pela
    // reatualização de telefone abaixo (telefoneAAtualizar).
    let clientesCache = null
    async function obterClientesErp() {
      if (!clientesCache) clientesCache = await lerClientesErp()
      return clientesCache
    }

    const aAplicar = []
    const aCriar = []
    // Map<contaId, novoTelefone> — telefone só entra aqui quando a fonte
    // (clientes_erp.contatos, mesma prioridade celular>fone/telefone>contato
    // de telefoneDoCliente()) tem um valor NÃO VAZIO e DIFERENTE do atual.
    // Nunca apaga um telefone existente quando a fonte vem vazia/sem match —
    // Map.set só é chamado quando `novo` é truthy (ver dentro do loop abaixo).
    const telefoneAAtualizar = new Map()

    for (const linha of linhasLegado) {
      contadores.total_lido++
      const legado = normalizarLinhaLegado(linha, mapa)

      if (legado.atualizacao) {
        const d = new Date(legado.atualizacao)
        if (!Number.isNaN(d.getTime()) && (!cursorFinal || d > cursorFinal)) cursorFinal = d
      }

      const chaves = chavesLegado(legado.numeroTitulo, legado.sequencia)

      // TODAS as contas que representam este título, não só a primeira. A carga
      // de 23/07 reimportou títulos que já tinham entrado em 08/07 usando outro
      // prefixo de legacy_id ("cr-1008863-4" e "001-1008863-4" são a MESMA
      // duplicata do NetVision — 48 casos confirmados em produção). Se o sync
      // atualizasse só uma das linhas, a outra continuaria em aberto e a régua
      // seguiria cobrando um título já pago — exatamente o bug que este job
      // existe pra matar.
      const contas = chaves.map((k) => contasPorChave.get(k)).filter(Boolean)

      // Título que existe no ERP e não no CRM. Antes isso só era contado e
      // seguia adiante — e a conferência de 13/08 mostrou o preço disso: 151
      // títulos (R$ 107 mil) faturados depois da carga de 23/07 simplesmente
      // não existiam no CRM. Espelho que só atualiza o que já conhece não é
      // espelho; é uma foto que envelhece.
      if (!contas.length) {
        contadores.total_sem_match++
        if (!legado.cancelado) aCriar.push(legado)
        continue
      }

      for (const conta of contas) {
        // Reatualização de telefone — independente da decisão de pagamento
        // abaixo (um título pode não ter NENHUMA mudança financeira neste
        // ciclo e ainda assim ter um telefone corrigido no NetVision). Só
        // telefone_cobranca é considerado; valor/valor_pago/status/vencimento/
        // em_revisao_financeira/baixa/promessa não são tocados aqui.
        if (conta.codigo_cliente && !telefoneAAtualizar.has(conta.id)) {
          const clientes = await obterClientesErp()
          const cliente = clientes.get(String(conta.codigo_cliente).trim())
          const novoTelefone = telefoneDoCliente(cliente)
          if (novoTelefone && novoTelefone !== conta.telefone_cobranca) {
            telefoneAAtualizar.set(conta.id, novoTelefone)
          }
        }

        let decisao
        try {
          decisao = decidirAtualizacao({ conta, legado })
        } catch (err) {
          contadores.total_com_erro++
          erros.push({ legacy_id: conta.legacy_id, mensagem: err.message })
          continue
        }

        if (decisao.acao === 'nenhuma') { contadores.total_sem_alteracao++; continue }
        if (decisao.acao === 'conflito') {
          contadores.total_conflito++
          erros.push({ legacy_id: conta.legacy_id, mensagem: `CONFLITO: ${decisao.motivo}` })
          continue
        }

        aAplicar.push({ conta, legado, decisao })
        if (amostraMudancas.length < 25) {
          amostraMudancas.push({
            legacy_id: conta.legacy_id, cliente: conta.pessoa_nome, valor: conta.valor,
            de: `${conta.status} (pago R$ ${Number(conta.valor_pago || 0).toFixed(2)})`,
            para: decisao.acao === 'cancelar' ? 'cancelada' : `${decisao.statusPrevisto} (pago R$ ${Number(decisao.valorPagoLegado).toFixed(2)})`,
            motivo: decisao.motivo,
          })
        }
      }
    }

    log(
      `[sync-financeiro] ${aAplicar.length} títulos a atualizar, ${aCriar.length} a criar` +
      (dryRun ? ' (DRY-RUN — nada será escrito)' : '')
    )

    // ── Criação dos títulos que só existem no ERP ─────────────────────────
    if (aCriar.length && !dryRun) {
      const clientes = await obterClientesErp()
      const novos = []

      for (const l of aCriar) {
        const cliente = l.codigoCliente ? clientes.get(l.codigoCliente) : null
        const valorTitulo = Number(l.valor || 0)
        const pago = Math.min(Number(l.valorPagoBruto || 0), valorTitulo)
        const saldo = valorTitulo - pago
        const venc = dataISO(l.vencimento)

        // Status derivado na criação, mesma regra da RPC. Encerrado no ERP
        // entra já como pago — nasce fora da régua, como tem que ser.
        let status
        if (l.encerrado || saldo <= 0.005) status = 'paga'
        else if (pago > 0) status = 'pago_parcial'
        else if (venc && venc < new Date().toISOString().slice(0, 10)) status = 'vencida'
        else status = 'aberta'

        novos.push({
          tipo: 'receber',
          legacy_id: `cr-${l.numeroTitulo}-${l.sequencia}`,
          descricao: `Título ${l.numeroTitulo}/${l.sequencia} — NetVision`,
          documento_ref: `${l.numeroTitulo}/${l.sequencia}`,
          codigo_cliente: l.codigoCliente ?? null,
          // Sem cadastro correspondente, guarda o código em vez de inventar um
          // nome — some no relatório é melhor que nome errado na cobrança.
          pessoa_nome: cliente?.razao_social || cliente?.nome_fantasia || `Cliente ${l.codigoCliente ?? '?'}`,
          telefone_cobranca: telefoneDoCliente(cliente),
          valor: valorTitulo,
          valor_pago: pago,
          valor_pago_legado: pago,
          vencimento: venc,
          data_pagamento: dataISO(l.dataPagamento),
          status,
          em_revisao_financeira: false,
          sincronizado_legado_em: new Date().toISOString(),
        })
      }

      for (let i = 0; i < novos.length; i += 200) {
        const lote = novos.slice(i, i + 200)
        const { error } = await supabase.from('contas_financeiras').insert(lote)
        if (error) {
          contadores.total_com_erro += lote.length
          erros.push({ legacy_id: lote[0]?.legacy_id, mensagem: `criação em lote falhou: ${error.message}` })
        } else {
          contadores.total_criado += lote.length
        }
      }
      log(`[sync-financeiro] ${contadores.total_criado} títulos novos criados a partir do NetVision`)
    } else if (aCriar.length && dryRun) {
      contadores.total_criado = aCriar.length
    }

    if (!dryRun) {
      for (let i = 0; i < aAplicar.length; i += CONCORRENCIA) {
        const lote = aAplicar.slice(i, i + CONCORRENCIA)
        await Promise.all(lote.map(async ({ conta, legado, decisao }) => {
          try {
            const { data, error } = await supabase.rpc('fn_sincronizar_baixa_legado', {
              p_conta_id: conta.id,
              p_valor_pago_legado: decisao.acao === 'cancelar' ? 0 : decisao.valorPagoLegado,
              p_data_pagamento: dataISO(legado.dataPagamento),
              p_referencia: `${TABELA_LEGADO} ${legado.numeroTitulo}/${legado.sequencia}`,
              p_cancelado_no_legado: decisao.acao === 'cancelar',
              p_encerrado_no_legado: decisao.acao !== 'cancelar' && Boolean(decisao.encerrado),
            })
            if (error) throw error
            if (decisao.acao === 'cancelar') contadores.total_cancelado++
            else contadores.total_atualizado++
            if (data?.conflito) contadores.total_conflito++
            if (data?.revisao_resolvida) contadores.total_revisao_resolvida++
            if (data?.encerrado_com_saldo) contadores.total_encerrado_com_saldo++
          } catch (err) {
            contadores.total_com_erro++
            erros.push({ legacy_id: conta.legacy_id, mensagem: err.message })
          }
        }))
        if (i % (CONCORRENCIA * 25) === 0 && i > 0) {
          log(`[sync-financeiro]   progresso: ${i}/${aAplicar.length}`)
        }
      }
    } else {
      contadores.total_atualizado = aAplicar.filter((a) => a.decisao.acao === 'atualizar').length
      contadores.total_cancelado = aAplicar.filter((a) => a.decisao.acao === 'cancelar').length
    }

    // ── Reatualização de telefone_cobranca em títulos já existentes ───────
    // UPDATE escopado por id (um título por vez, nunca por pessoa_nome como o
    // PATCH manual de aging.js) e restrito à própria coluna — nunca toca
    // valor/valor_pago/status/vencimento/em_revisao_financeira/baixa/promessa.
    // Falha aqui nunca conta como erro do título (o pagamento/status dele já
    // foi tratado acima com sucesso) — só fica registrada no log.
    if (telefoneAAtualizar.size && !dryRun) {
      const entradas = [...telefoneAAtualizar.entries()]
      for (let i = 0; i < entradas.length; i += CONCORRENCIA) {
        const lote = entradas.slice(i, i + CONCORRENCIA)
        await Promise.all(lote.map(async ([contaId, novoTelefone]) => {
          try {
            const { error } = await supabase.from('contas_financeiras').update({ telefone_cobranca: novoTelefone }).eq('id', contaId)
            if (error) throw error
            contadores.total_telefone_atualizado++
          } catch (err) {
            log(`[sync-financeiro] falha ao reatualizar telefone do título ${contaId}: ${err.message}`)
          }
        }))
      }
    } else if (telefoneAAtualizar.size && dryRun) {
      contadores.total_telefone_atualizado = telefoneAAtualizar.size
    }

    const status = contadores.total_com_erro > 0 ? 'concluido_com_erros' : 'concluido'

    if (!dryRun && syncId) {
      if (erros.length) {
        for (let i = 0; i < erros.length; i += 500) {
          const lote = erros.slice(i, i + 500)
          // Best-effort de propósito: é uma tabela auxiliar de detalhe/auditoria
          // (a decisão de negócio — atualizar/cancelar/conflito — já foi
          // aplicada com sucesso antes daqui). Uma falha aqui NUNCA pode
          // esconder a conclusão real do ciclo, mas também nunca pode ser
          // silenciosa — log explícito, sempre, com o id da sincronização pra
          // conseguir correlacionar depois.
          const { error: erroInsercaoErros } = await supabase.from('sincronizacao_financeiro_erros')
            .insert(lote.map((e) => ({ ...e, sincronizacao_id: syncId })))
          if (erroInsercaoErros) {
            log(`[sync-financeiro] AVISO: falha ao registrar ${lote.length} erro(s)/conflito(s) de detalhe em sincronizacao_financeiro_erros (sincronizacao_id=${syncId}): ${erroInsercaoErros.message}`)
          }
        }
      }

      const { error: erroConclusao } = await atualizarRegistroSincronizacao(syncId, {
        status,
        concluido_em: new Date().toISOString(),
        // Só avança o cursor quando o ciclo fechou sem erro de leitura. Um
        // ciclo com falha mantém o ponto anterior, então nada é pulado.
        cursor_final: contadores.total_com_erro === 0 && cursorFinal ? cursorFinal.toISOString() : cursorAnterior?.toISOString() ?? null,
        ...contadores,
      })
      // CORREÇÃO 2026-09-03 — nunca considerar o ciclo concluído (nem no log,
      // nem no retorno) se a PERSISTÊNCIA do status final falhar. Lançar aqui
      // (ainda dentro do try) reaproveita o mesmo catch abaixo, que tenta
      // marcar 'falhou' com um payload mínimo — sem duplicar essa lógica.
      if (erroConclusao) {
        throw new Error(`falha ao persistir conclusão da sincronização (id=${syncId}, status=${status}): ${erroConclusao.message}`)
      }
    }

    log(`[sync-financeiro] concluído: ${JSON.stringify(contadores)}`)
    return {
      ...contadores, status, dry_run: dryRun, sincronizacao_id: syncId,
      incremental: Boolean(desde), mapeamento_colunas: mapa,
      amostra: amostraMudancas, erros: erros.slice(0, 50),
    }
  } catch (err) {
    if (!dryRun && syncId) {
      // Payload MÍNIMO e estável de propósito — nunca `...contadores`. Se o
      // erro original foi causado por uma coluna nova ausente em `contadores`
      // (exatamente o que aconteceu com total_telefone_atualizado antes desta
      // correção), repetir `...contadores` aqui faria este UPDATE de
      // fallback falhar pelo MESMO motivo, e a linha nunca sairia de
      // 'executando' — justo o cenário que este hardening existe pra fechar.
      const { error: erroFallback } = await atualizarRegistroSincronizacao(syncId, {
        status: 'falhou',
        concluido_em: new Date().toISOString(),
        mensagem_erro: err.message,
      })
      if (erroFallback) {
        // Log estruturado e inequívoco: se nem o fallback conseguiu
        // persistir, a linha fica presa em 'executando' — precisa ficar
        // claro no log pra quem for investigar depois, sem depender só da
        // tabela. O erro SECUNDÁRIO (deste UPDATE) nunca substitui o erro
        // ORIGINAL — só é logado, nunca lançado no lugar dele.
        log(
          `[sync-financeiro] ERRO CRÍTICO: falha ao registrar status 'falhou' da sincronização ` +
          `(sincronizacao_id=${syncId}). A linha pode ficar presa em 'executando' indefinidamente. ` +
          `erro_original="${err.message}" erro_ao_marcar_falha="${erroFallback.message}"`
        )
      }
    }
    throw err
  } finally {
    emExecucao = false
    if (poolProprio && pool) await pool.end().catch(() => {})
  }
}
