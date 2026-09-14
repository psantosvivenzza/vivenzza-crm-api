// Investigação urgente (14/09/2026) — divergência real entre o relatório
// oficial NetVision RE_Consulta02/EN_NotasRepres e o cartão "Vendas do Mês"
// do CRM: NetVision mostrava 24 vendas/R$37.179,77 (filial 001, mês
// corrente), o CRM mostrava 26 vendas/R$50.476,67 — diferença exata de 2
// registros/R$13.296,90. Causa raiz confirmada por leitura de código (log
// local do usuário batia: sync lendo 24 linhas, zero criadas/atualizadas/
// erros): executarSincronizacaoVendasGerenciais só criava/atualizava,
// NUNCA removia do espelho `vendas_gerenciais_netvision` uma linha que
// tivesse sumido da origem (EN_NotasRepres) — cancelamento/estorno/correção
// no NetVision não se refletia nunca no espelho, que só crescia.
//
// Esta suíte prova (a) a remoção de órfão corrige exatamente esse cenário,
// (b) a remoção nunca escapa do escopo filial+período, (c) os freios de
// segurança (leitura vazia da origem, percentual suspeito de remoção,
// reconciliar=false) bloqueiam a remoção quando deveriam, sem quebrar
// criação/atualização, e (d) a remoção é idempotente.
//
// Postgres exclusivo desta suíte (nunca 5432/5433/vivenzza_dev, nunca
// produção): porta/banco definidos via LOCAL_PG_PORT/LOCAL_PG_DATABASE no
// ambiente antes de rodar (ver scripts/localdb-start.mjs/localdb-reset.mjs).
// Nenhum teste aqui toca o NetVision real (E01) — a origem é sempre um
// pool fake em memória — nem o Supabase real (LOCAL_PG_URL força o compat
// client local, mesma trava fail-closed de src/lib/supabase-admin.server.js).
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { PG_USER, PG_PASSWORD, PG_HOST, PG_PORT, PG_DATABASE } from '../localdb-config.mjs'

process.env.NODE_ENV = 'test'
process.env.LOCAL_PG_URL = `postgres://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/${PG_DATABASE}`

let supabase, executarSincronizacaoVendasGerenciais

const FILIAL = '001'
const DESDE = '2026-09-01'
const ATE = '2026-09-30'

before(async () => {
  ;({ supabase } = await import('../../src/lib/supabase-admin.server.js'))
  ;({ executarSincronizacaoVendasGerenciais } = await import('../../src/jobs/sync-vendas-gerenciais-legado.js'))
})

after(async () => {
  await supabase.from('vendas_gerenciais_netvision').delete().eq('codigo_filial', FILIAL).gte('data_emissao', DESDE).lte('data_emissao', ATE)
  await supabase.from('vendas_gerenciais_netvision').delete().eq('codigo_filial', '999')
  // sincronizacoes_vendas_gerenciais não tem uso fora desta suíte no banco
  // de teste isolado (LOCAL_PG_DATABASE dedicado) — limpa tudo sem filtro.
  await supabase.from('sincronizacoes_vendas_gerenciais').delete().gte('total_lido', 0)
})

beforeEach(async () => {
  // Isolamento entre casos — cada teste começa com o espelho vazio no
  // escopo relevante (filial 001 no período de teste + filial fake 999
  // usada pra provar que remoção nunca escapa de escopo).
  await supabase.from('vendas_gerenciais_netvision').delete().eq('codigo_filial', FILIAL).gte('data_emissao', DESDE).lte('data_emissao', ATE)
  await supabase.from('vendas_gerenciais_netvision').delete().eq('codigo_filial', '999')
})

function legacyId({ filial = FILIAL, representante = 'REP1', serie = '1', numeroDocumento }) {
  return `${filial}-${representante}-${serie || '_'}-${numeroDocumento}`
}

