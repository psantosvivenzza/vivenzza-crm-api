-- Log de observabilidade da sincronização fiscal (EN_Notas → notas_fiscais_netvision)
-- — uma linha por execução real (nunca dry-run, que continua 100% read-only e não
-- escreve aqui). Mesma convenção de sincronizacoes_financeiro/sincronizacoes_pedidos.
--
-- Existe pra resolver um problema específico: notas_fiscais_netvision vazia é
-- ambíguo — pode ser "nunca sincronizou" ou "sincronizou e não achou nada" (nunca
-- vai acontecer na prática, mas o código não pode assumir isso). O indicador
-- "VENDAS DO MÊS" no dashboard (src/routes/dashboard.js) precisa distinguir os
-- dois casos pra nunca mostrar R$0,00 como se fosse dado fiscal confirmado quando
-- na verdade é ausência de sincronização.
CREATE TABLE IF NOT EXISTS public.sincronizacoes_fiscal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'executando', -- executando | concluido | concluido_com_erros | falhou
  iniciado_em timestamptz NOT NULL DEFAULT now(),
  concluido_em timestamptz,
  dry_run boolean NOT NULL DEFAULT false,
  total_lido integer,
  total_criado integer,
  total_atualizado integer,
  total_com_erro integer,
  mensagem_erro text,
  host_origem text
);
CREATE INDEX IF NOT EXISTS idx_sincronizacoes_fiscal_iniciado_em ON public.sincronizacoes_fiscal (dry_run, iniciado_em DESC);
