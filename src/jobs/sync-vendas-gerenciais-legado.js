/**
 * Sincronização do read-model GERENCIAL de vendas (NetVision `EN_NotasRepres`
 * → Vivenzza `vendas_gerenciais_netvision`).
 *
 * EN_NotasRepres é a fonte REAL do relatório oficial NetVision "Consulta
 * Vendas por Representante" — comprovado por reconciliação exata (bateu
 * Ana/Diego/Nicole/Tais e o total geral até o centavo, ver
 * VENDAS_DO_MES_RECONCILIACAO.md). NÃO é EN_Notas (que
 * notas_fiscais_netvision já espelha, domínio fiscal) nem ES_Pedidos —
 * são fontes estruturalmente diferentes que não reconciliam entre si.
 *
 * ESPELHO, NUNCA EMISSÃO. Este job:
 *   - NUNCA chama SEFAZ, NUNCA emite/cancela NF;
 *   - NUNCA escreve em `pedidos`, `contas_financeiras`, `nfe` ou
 *     `notas_fiscais_netvision` (domínio fiscal, intocado);
 *   - só espelha o que já existe no NetVision, pra alimentar o indicador
 *     GERENCIAL "Vendas do Mês" (vendas_gerenciais_mes no dashboard).
 *
 * Série 99 SEMPRE incluída, sem exceção — é exatamente o que o NetVision já
 * faz nesta tabela (comprovado: R$17.264,88 de Série 99 estava dentro do
 * total reconciliado). Nenhuma lógica de exclusão de série existe aqui de
 * propósito.
 *
 * Idempotente por `legacy_id` ("{CodigoFilial}-{RepresentanteCodigo}-{Serie}-
 * {NumeroDocumento}") — testado empiricamente contra as 8.202 linhas
 * históricas de EN_NotasRepres em produção: ZERO colisões com essa
 * combinação de 4 colunas (ver comentário na migration
 * 20260101000043_vendas_gerenciais_netvision.sql pro racional completo).
 * Upsert, nunca duplica. Varredura completa por padrão (não incremental).
 *
 * RECONCILIAÇÃO (achado real, 14/09/2026): até esta correção o job só
 * criava/atualizava — nunca removia uma linha que sumiu da origem dentro do
 * período já lido (cancelamento/estorno/correção no NetVision). O espelho
 * só crescia, nunca encolhia, e o indicador GERENCIAL ficava
 * permanentemente "vazado" com órfãos (divergência real observada: 24
 * vendas/R$37.179,77 no NetVision x 26 vendas/R$50.476,67 no CRM, filial
 * 001, mês corrente — exatamente 2 órfãos). A remoção abaixo:
 *   - só considera candidato um `legacy_id` que existe no espelho DENTRO do
 *     escopo exato filial+período já lido nesta execução e que NÃO veio na
 *     leitura atual da origem (a origem manda, sempre);
 *   - só roda depois que a leitura completa da origem terminou sem erro
 *     (está dentro do mesmo `try`, após `pool.query` de EN_NotasRepres ter
 *     retornado — se a query falhar, o `catch` já intercepta antes de
 *     chegar aqui, e a exclusão nunca acontece);
 *   - nunca dispara sobre leitura vazia da origem (`total_lido === 0`) —
 *     tratado sempre como leitura suspeita, nunca como "zero vendas real",
 *     mesma convenção fail-safe do resto do domínio fiscal/gerencial;
 *   - tem um segundo freio de sanidade (percentual dos candidatos sobre o
 *     total já espelhado no escopo) pra nunca apagar em massa por causa de
 *     uma leitura parcial/truncada que "parecesse" bem-sucedida;
 *   - o DELETE em si repete o filtro filial+período (defesa em profundidade
 *     — mesmo que o cálculo em memória tivesse um bug, a query no Postgres
 *     não alcança linha fora do escopo);
 *   - é idempotente: depois de remover um órfão, a próxima execução não o
 *     encontra mais no espelho, então não há efeito colateral repetido.
 *
 * DATA_EMISSAO NULA (auditoria 14/09/2026, hipótese "SEM REPRESENTANTE"
 * investigada e NÃO confirmada como causa de divergência monetária ativa):
 * a hipótese original era que linhas SEM REPRESENTANTE seriam excluídas por
 * tratamento implícito de NULL em "DataEmissao". Confirmado por consulta
 * read-only e sanitizada à origem (filial 001): (a) NÃO existe, hoje, nenhuma
 * linha com `Representante` em branco em EN_NotasRepres — o campo é NOT NULL
 * e sempre populado com um código válido presente em EN_Representantes;
 * (b) EN_NotasRepres e EN_RepresMensal (tabela pré-agregada mensal,
 * independente) concordam exatamente — R$36.931,67/24 documentos, filial 001,
 * setembro/2026 — zero divergência, zero linha "sem representante" em
 * nenhuma das duas fontes; (c) EXISTEM 224 linhas históricas (filial 001,
 * 2019–2020, `ValorDocumento = 0,00`) com `DataEmissao IS NULL` — mas nenhuma
 * tem valor monetário, então não explicam divergência nenhuma hoje.
 *
 * Apesar de a hipótese específica não se confirmar, o padrão de código em si
 * é um defeito latente real: `"DataEmissao" >= $2 AND "DataEmissao" <= $3`
 * exclui qualquer linha com `DataEmissao IS NULL` por lógica trivalorada do
 * SQL (NULL nunca satisfaz uma comparação `>=`/`<=`), SEM NENHUM log ou
 * sinal — se o NetVision um dia emitir um documento REAL (valor != 0) sem
 * `DataEmissao`, ele desapareceria de "Vendas do Mês" pra sempre, em
 * silêncio (já aconteceu 224 vezes no passado, sempre com valor zero, mas
 * nada impede que aconteça de novo com valor real). A correção abaixo:
 *   - torna o filtro de `DataEmissao IS NOT NULL` EXPLÍCITO na query (mesmo
 *     comportamento de hoje, mas autodocumentado, não mais implícito);
 *   - adiciona uma checagem read-only companion (mesmo pool, mesma
 *     transação lógica) que conta/soma linhas com `DataEmissao IS NULL` no
 *     escopo da filial — sem filtro de período, porque essas linhas nunca
 *     têm um período válido por definição — e gera um aviso sanitizado
 *     (quantidade + valor total + amostra doc/série, nunca nome/código de
 *     representante) sempre que existir alguma com valor != 0;
 *   - NUNCA fabrica uma data pra essas linhas nem as inclui no espelho —
 *     fazer isso seria inventar dado que a origem não fornece. O objetivo é
 *     só visibilidade (log claro) pra decisão manual, nunca inclusão forçada;
 *   - linhas com `Representante` em branco MAS `DataEmissao` válida (não
 *     observadas na produção atual, mas permitidas pelo schema) já eram e
 *     continuam sendo incluídas normalmente — nenhuma lógica de
 *     representante jamais excluiu uma linha aqui, testado explicitamente.
 */