function linhaFonte({ filial = FILIAL, representante = 'REP1', serie = '1', numeroDocumento, valor = 100, dataEmissao = '2026-09-10', pagamentoAVista = 0 }) {
  return {
    CodigoFilial: filial, Representante: representante, DataEmissao: dataEmissao,
    NumeroDocumento: numeroDocumento, Serie: serie, ValorDocumento: valor,
    PagamentoAVista: pagamentoAVista, CondicaoPagamento: null, NumeroTitulo: null,
    NroRegistro: null, Emitente: null, CodigoPDV: null, StatusRepresentante: null,
  }
}

async function seedMirror({ filial = FILIAL, representante = 'REP1', serie = '1', numeroDocumento, valor = 100, dataEmissao = '2026-09-10', pagamentoAVista = false }) {
  const { error } = await supabase.from('vendas_gerenciais_netvision').insert({
    legacy_id: legacyId({ filial, representante, serie, numeroDocumento }),
    codigo_filial: filial, representante_codigo: representante, representante_nome: null,
    numero_documento: numeroDocumento, serie, data_emissao: dataEmissao,
    valor_documento: valor, pagamento_a_vista: pagamentoAVista,
  })
  if (error) throw new Error(`seed falhou: ${error.message}`)
}

// Pool fake do NetVision (E01) — nunca uma conexão real. `notasRepres` é a
// leitura "atual" da origem simulada por teste; `representantes` cobre o
// mapa de nomes (irrelevante pro comportamento de reconciliação, mas
// exigido pelo job). A checagem companion de "DataEmissao IS NULL"
// (auditoria 14/09/2026, ver scripts/tests/vendas-gerenciais-data-emissao-nula-20260914.test.mjs)
// é verificada ANTES do match genérico "EN_NotasRepres" — o SQL dela também
// contém essa substring — e sempre reporta zero aqui, irrelevante pro
// comportamento de reconciliação de órfãos exercitado nesta suíte.
function criarPoolFake({ notasRepres = [], falharLeitura = false }) {
  return {
    async query(sql) {
      if (sql.includes('COUNT(*) AS quantidade')) return { rows: [{ quantidade: '0', valor_total: '0' }] }
      if (sql.includes('EN_NotasRepres')) {
        if (falharLeitura) throw new Error('falha simulada de leitura da origem (E01 indisponível)')
        return { rows: notasRepres }
      }
      if (sql.includes('EN_Representantes')) return { rows: [{ codigo: 'REP1', nome: 'Representante Um' }] }
      throw new Error(`query E01 fake inesperada: ${sql}`)
    },
  }
}

async function linhasNoEscopo(filial = FILIAL) {
  const { data, error } = await supabase.from('vendas_gerenciais_netvision').select('legacy_id, valor_documento').eq('codigo_filial', filial).gte('data_emissao', DESDE).lte('data_emissao', ATE)
  if (error) throw error
  return data
}

test('regressão: cria e atualiza normalmente quando não há órfãos (comportamento preservado)', async () => {
  const poolE01 = criarPoolFake({ notasRepres: [linhaFonte({ numeroDocumento: 1, valor: 100 }), linhaFonte({ numeroDocumento: 2, valor: 200 })] })
  const r = await executarSincronizacaoVendasGerenciais({ dryRun: false, filial: FILIAL, desde: DESDE, ate: ATE, poolE01, log: () => {} })

  assert.equal(r.total_lido, 2)
  assert.equal(r.total_criado, 2)
  assert.equal(r.total_atualizado, 0)
  assert.equal(r.total_removido, 0)
  assert.equal(r.total_com_erro, 0)

  const restantes = await linhasNoEscopo()
  assert.equal(restantes.length, 2)
})

