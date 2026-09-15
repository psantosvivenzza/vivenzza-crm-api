// Hardening (15/09/2026) — mesma classe de defeito já corrigida na PR #74
// (registrarMensagemSaida do SDR): a escrita de finalização do sync de
// vendas gerenciais (`supabase.from('sincronizacoes_vendas_gerenciais').update(...)`)
// não checava `error`. Isso foi a causa raiz real de um incidente em
// produção (14–15/09/2026): migration 20260101000054 (3 colunas novas)
// não tinha sido aplicada ainda, o UPDATE de finalização falhava com
// "column does not exist", e o registro ficava preso em status='executando'
// pra sempre — mesmo com o sync tendo lido/gravado os dados corretamente.
// O dashboard ("Vendas do Mês") é fail-closed nesse status, então ficava
// indisponível sem nenhum log explicando o motivo.
//
// Esta suíte reproduz o cenário EXATO do incidente (coluna ausente na
// finalização) contra um Postgres isolado e prova que, com o fix: (a) o
// sync não lança/derruba o processo, (b) o resultado (total_lido/criado/
// atualizado) continua correto, e (c) uma linha de log explícita é emitida
// — nada mais fica em silêncio.
//
// Postgres exclusivo desta suíte (nunca 5432/5433/vivenzza_dev, nunca
// produção): porta/banco definidos via LOCAL_PG_PORT/LOCAL_PG_DATABASE no
// ambiente antes de rodar. Nenhuma conexão real ao NetVision (E01) nem ao
// Supabase real (LOCAL_PG_URL força o compat client local).
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { PG_USER, PG_PASSWORD, PG_HOST, PG_PORT, PG_DATABASE } from '../localdb-config.mjs'

process.env.NODE_ENV = 'test'
process.env.LOCAL_PG_URL = `postgres://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/${PG_DATABASE}`

let supabase, executarSincronizacaoVendasGerenciais, pgPool

const FILIAL = '001'
const DESDE = '2026-09-01'
const ATE = '2026-09-30'

before(async () => {
  ;({ supabase } = await import('../../src/lib/supabase-admin.server.js'))
  ;({ executarSincronizacaoVendasGerenciais } = await import('../../src/jobs/sync-vendas-gerenciais-legado.js'))
  const { default: pg } = await import('pg')
  pgPool = new pg.Pool({ host: PG_HOST, port: PG_PORT, user: PG_USER, password: PG_PASSWORD, database: PG_DATABASE })
})

after(async () => {
  await supabase.from('vendas_gerenciais_netvision').delete().eq('codigo_filial', FILIAL).gte('data_emissao', DESDE).lte('data_emissao', ATE)
  await supabase.from('sincronizacoes_vendas_gerenciais').delete().gte('total_lido', 0)
  await pgPool.end()
})

beforeEach(async () => {
  await supabase.from('vendas_gerenciais_netvision').delete().eq('codigo_filial', FILIAL).gte('data_emissao', DESDE).lte('data_emissao', ATE)
})

function linhaFonte({ representante = 'REP1', serie = '1', numeroDocumento, valor = 100, dataEmissao = '2026-09-10', pagamentoAVista = 0 }) {
  return {
    CodigoFilial: FILIAL, Representante: representante, DataEmissao: dataEmissao,
    NumeroDocumento: numeroDocumento, Serie: serie, ValorDocumento: valor,
    PagamentoAVista: pagamentoAVista, CondicaoPagamento: null, NumeroTitulo: null,
    NroRegistro: null, Emitente: null, CodigoPDV: null, StatusRepresentante: null,
  }
}

function criarPoolFake({ notasRepres = [] }) {
  return {
    async query(sql) {
      if (sql.includes('COUNT(*) AS quantidade')) return { rows: [{ quantidade: '0', valor_total: '0', quantidade_valor_nao_zero: '0' }] }
      if (sql.includes('EN_NotasRepres')) return { rows: notasRepres }
      if (sql.includes('EN_Representantes')) return { rows: [{ codigo: 'REP1', nome: 'Representante Um' }] }
      throw new Error(`query E01 fake inesperada: ${sql}`)
    },
  }
}

test('REGRESSÃO (incidente 14-15/09): coluna ausente na finalização não derruba o sync e gera log explícito, não silêncio', async () => {
  // Reproduz o estado exato de produção antes da correção: as 3 colunas da
  // migration 054 não existem ainda nesta tabela.
  await pgPool.query(`
    ALTER TABLE public.sincronizacoes_vendas_gerenciais
      DROP COLUMN IF EXISTS total_removido,
      DROP COLUMN IF EXISTS reconciliacao_candidatos,
      DROP COLUMN IF EXISTS reconciliacao_motivo_bloqueio;
  `)

  try {
    const logs = []
    const poolE01 = criarPoolFake({ notasRepres: [linhaFonte({ numeroDocumento: 1, valor: 100 }), linhaFonte({ numeroDocumento: 2, valor: 200 })] })

    // Antes do fix, isto silenciosamente deixava o registro preso em
    // 'executando' sem nenhum log — o teste falharia por falta da linha de
    // log abaixo, não por exceção (o defeito era justamente NÃO lançar erro
    // nem avisar).
    const r = await executarSincronizacaoVendasGerenciais({
      dryRun: false, filial: FILIAL, desde: DESDE, ate: ATE, poolE01,
      log: (msg) => logs.push(msg),
    })

    // O sync em si tem que continuar funcionando normalmente — a falha é só
    // na escrita de status/observabilidade, nunca deve contaminar o
    // resultado real (dados já foram criados/atualizados antes da
    // finalização rodar).
    assert.equal(r.total_lido, 2)
    assert.equal(r.total_criado, 2)
    assert.equal(r.total_com_erro, 0)

    const linhaDeErro = logs.find((l) => l.includes('ERRO ao finalizar registro de sincronização'))
    assert.ok(linhaDeErro, `esperava um log explícito de erro na finalização; logs capturados: ${JSON.stringify(logs)}`)
    assert.match(linhaDeErro, /column .* does not exist|total_removido/i)
  } finally {
    // Restaura o schema pro resto da suíte/outros arquivos que rodam contra
    // o mesmo banco isolado desta tarefa.
    await pgPool.query(`
      ALTER TABLE public.sincronizacoes_vendas_gerenciais
        ADD COLUMN IF NOT EXISTS total_removido integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS reconciliacao_candidatos integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS reconciliacao_motivo_bloqueio text;
    `)
  }
})

test('regressão: caminho feliz (colunas presentes) segue sem nenhum log de erro', async () => {
  const logs = []
  const poolE01 = criarPoolFake({ notasRepres: [linhaFonte({ numeroDocumento: 1, valor: 100 })] })
  const r = await executarSincronizacaoVendasGerenciais({
    dryRun: false, filial: FILIAL, desde: DESDE, ate: ATE, poolE01,
    log: (msg) => logs.push(msg),
  })
  assert.equal(r.total_criado, 1)
  assert.ok(!logs.some((l) => l.includes('ERRO ao finalizar')), `não esperava log de erro no caminho feliz; logs: ${JSON.stringify(logs)}`)
})