import pg from 'pg'
import { supabase } from '../lib/supabase-admin.server.js'
import { configE01 } from '../lib/e01Host.js'

async function conectarE01() {
  return new pg.Pool({
    ...(await configE01({ max: 2 })),
  })
}

function montarVenda(row, mapaRepresentantes) {
  const filial = (row.CodigoFilial || '').trim()
  const repCodigo = (row.Representante || '').trim()
  const serie = (row.Serie || '').trim()
  return {
    legacy_id: `${filial}-${repCodigo}-${serie || '_'}-${row.NumeroDocumento}`,
    codigo_filial: filial,
    representante_codigo: repCodigo,
    representante_nome: mapaRepresentantes.get(repCodigo) ?? null,
    numero_documento: Number(row.NumeroDocumento),
    serie,
    data_emissao: row.DataEmissao ? new Date(row.DataEmissao).toISOString().slice(0, 10) : null,
    valor_documento: Number(row.ValorDocumento || 0),
    pagamento_a_vista: Number(row.PagamentoAVista) === 1,
    condicao_pagamento: row.CondicaoPagamento ? String(row.CondicaoPagamento).trim() : null,
    numero_titulo: row.NumeroTitulo != null ? Number(row.NumeroTitulo) : null,
    nro_registro: row.NroRegistro != null ? Number(row.NroRegistro) : null,
    emitente: row.Emitente ? String(row.Emitente).trim() : null,
    codigo_pdv: row.CodigoPDV != null ? String(row.CodigoPDV).trim() : null,
    status_representante: row.StatusRepresentante != null ? Number(row.StatusRepresentante) : null,
    atualizado_em: new Date().toISOString(),
    metadata: row,
  }
}