test('CENÁRIO REAL: remove exatamente o órfão que sumiu da origem, preserva o resto — reproduz e corrige a divergência de 14/09', async () => {
  // Espelho tem 3 vendas de um ciclo anterior (A, B, C). Nesta execução a
  // origem só devolve A e B — C foi cancelada/estornada no NetVision.
  await seedMirror({ numeroDocumento: 1, valor: 100 }) // A
  await seedMirror({ numeroDocumento: 2, valor: 200 }) // B
  await seedMirror({ numeroDocumento: 3, valor: 13296.90 }) // C — o órfão (valor bate com a diferença real observada)

  const poolE01 = criarPoolFake({ notasRepres: [linhaFonte({ numeroDocumento: 1, valor: 100 }), linhaFonte({ numeroDocumento: 2, valor: 200 })] })
  const r = await executarSincronizacaoVendasGerenciais({ dryRun: false, filial: FILIAL, desde: DESDE, ate: ATE, poolE01, log: () => {} })

  assert.equal(r.total_lido, 2)
  assert.equal(r.total_criado, 0)
  assert.equal(r.total_atualizado, 0)
  assert.equal(r.total_removido, 1)
  assert.equal(r.total_com_erro, 0)
  assert.equal(r.reconciliacao.aplicada, true)
  assert.equal(r.reconciliacao.motivo_bloqueio, null)

  const restantes = await linhasNoEscopo()
  assert.equal(restantes.length, 2)
  assert.deepEqual(new Set(restantes.map((x) => x.legacy_id)), new Set([legacyId({ numeroDocumento: 1 }), legacyId({ numeroDocumento: 2 })]))

  // A divergência real: soma do espelho agora bate exatamente com a soma da
  // origem lida nesta execução (antes da correção, ficava 13.296,90 a mais).
  const somaEspelho = restantes.reduce((s, x) => s + Number(x.valor_documento), 0)
  assert.equal(somaEspelho, 300)
})

test('nunca remove fora do escopo exato filial+período (outra filial e outro mês preservados)', async () => {
  await seedMirror({ numeroDocumento: 1, valor: 100 }) // dentro do escopo, some da origem (seria removida)
  await seedMirror({ filial: '999', numeroDocumento: 1, valor: 500 }) // outra filial — nunca deve ser tocada
  await seedMirror({ numeroDocumento: 2, valor: 999, dataEmissao: '2026-08-15' }) // mesma filial, mês anterior (fora do período) — nunca deve ser tocada

  const poolE01 = criarPoolFake({ notasRepres: [linhaFonte({ numeroDocumento: 99, valor: 1 })] }) // origem não devolve nenhuma das 3 seeds
  const r = await executarSincronizacaoVendasGerenciais({ dryRun: false, filial: FILIAL, desde: DESDE, ate: ATE, poolE01, log: () => {} })

  assert.equal(r.total_removido, 1) // só a linha dentro do escopo

  const { data: outraFilial } = await supabase.from('vendas_gerenciais_netvision').select('legacy_id').eq('codigo_filial', '999').eq('numero_documento', 1)
  assert.equal(outraFilial.length, 1, 'linha de outra filial nunca deveria ser removida')

  const { data: outroMes } = await supabase.from('vendas_gerenciais_netvision').select('legacy_id').eq('codigo_filial', FILIAL).eq('numero_documento', 2).eq('data_emissao', '2026-08-15')
  assert.equal(outroMes.length, 1, 'linha de outro período nunca deveria ser removida')

  await supabase.from('vendas_gerenciais_netvision').delete().eq('codigo_filial', FILIAL).eq('numero_documento', 2).eq('data_emissao', '2026-08-15')
})

test('dry-run nunca escreve, mas relata o órfão com chave sanitizada (sem dado pessoal)', async () => {
  await seedMirror({ numeroDocumento: 1, valor: 100 })
  await seedMirror({ numeroDocumento: 2, valor: 200 })
  await seedMirror({ numeroDocumento: 3, valor: 300 }) // órfão

  const poolE01 = criarPoolFake({ notasRepres: [linhaFonte({ numeroDocumento: 1, valor: 100 }), linhaFonte({ numeroDocumento: 2, valor: 200 })] })
  const r = await executarSincronizacaoVendasGerenciais({ dryRun: true, filial: FILIAL, desde: DESDE, ate: ATE, poolE01, log: () => {} })

  assert.equal(r.dry_run, true)
  assert.equal(r.total_removido, 1)
  assert.equal(r.amostra_remover.length, 1)
  assert.equal(r.amostra_remover[0].legacy_id, legacyId({ numeroDocumento: 3 }))
  // numeric(14,2) volta como string do driver pg ("300.00") — mesma
  // convenção do resto do job (Number(...) antes de comparar).
  assert.equal(Number(r.amostra_remover[0].valor_documento), 300)
  // Sanitizado: só legacy_id/valor/data — nunca nome de representante nem
  // qualquer outro campo do metadata bruto.
  assert.deepEqual(Object.keys(r.amostra_remover[0]).sort(), ['data_emissao', 'legacy_id', 'valor_documento'])

  // Nenhuma escrita real — as 3 linhas continuam no espelho.
  const restantes = await linhasNoEscopo()
  assert.equal(restantes.length, 3)
})

