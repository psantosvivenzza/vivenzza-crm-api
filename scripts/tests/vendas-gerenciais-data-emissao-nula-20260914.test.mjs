// Auditoria (14/09/2026) — hipótese investigada: linhas SEM REPRESENTANTE
// seriam excluídas do sync gerencial por tratamento implícito de NULL em
// EN_NotasRepres."DataEmissao". Confirmado por consulta read-only e
// sanitizada à origem (filial 001, produção): a hipótese específica NÃO se
// confirma hoje — zero linhas com `Representante` em branco existem em
// EN_NotasRepres, e as 224 linhas históricas com `DataEmissao IS NULL`
// (filial 001) são todas de 2019–2020 com `ValorDocumento = 0,00`. Tanto
// EN_NotasRepres quanto EN_RepresMensal (tabela pré-agregada independente)
// concordam exatamente com o que o sync já lê para o período corrente —
// zero divergência monetária ativa hoje.
//
// Apesar disso, o PADRÃO DE CÓDIGO era um defeito latente real: o filtro
// `"DataEmissao" >= $2 AND "DataEmissao" <= $3` excluía qualquer linha com
// `DataEmissao IS NULL` por lógica trivalorada do SQL, SEM NENHUM log — se
// o NetVision um dia emitir um documento com valor real e sem DataEmissao,
// ele desapareceria de "Vendas do Mês" pra sempre, em silêncio. Esta suíte
// prova: (a) o filtro agora é explícito (`IS NOT NULL`) e o comportamento de
// inclusão/exclusão não muda; (b) uma checagem companion detecta e loga,
// de forma sanitizada (nunca nome/código de representante, nunca dado de
// cliente), quantas linhas com DataEmissao NULL existem na filial e qual o
// valor total delas; (c) nenhuma data é fabricada — linhas sem DataEmissao
// NUNCA entram no espelho; (d) linhas com `Representante` em branco mas
// `DataEmissao` válida (permitidas pelo schema, não observadas em produção
// hoje) já eram e continuam sendo incluídas normalmente — nenhuma lógica de
// representante jamais excluiu uma linha aqui.
//
// Postgres exclusivo desta suíte (nunca 5432/5433/vivenzza_dev, nunca
// produção): porta/banco definidos via LOCAL_PG_PORT/LOCAL_PG_DATABASE no
// ambiente antes de rodar (ver scripts/localdb-start.mjs/localdb-reset.mjs).
// Nenhum teste aqui toca o NetVision real (E01) — a origem é sempre um pool
// fake em memória — nem o Supabase real (LOCAL_PG_URL força o compat client
// local, mesma trava fail-closed de src/lib/supabase-admin.server.js).
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
  await supabase.from('sincronizacoes_vendas_gerenciais').delete().gte('total_lido', 0)
})

beforeEach(async () => {
  await supabase.from('vendas_gerenciais_netvision').delete().eq('codigo_filial', FILIAL).gte('data_emissao', DESDE).lte('data_emissao', ATE)
})

function linhaFonte({ filial = FILIAL, representante = 'REP1', serie = '1', numeroDocumento, valor = 100, dataEmissao = '2026-09-10', pagamentoAVista = 0 }) {
  return {
    CodigoFilial: filial, Representante: representante, DataEmissao: dataEmissao,
    NumeroDocumento: numeroDocumento, Serie: serie, ValorDocumento: valor,
    PagamentoAVista: pagamentoAVista, CondicaoPagamento: null, NumeroTitulo: null,
    NroRegistro: null, Emitente: null, CodigoPDV: null, StatusRepresentante: null,
  }
}

