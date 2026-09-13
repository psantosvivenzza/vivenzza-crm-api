// Cluster Postgres EXCLUSIVO da suíte de testes do módulo "Meu Ponto" —
// deliberadamente separado do banco local compartilhado do resto do repo
// (padrão 5433/vivenzza_dev, usado pelos testes de cobrança) e de qualquer
// coisa em produção. Porta, banco e diretório de dados só existem dentro
// deste worktree (vivenzza-meu-ponto-backend/.localdev). Ver seção 10 da
// especificação: nunca 5432/5433/vivenzza_dev/produção para este piloto.
export const PONTO_TEST_PG_HOST = '127.0.0.1'
export const PONTO_TEST_PG_PORT = Number(process.env.PONTO_TEST_PG_PORT || 55491)
export const PONTO_TEST_PG_DATABASE = process.env.PONTO_TEST_PG_DATABASE || 'meu_ponto_test'
export const PONTO_TEST_PG_USER = 'postgres'
export const PONTO_TEST_PG_PASSWORD = 'localdev_only_2026'

export const PONTO_TEST_LOCAL_PG_URL =
  `postgres://${PONTO_TEST_PG_USER}:${PONTO_TEST_PG_PASSWORD}@${PONTO_TEST_PG_HOST}:${PONTO_TEST_PG_PORT}/${PONTO_TEST_PG_DATABASE}`