test('leitura vazia da origem NUNCA aciona remoção (nunca confunde "zero vendas" com falha silenciosa)', async () => {
  await seedMirror({ numeroDocumento: 1, valor: 100 })
  await seedMirror({ numeroDocumento: 2, valor: 200 })
  await seedMirror({ numeroDocumento: 3, valor: 300 })

  const poolE01 = criarPoolFake({ notasRepres: [] })
  const r = await executarSincronizacaoVendasGerenciais({ dryRun: false, filial: FILIAL, desde: DESDE, ate: ATE, poolE01, log: () => {} })

  assert.equal(r.total_lido, 0)
  assert.equal(r.total_removido, 0)
  assert.equal(r.reconciliacao.motivo_bloqueio, 'leitura_origem_vazia')
  assert.equal(r.avisos.some((a) => a.tipo === 'reconciliacao_bloqueada'), true)

  const restantes = await linhasNoEscopo()
  assert.equal(restantes.length, 3, 'nenhuma linha deveria ter sido removida com leitura vazia da origem')
})

test('freio percentual bloqueia remoção em massa (leitura parcial/truncada disfarçada de sucesso)', async () => {
  // 10 no espelho, origem só confirma 2 — 8 candidatos (80%), acima do
  // limiar padrão (50%) e do piso absoluto (5) -> bloqueia tudo.
  for (let i = 1; i <= 10; i++) await seedMirror({ numeroDocumento: i, valor: 10 })
  const poolE01 = criarPoolFake({ notasRepres: [linhaFonte({ numeroDocumento: 1, valor: 10 }), linhaFonte({ numeroDocumento: 2, valor: 10 })] })
  const r = await executarSincronizacaoVendasGerenciais({ dryRun: false, filial: FILIAL, desde: DESDE, ate: ATE, poolE01, log: () => {} })

  assert.equal(r.total_removido, 0)
  assert.equal(r.reconciliacao.motivo_bloqueio, 'percentual_remocao_suspeito')
  assert.equal(r.reconciliacao.candidatos, 8)

  const restantes = await linhasNoEscopo()
  assert.equal(restantes.length, 10, 'nenhuma linha deveria ter sido removida quando o freio percentual dispara')
})

test('abaixo do piso absoluto, remove mesmo com percentual alto (caso real: poucos órfãos nunca são bloqueados)', async () => {
  // 6 no espelho, origem confirma 2 -> 4 candidatos (66%), mas 4 não é maior
  // que o piso absoluto (5) -> percentual nem é avaliado, remove os 4.
  for (let i = 1; i <= 6; i++) await seedMirror({ numeroDocumento: i, valor: 10 })
  const poolE01 = criarPoolFake({ notasRepres: [linhaFonte({ numeroDocumento: 1, valor: 10 }), linhaFonte({ numeroDocumento: 2, valor: 10 })] })
  const r = await executarSincronizacaoVendasGerenciais({ dryRun: false, filial: FILIAL, desde: DESDE, ate: ATE, poolE01, log: () => {} })

  assert.equal(r.total_removido, 4)
  assert.equal(r.reconciliacao.motivo_bloqueio, null)

  const restantes = await linhasNoEscopo()
  assert.equal(restantes.length, 2)
})

