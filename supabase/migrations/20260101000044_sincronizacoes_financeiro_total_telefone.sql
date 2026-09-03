-- Contador novo pro relatório do sync financeiro (sync-financeiro-legado.js)
-- — reatualização de telefone_cobranca em títulos JÁ EXISTENTES a partir de
-- clientes_erp.contatos (mesma prioridade celular>fone/telefone>contato de
-- telefoneDoCliente(), que antes só era usada na criação de título novo).
-- Só um contador de auditoria — nenhum campo financeiro, nenhuma alteração
-- em dado já existente na tabela.
ALTER TABLE public.sincronizacoes_financeiro
  ADD COLUMN IF NOT EXISTS total_telefone_atualizado integer;
