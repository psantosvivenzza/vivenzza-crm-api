-- Campos de vínculo de cliente, sincronização e edição local pra pedidos.
--
-- Decisão: NÃO criei uma coluna `pedido_externo_id` nova — `pedidos.legacy_id`
-- já existe e já guarda exatamente isso (formato "CodigoFilial-NumeroPedido",
-- ex. "001-9699", confirmado batendo 1:1 com ES_Pedidos no e01). Reaproveitar
-- evita duplicar a mesma informação em duas colunas que precisariam ficar
-- sincronizadas entre si. O mesmo vale pra `cliente_id`: já existe
-- `cliente_erp_id` (uuid → clientes_erp), não criei um `cliente_id` paralelo.
ALTER TABLE public.pedidos
  ADD COLUMN IF NOT EXISTS cliente_nome_origem text,
  ADD COLUMN IF NOT EXISTS cliente_documento_origem text,
  ADD COLUMN IF NOT EXISTS cliente_telefone_origem text,
  ADD COLUMN IF NOT EXISTS cliente_email_origem text,
  ADD COLUMN IF NOT EXISTS cliente_externo_id text,
  ADD COLUMN IF NOT EXISTS sistema_origem text NOT NULL DEFAULT 'manual'
    CHECK (sistema_origem IN ('manual', 'legado')),
  ADD COLUMN IF NOT EXISTS sincronizado_em timestamptz,
  ADD COLUMN IF NOT EXISTS atualizado_no_origem_em timestamptz,
  ADD COLUMN IF NOT EXISTS erro_sincronizacao text,
  ADD COLUMN IF NOT EXISTS precisa_vinculo_cliente boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS status_origem text,
  ADD COLUMN IF NOT EXISTS status_importacao_pendente boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS atualizado_localmente_em timestamptz,
  ADD COLUMN IF NOT EXISTS atualizado_localmente_por_usuario_id uuid REFERENCES public.usuarios(id),
  ADD COLUMN IF NOT EXISTS campos_com_override_local jsonb,
  ADD COLUMN IF NOT EXISTS conflito_sincronizacao boolean NOT NULL DEFAULT false;

-- Backfill: os 9.108 pedidos que já têm legacy_id vieram do legado; o único
-- pedido sem legacy_id é o criado direto no CRM (origem manual, default já cobre).
UPDATE public.pedidos SET sistema_origem = 'legado' WHERE legacy_id IS NOT NULL;

-- Marca os pedidos já importados que ainda não têm cliente resolvido — vão
-- aparecer com o alerta "Cliente pendente de vinculação" até o backfill (que
-- roda depois, via script, usando ES_Pedidos.CodigoEmitente) ou vínculo manual.
UPDATE public.pedidos SET precisa_vinculo_cliente = true
  WHERE cliente_erp_id IS NULL AND lead_id IS NULL;

-- Garante que a sincronização nunca crie pedido duplicado — sem isso, rodar o
-- backfill duas vezes (ou uma falha parcial seguida de reexecução) criaria uma
-- linha nova por pedido em vez de atualizar a existente. NULLs não colidem
-- entre si em UNIQUE no Postgres, então não afeta pedidos manuais sem legacy_id.
ALTER TABLE public.pedidos
  ADD CONSTRAINT pedidos_sistema_origem_legacy_id_key UNIQUE (sistema_origem, legacy_id);