// Freios de sanidade da reconciliação — nunca aplicar remoção em massa só
// porque o cálculo "parece" consistente. `MIN_ABS`: abaixo desse número de
// candidatos, o percentual nem é avaliado (a divergência real que motivou
// isto foi 2 candidatos — nunca queremos bloquear um caso desses por
// percentual). `MAX_PCT`: acima do mínimo absoluto, se os candidatos forem
// mais que essa fração do que já está espelhado no escopo, a reconciliação
// inteira é bloqueada (nenhuma linha removida) e fica só registrada pra
// revisão manual — sintoma típico de leitura parcial/truncada da origem
// disfarçada de sucesso.
function lerLimiarReconciliacao(nomeEnv, padrao) {
  const valor = Number(process.env[nomeEnv])
  return Number.isFinite(valor) && valor >= 0 ? valor : padrao
}

/**
 * `dryRun: true` (padrão) só reporta o que seria criado/atualizado/removido,
 * nenhuma escrita — inclusive no log de sincronização, que só registra
 * execuções reais (dry_run nunca conta pro indicador de frescor em
 * vendaGerencialSyncStatus.js, mesma convenção do fiscal/financeiro).
 * Filtro obrigatório `filial` (default '001') e opcional `desde`/`ate`
 * (default: mês corrente) — varredura completa não faz sentido pra uma
 * tabela com anos de histórico (8.202+ linhas e crescendo); o dashboard só
 * precisa do mês corrente, então o sync varre só a janela relevante.
 *
 * `reconciliar: true` (padrão) liga a remoção de órfãos descrita no
 * docstring do módulo — pode ser desligada por chamada (nunca via Task
 * Scheduler, que sempre roda com o default) pra investigação pontual sem
 * tocar o resto do sync.
 */
