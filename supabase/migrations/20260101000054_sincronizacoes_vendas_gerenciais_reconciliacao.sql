-- Reconciliação do read-model gerencial de vendas
-- (sync-vendas-gerenciais-legado.js): até aqui o job só criava/atualizava,
-- nunca removia da vendas_gerenciais_netvision uma linha que sumiu da fonte
-- (EN_NotasRepres) dentro do escopo filial+período já lido — causa raiz da
-- divergência real (14/09/2026, filial 001, mês corrente): NetVision 24
-- vendas/R$37.179,77 x CRM 26 vendas/R$50.476,67, diferença de 2 registros
-- órfãos que continuaram espelhados depois de sumirem da origem
-- (cancelamento/estorno/correção no NetVision).
--
-- Colunas novas só de observabilidade/auditoria da reconciliação — nenhuma
-- delas participa de guard de frescor (vendaGerencialSyncStatus.js continua
-- olhando só status/total_com_erro/concluido_em, comportamento inalterado).
ALTER TABLE public.sincronizacoes_vendas_gerenciais
  ADD COLUMN IF NOT EXISTS total_removido integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reconciliacao_candidatos integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reconciliacao_motivo_bloqueio text;