// Pool fake do NetVision (E01). Distingue a query companion de "DataEmissao
// IS NULL" (checada ANTES do match genérico "EN_NotasRepres", já que o SQL
// da companion também contém essa substring) da leitura principal — do
// contrário o teste ficaria cego pra qual das duas está sendo exercitada.
function criarPoolFake({ notasRepres = [], falharLeitura = false, semDataEmissao = { quantidade: 0, valorTotal: 0 } }) {
  return {
    async query(sql) {
      if (sql.includes('COUNT(*) AS quantidade')) {
        return { rows: [{ quantidade: String(semDataEmissao.quantidade), valor_total: String(semDataEmissao.valorTotal) }] }
      }
      if (sql.includes('EN_NotasRepres')) {
        if (falharLeitura) throw new Error('falha simulada de leitura da origem (E01 indisponível)')
        return { rows: notasRepres }
      }
      if (sql.includes('EN_Representantes')) return { rows: [{ codigo: 'REP1', nome: 'Representante Um' }] }
      throw new Error(`query E01 fake inesperada: ${sql}`)
    },
  }
}

async function linhasNoEscopo() {
  const { data, error } = await supabase.from('vendas_gerenciais_netvision').select('legacy_id, valor_documento, representante_codigo, representante_nome').eq('codigo_filial', FILIAL).gte('data_emissao', DESDE).lte('data_emissao', ATE)
  if (error) throw error
  return data
}

test('detecta e loga linhas com DataEmissao NULL, sem incluí-las no espelho nem fabricar data', async () => {
  const logs = []
  const poolE01 = criarPoolFake({
    notasRepres: [linhaFonte({ numeroDocumento: 1, valor: 100 })],
    semDataEmissao: { quantidade: 3, valorTotal: 45.9 },
  })
  const r = await executarSincronizacaoVendasGerenciais({ dryRun: false, filial: FILIAL, desde: DESDE, ate: ATE, poolE01, log: (msg) => logs.push(msg) })

  assert.equal(r.total_lido, 1, 'linhas sem DataEmissao nunca entram na contagem de lidas')
  assert.equal(r.total_criado, 1)

  const avisoDataNula = r.avisos.find((a) => a.tipo === 'data_emissao_nula_nunca_sincronizavel')
  assert.ok(avisoDataNula, 'deveria gerar aviso quando existem linhas com DataEmissao NULL')
  assert.equal(avisoDataNula.quantidade, 3)
  assert.equal(avisoDataNula.valor_total, 45.9)
  assert.equal(avisoDataNula.filial, FILIAL)

  assert.ok(logs.some((l) => l.includes('DataEmissao NULL') && l.includes('3') && l.includes('45.90')), 'log deveria mencionar quantidade e valor')

  const restantes = await linhasNoEscopo()
  assert.equal(restantes.length, 1, 'só a linha com DataEmissao válida deveria estar no espelho')
})

test('aviso de DataEmissao NULL é sanitizado — nunca inclui representante, cliente ou qualquer campo além de tipo/filial/quantidade/valor_total', async () => {
  const poolE01 = criarPoolFake({
    notasRepres: [linhaFonte({ numeroDocumento: 1, valor: 100 })],
    semDataEmissao: { quantidade: 1, valorTotal: 10 },
  })
  const r = await executarSincronizacaoVendasGerenciais({ dryRun: false, filial: FILIAL, desde: DESDE, ate: ATE, poolE01, log: () => {} })

  const avisoDataNula = r.avisos.find((a) => a.tipo === 'data_emissao_nula_nunca_sincronizavel')
  assert.deepEqual(Object.keys(avisoDataNula).sort(), ['filial', 'quantidade', 'tipo', 'valor_total'])
})

test('sem nenhuma linha com DataEmissao NULL na origem, nenhum aviso é gerado (nunca falso positivo)', async () => {
  const poolE01 = criarPoolFake({
    notasRepres: [linhaFonte({ numeroDocumento: 1, valor: 100 })],
    semDataEmissao: { quantidade: 0, valorTotal: 0 },
  })
  const r = await executarSincronizacaoVendasGerenciais({ dryRun: false, filial: FILIAL, desde: DESDE, ate: ATE, poolE01, log: () => {} })

  assert.equal(r.avisos.some((a) => a.tipo === 'data_emissao_nula_nunca_sincronizavel'), false)
})