export async function executarSincronizacaoVendasGerenciais({
  dryRun = true, filial = '001', desde = null, ate = null, poolE01 = null, log = console.log,
  reconciliar = true,
} = {}) {
  const pool = poolE01 ?? await conectarE01()
  const contadores = { total_lido: 0, total_criado: 0, total_atualizado: 0, total_removido: 0, total_com_erro: 0 }
  const erros = []
  const avisos = []

  const limiarMinAbsoluto = lerLimiarReconciliacao('VENDAS_GERENCIAIS_RECONCILIACAO_MIN_ABS', 5)
  const limiarMaxPercentual = lerLimiarReconciliacao('VENDAS_GERENCIAIS_RECONCILIACAO_MAX_PCT', 0.5)

  const agora = new Date()
  const desdeReal = desde ?? new Date(agora.getFullYear(), agora.getMonth(), 1).toISOString().slice(0, 10)
  const ateReal = ate ?? new Date(agora.getFullYear(), agora.getMonth() + 1, 0).toISOString().slice(0, 10)

  let syncLogId = null
  if (!dryRun) {
    const { data, error } = await supabase
      .from('sincronizacoes_vendas_gerenciais')
      .insert({ status: 'executando', dry_run: false, host_origem: process.env.HOSTNAME || process.env.COMPUTERNAME || null })
      .select('id')
      .single()
    if (error) log(`[sync-vendas-gerenciais-legado] aviso: não registrou início do sync em sincronizacoes_vendas_gerenciais: ${error.message}`)
    else syncLogId = data.id
  }

  try {
    const { rows } = await pool.query(
      `SELECT "CodigoFilial","Representante","DataEmissao","NumeroDocumento","Serie","ValorDocumento",
              "PagamentoAVista","CondicaoPagamento","NumeroTitulo","NroRegistro","Emitente","CodigoPDV",
              "StatusRepresentante"
       FROM "EN_NotasRepres"
       WHERE "CodigoFilial" = $1 AND "DataEmissao" >= $2 AND "DataEmissao" <= $3 AND "DataEmissao" IS NOT NULL`,
      [filial, desdeReal, ateReal]
    )
    contadores.total_lido = rows.length

    // Checagem companion read-only (ver docstring do módulo, seção "DATA_EMISSAO
    // NULA"): `DataEmissao IS NULL` nunca satisfaz o filtro de período acima —
    // essas linhas não têm data válida, então NENHUMA janela as alcançaria,
    // não só a desta execução. Sem filtro de período de propósito. Isso é só
    // visibilidade (nunca inclusão forçada — jamais fabricamos uma data pra
    // uma linha que a origem não forneceu).
    const { rows: semDataEmissao } = await pool.query(
      `SELECT COUNT(*) AS quantidade, COALESCE(SUM("ValorDocumento"), 0) AS valor_total,
              -- COUNT(*) FILTER nao existe neste NetVision (Postgres antigo) e
              -- derrubava o sync inteiro com "erro de sintaxe em ou proximo a (".
              -- COUNT(CASE WHEN ...) e equivalente e portavel.
              COUNT(CASE WHEN "ValorDocumento" <> 0 THEN 1 END) AS quantidade_valor_nao_zero
       FROM "EN_NotasRepres"
       WHERE "CodigoFilial" = $1 AND "DataEmissao" IS NULL`,
      [filial]
    )
    const qtdSemDataEmissao = Number(semDataEmissao[0]?.quantidade || 0)
    const valorSemDataEmissao = Number(semDataEmissao[0]?.valor_total || 0)
    // Gatilho por CONTAGEM de linha com valor individual != 0, nunca pela
    // SOMA líquida (achado da revisão adversarial desta PR, 14/09/2026): um
    // estorno/correção com ValorDocumento negativo poderia compensar
    // exatamente uma linha positiva e zerar a soma total, mascarando as
    // duas linhas reais atrás de um `valor_total = 0` que pareceria seguro.
    // `valor_total` continua reportado no aviso (contexto), mas nunca decide
    // se o aviso dispara.
    const qtdComValorNaoZero = Number(semDataEmissao[0]?.quantidade_valor_nao_zero || 0)
    // Só gera aviso quando há valor monetário real em jogo — a auditoria de
    // 14/09/2026 confirmou 224 linhas históricas (filial 001, 2019-2020)
    // com DataEmissao NULL e valor SEMPRE zero, permanentes e já conhecidas
    // (ver AUDITORIA_SEM_REPRESENTANTE_DATA_EMISSAO_NULA_20260914.md).
    // Alertar sobre elas a cada ciclo (30 min, indefinidamente) seria ruído
    // puro pra uma condição inofensiva e já documentada — o objetivo aqui é
    // sinalizar o dia em que isso passar a acontecer com valor != 0, nunca
    // repetir pra sempre um achado histórico sem impacto.
    if (qtdComValorNaoZero > 0) {
      avisos.push({ tipo: 'data_emissao_nula_nunca_sincronizavel', filial, quantidade: qtdSemDataEmissao, valor_total: valorSemDataEmissao })
      log(
        `[sync-vendas-gerenciais-legado] aviso: ${qtdSemDataEmissao} linha(s) em EN_NotasRepres (filial ${filial}) têm DataEmissao NULL e nunca são ` +
        `sincronizadas por nenhuma janela de período (${qtdComValorNaoZero} com valor individual != 0, valor total líquido: ${valorSemDataEmissao.toFixed(2)}) — revisão manual na origem recomendada`
      )
    }

    const { rows: representantes } = await pool.query(
      `SELECT TRIM("Representante") AS codigo, "Nome" AS nome FROM "EN_Representantes" WHERE TRIM("Representante") <> ''`
    )
    const mapaRepresentantes = new Map(representantes.map((r) => [r.codigo, r.nome]))

    const existentes = new Map()
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await supabase.from('vendas_gerenciais_netvision').select('legacy_id, valor_documento, pagamento_a_vista').range(offset, offset + 999)
      if (error) throw error
      for (const r of data) existentes.set(r.legacy_id, r)
      if (data.length < 1000) break
    }

    // Espelho JÁ existente, mas só DENTRO do escopo exato filial+período
    // desta execução — usado exclusivamente pra calcular candidatos a
    // remoção (nunca pra decidir criar/atualizar, isso continua usando o
    // mapa `existentes` acima, sem regressão de comportamento). Campos
    // mínimos de propósito: o suficiente pra auditoria sanitizada
    // (amostra_remover/logs), nunca dado pessoal de cliente (esta tabela não
    // guarda nome/CPF de cliente — só documento comercial + código/nome de
    // representante interno).
    const existentesNoEscopo = new Map()
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await supabase.from('vendas_gerenciais_netvision')
        .select('legacy_id, valor_documento, data_emissao')
        .eq('codigo_filial', filial)
        .gte('data_emissao', desdeReal).lte('data_emissao', ateReal)
        .range(offset, offset + 999)
      if (error) throw error
      for (const r of data) existentesNoEscopo.set(r.legacy_id, r)
      if (data.length < 1000) break
    }

    const paraCriar = [], paraAtualizar = []
    const idsFonte = new Set()
    for (const row of rows) {
      const venda = montarVenda(row, mapaRepresentantes)
      idsFonte.add(venda.legacy_id)
      const atual = existentes.get(venda.legacy_id)
      if (!atual) { paraCriar.push(venda); continue }
      if (Number(atual.valor_documento) !== venda.valor_documento || atual.pagamento_a_vista !== venda.pagamento_a_vista) {
        paraAtualizar.push(venda)
      }
    }

    // Órfãos: legacy_id que está espelhado dentro do escopo lido mas não
    // veio na leitura atual da origem — a origem manda, então sumiu de lá
    // (cancelamento/estorno/correção). Ver docstring do módulo.
    const paraRemover = [...existentesNoEscopo.keys()].filter((id) => !idsFonte.has(id))

    // Guardas de segurança da reconciliação — nunca remover em leitura
    // suspeita, mesmo com reconciliar=true. Ver comentário de
    // lerLimiarReconciliacao acima pro racional dos limiares.
    let motivoBloqueioReconciliacao = null
    if (!reconciliar) {
      motivoBloqueioReconciliacao = 'desligada_por_parametro'
    } else if (contadores.total_lido === 0) {
      // Leitura vazia da origem pro período nunca é motivo pra apagar o que
      // já está espelhado — tratada sempre como leitura suspeita, mesma
      // convenção fail-safe do resto do domínio (nunca "zero vendas real").
      motivoBloqueioReconciliacao = 'leitura_origem_vazia'
    } else if (paraRemover.length > limiarMinAbsoluto && existentesNoEscopo.size > 0) {
      const percentualRemocao = paraRemover.length / existentesNoEscopo.size
      if (percentualRemocao > limiarMaxPercentual) motivoBloqueioReconciliacao = 'percentual_remocao_suspeito'
    }
    const reconciliacaoAplicada = paraRemover.length > 0 && !motivoBloqueioReconciliacao
    if (motivoBloqueioReconciliacao && paraRemover.length > 0) {
      avisos.push({ tipo: 'reconciliacao_bloqueada', motivo: motivoBloqueioReconciliacao, candidatos: paraRemover.length, escopo_total: existentesNoEscopo.size })
      log(`[sync-vendas-gerenciais-legado] reconciliação bloqueada (${motivoBloqueioReconciliacao}) — ${paraRemover.length} candidato(s) a remoção NÃO removidos, revisão manual necessária`)
    }

    if (dryRun) {
      contadores.total_criado = paraCriar.length
      contadores.total_atualizado = paraAtualizar.length
      contadores.total_removido = reconciliacaoAplicada ? paraRemover.length : 0
      return {
        ...contadores, dry_run: true, periodo: { desde: desdeReal, ate: ateReal },
        amostra_criar: paraCriar.slice(0, 10), amostra_atualizar: paraAtualizar.slice(0, 10),
        amostra_remover: paraRemover.slice(0, 10).map((id) => ({ legacy_id: id, valor_documento: existentesNoEscopo.get(id)?.valor_documento ?? null, data_emissao: existentesNoEscopo.get(id)?.data_emissao ?? null })),
        reconciliacao: { aplicada: reconciliacaoAplicada, motivo_bloqueio: motivoBloqueioReconciliacao, candidatos: paraRemover.length, escopo_total: existentesNoEscopo.size },
        avisos,
      }
    }

    for (let i = 0; i < paraCriar.length; i += 500) {
      const lote = paraCriar.slice(i, i + 500)
      const { error } = await supabase.from('vendas_gerenciais_netvision').upsert(lote, { onConflict: 'legacy_id', ignoreDuplicates: true })
      if (error) { contadores.total_com_erro += lote.length; erros.push({ mensagem: error.message, primeiro: lote[0]?.legacy_id }); log(`[sync-vendas-gerenciais-legado] erro criar lote ${lote[0]?.legacy_id}: ${error.message}`) }
      else contadores.total_criado += lote.length
    }
    for (const venda of paraAtualizar) {
      const { error } = await supabase.from('vendas_gerenciais_netvision').update(venda).eq('legacy_id', venda.legacy_id)
      if (error) { contadores.total_com_erro++; erros.push({ mensagem: error.message, primeiro: venda.legacy_id }) }
      else contadores.total_atualizado++
    }

    // Remoção de órfãos — só se a reconciliação passou nos dois freios acima
    // (reconciliar=true, leitura não-vazia, percentual dentro do limiar). O
    // filtro filial+período é repetido aqui no próprio DELETE como defesa em
    // profundidade: mesmo que `paraRemover` tivesse um bug de cálculo, a
    // query no Postgres não alcança linha fora do escopo desta execução.
    if (reconciliacaoAplicada) {
      for (let i = 0; i < paraRemover.length; i += 500) {
        const lote = paraRemover.slice(i, i + 500)
        const { data, error } = await supabase.from('vendas_gerenciais_netvision')
          .delete()
          .eq('codigo_filial', filial)
          .gte('data_emissao', desdeReal).lte('data_emissao', ateReal)
          .in('legacy_id', lote)
          .select('legacy_id')
        if (error) { contadores.total_com_erro += lote.length; erros.push({ mensagem: error.message, primeiro: lote[0] }); log(`[sync-vendas-gerenciais-legado] erro remover lote (primeiro ${lote[0]}): ${error.message}`) }
        else contadores.total_removido += data?.length ?? lote.length
      }
    }

    if (syncLogId) {
      const { error: erroFinalizacao } = await supabase.from('sincronizacoes_vendas_gerenciais').update({
        status: contadores.total_com_erro > 0 ? 'concluido_com_erros' : 'concluido',
        concluido_em: new Date().toISOString(),
        total_lido: contadores.total_lido,
        total_criado: contadores.total_criado,
        total_atualizado: contadores.total_atualizado,
        total_com_erro: contadores.total_com_erro,
        total_removido: contadores.total_removido,
        reconciliacao_candidatos: paraRemover.length,
        reconciliacao_motivo_bloqueio: motivoBloqueioReconciliacao,
      }).eq('id', syncLogId)
      // Sem checar `error` aqui, uma falha nesta escrita (coluna ausente,
      // cache de schema do PostgREST desatualizado, etc.) fica em silêncio:
      // o registro nunca sai de 'executando', mesmo com o sync tendo
      // funcionado — mesma classe de defeito já corrigida na PR #74
      // (registrarMensagemSaida). Loga alto (não deixa passar batido) mas
      // não derruba o processo: o sync em si já terminou com sucesso.
      if (erroFinalizacao) {
        log(`[sync-vendas-gerenciais-legado] ERRO ao finalizar registro de sincronização (id=${syncLogId}): ${erroFinalizacao.message} — o sync rodou e os dados foram gravados, mas o status em sincronizacoes_vendas_gerenciais pode ficar preso em 'executando'.`)
      }
    }

    return {
      ...contadores, dry_run: false, periodo: { desde: desdeReal, ate: ateReal }, erros, avisos,
      reconciliacao: { aplicada: reconciliacaoAplicada, motivo_bloqueio: motivoBloqueioReconciliacao, candidatos: paraRemover.length, escopo_total: existentesNoEscopo.size },
    }
  } catch (err) {
    if (syncLogId) {
      const { error: erroFinalizacaoFalha } = await supabase.from('sincronizacoes_vendas_gerenciais').update({
        status: 'falhou', concluido_em: new Date().toISOString(), mensagem_erro: err.message,
      }).eq('id', syncLogId)
      if (erroFinalizacaoFalha) {
        log(`[sync-vendas-gerenciais-legado] ERRO ao registrar falha do sync (id=${syncLogId}): ${erroFinalizacaoFalha.message} — erro original do sync: ${err.message}`)
      }
    }
    throw err
  } finally {
    if (!poolE01) await pool.end()
  }
}
