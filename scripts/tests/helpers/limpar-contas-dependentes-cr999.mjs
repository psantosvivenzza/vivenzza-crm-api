// Extraído de sync-financeiro-telefone-propagacao.test.mjs (fix FK, commit
// 47006b8 / PR #73) — mesmo comportamento, sem mudança: apaga
// contas_financeiras com legacy_id 'cr-999%' e as três dependências que a
// suíte collection-shadow-* pode ter criado apontando pra qualquer conta
// ainda presente (recovery/priority score e NBA), NESSA ORDEM, pra nunca
// esbarrar em FK (23503). Retorna os ids das contas removidas (vazio se
// nada casar com o filtro). Mesmo padrão de limparInstanciasDeTeste
// (_setup.mjs): dependências primeiro, pai depois.
//
// Extraído só pra dar cobertura de teste de regressão permanente à própria
// lógica de limpeza (limpar-contas-dependentes-fk.test.mjs) — não altera o
// prefixo, as tabelas dependentes nem a ordem já corrigidos em 47006b8.
import { exigirSucessoFixture } from './fixture-result.mjs'

const PREFIXO_LEGACY_ID = 'cr-999%'
const TABELAS_DEPENDENTES = ['collection_recovery_scores', 'collection_priority_scores', 'nba_shadow_log']

export async function limparContasCr999EDependencias(supabase) {
  const { data: contasParaRemover } = await exigirSucessoFixture('buscar contas cr-999% p/ limpar dependências',
    supabase.from('contas_financeiras').select('id').like('legacy_id', PREFIXO_LEGACY_ID))
  const idsParaRemover = (contasParaRemover || []).map((c) => c.id)
  if (idsParaRemover.length > 0) {
    for (const tabela of TABELAS_DEPENDENTES) {
      await exigirSucessoFixture(`limpar ${tabela} de cr-999%`, supabase.from(tabela).delete().in('contas_financeiras_id', idsParaRemover))
    }
  }
  await exigirSucessoFixture('limpar contas cr-999%', supabase.from('contas_financeiras').delete().like('legacy_id', PREFIXO_LEGACY_ID))
  return idsParaRemover
}