test('reconciliar=false desliga só a remoção — criação/atualização continuam normais', async () => {
  await seedMirror({ numeroDocumento: 1, valor: 100 })
  await seedMirror({ numeroDocumento: 2, valor: 200 }) // vai virar órfão, mas não deve ser removida

  const poolE01 = criarPoolFake({ notasRepres: [linhaFonte({ numeroDocumento: 1, valor: 100 }), linhaFonte({ numeroDocumento: 3, valor: 300 })] })
  const r = await executarSincronizacaoVendasGerenciais({ dryRun: false, filial: FILIAL, desde: DESDE, ate: ATE, poolE01, reconciliar: false, log: () => {} })

  assert.equal(r.total_criado, 1) // documento 3, novo
  assert.equal(r.total_removido, 0)
  assert.equal(r.reconciliacao.motivo_bloqueio, 'desligada_por_parametro')
  assert.equal(r.reconciliacao.candidatos, 1) // calculado, mas não aplicado

  const restantes = await linhasNoEscopo()
  assert.equal(restantes.length, 3, 'órfão deveria continuar no espelho com reconciliar=false')
})

test('idempotência: rodar duas vezes seguidas com a mesma leitura da origem não repete remoção nem gera erro', async () => {
  await seedMirror({ numeroDocumento: 1, valor: 100 })
  await seedMirror({ numeroDocumento: 2, valor: 200 })
  await seedMirror({ numeroDocumento: 3, valor: 300 }) // órfão

  const poolE01 = criarPoolFake({ notasRepres: [linhaFonte({ numeroDocumento: 1, valor: 100 }), linhaFonte({ numeroDocumento: 2, valor: 200 })] })

  const r1 = await executarSincronizacaoVendasGerenciais({ dryRun: false, filial: FILIAL, desde: DESDE, ate: ATE, poolE01, log: () => {} })
  assert.equal(r1.total_removido, 1)

  const r2 = await executarSincronizacaoVendasGerenciais({ dryRun: false, filial: FILIAL, desde: DESDE, ate: ATE, poolE01, log: () => {} })
  assert.equal(r2.total_removido, 0)
  assert.equal(r2.total_criado, 0)
  assert.equal(r2.total_atualizado, 0)
  assert.equal(r2.total_com_erro, 0)

  const restantes = await linhasNoEscopo()
  assert.equal(restantes.length, 2)
})

test('falha na leitura da origem nunca aciona remoção — propaga o erro e preserva o espelho intacto', async () => {
  await seedMirror({ numeroDocumento: 1, valor: 100 })
  await seedMirror({ numeroDocumento: 2, valor: 200 })

  const poolE01 = criarPoolFake({ falharLeitura: true })
  await assert.rejects(
    () => executarSincronizacaoVendasGerenciais({ dryRun: false, filial: FILIAL, desde: DESDE, ate: ATE, poolE01, log: () => {} }),
    /falha simulada de leitura da origem/
  )

  const restantes = await linhasNoEscopo()
  assert.equal(restantes.length, 2, 'nenhuma linha deveria ter sido removida quando a leitura da origem falha')
})

test('log de sincronização registra contadores/motivo de reconciliação (auditoria)', async () => {
  await seedMirror({ numeroDocumento: 1, valor: 100 })
  await seedMirror({ numeroDocumento: 2, valor: 200 }) // órfão

  const poolE01 = criarPoolFake({ notasRepres: [linhaFonte({ numeroDocumento: 1, valor: 100 })] })
  await executarSincronizacaoVendasGerenciais({
    dryRun: false, filial: FILIAL, desde: DESDE, ate: ATE, poolE01, log: () => {},
  })

  const { data, error } = await supabase.from('sincronizacoes_vendas_gerenciais').select('total_removido, reconciliacao_candidatos, reconciliacao_motivo_bloqueio, status').order('iniciado_em', { ascending: false }).limit(1).maybeSingle()
  assert.equal(error, null)
  assert.equal(data.total_removido, 1)
  assert.equal(data.reconciliacao_candidatos, 1)
  assert.equal(data.reconciliacao_motivo_bloqueio, null)
  assert.equal(data.status, 'concluido')
})