test('CENÁRIO REAL (produção, 14/09/2026): linhas com DataEmissao NULL mas valor SEMPRE zero (224 linhas históricas 2019-2020) NÃO geram aviso — evita ruído de log repetido a cada ciclo por uma condição inofensiva e permanente', async () => {
  const logs = []
  const poolE01 = criarPoolFake({
    notasRepres: [linhaFonte({ numeroDocumento: 1, valor: 100 })],
    semDataEmissao: { quantidade: 224, valorTotal: 0 },
  })
  const r = await executarSincronizacaoVendasGerenciais({ dryRun: false, filial: FILIAL, desde: DESDE, ate: ATE, poolE01, log: (msg) => logs.push(msg) })

  assert.equal(r.avisos.some((a) => a.tipo === 'data_emissao_nula_nunca_sincronizavel'), false, 'quantidade > 0 mas valor = 0 nunca deveria gerar aviso')
  assert.equal(logs.some((l) => l.includes('DataEmissao NULL')), false, 'nenhum log de DataEmissao NULL deveria ser emitido quando o valor total é zero')
})

test('dry-run também reporta o aviso de DataEmissao NULL, sem nenhuma escrita', async () => {
  const poolE01 = criarPoolFake({
    notasRepres: [linhaFonte({ numeroDocumento: 1, valor: 100 })],
    semDataEmissao: { quantidade: 2, valorTotal: 20 },
  })
  const r = await executarSincronizacaoVendasGerenciais({ dryRun: true, filial: FILIAL, desde: DESDE, ate: ATE, poolE01, log: () => {} })

  assert.equal(r.dry_run, true)
  const avisoDataNula = r.avisos.find((a) => a.tipo === 'data_emissao_nula_nunca_sincronizavel')
  assert.ok(avisoDataNula)
  assert.equal(avisoDataNula.quantidade, 2)

  const restantes = await linhasNoEscopo()
  assert.equal(restantes.length, 0, 'dry-run nunca escreve')
})

test('linha com Representante em branco MAS DataEmissao válida é incluída normalmente (nunca excluída por representante)', async () => {
  const linhaSemRepresentante = linhaFonte({ representante: '', numeroDocumento: 42, valor: 250.5, dataEmissao: '2026-09-12' })
  const poolE01 = criarPoolFake({ notasRepres: [linhaSemRepresentante] })
  const r = await executarSincronizacaoVendasGerenciais({ dryRun: false, filial: FILIAL, desde: DESDE, ate: ATE, poolE01, log: () => {} })

  assert.equal(r.total_lido, 1)
  assert.equal(r.total_criado, 1, 'linha sem representante mas com data válida deveria ser criada normalmente')
  assert.equal(r.total_com_erro, 0)

  const restantes = await linhasNoEscopo()
  assert.equal(restantes.length, 1)
  assert.equal(restantes[0].representante_codigo, '', 'representante_codigo vazio é persistido tal como veio da origem, nunca inventado')
  assert.equal(Number(restantes[0].valor_documento), 250.5)
})

test('filtro explícito de DataEmissao IS NOT NULL não muda o comportamento de leitura normal (regressão)', async () => {
  const poolE01 = criarPoolFake({
    notasRepres: [linhaFonte({ numeroDocumento: 1, valor: 100 }), linhaFonte({ numeroDocumento: 2, valor: 200 })],
  })
  const r = await executarSincronizacaoVendasGerenciais({ dryRun: false, filial: FILIAL, desde: DESDE, ate: ATE, poolE01, log: () => {} })

  assert.equal(r.total_lido, 2)
  assert.equal(r.total_criado, 2)
  assert.equal(r.total_com_erro, 0)
})
