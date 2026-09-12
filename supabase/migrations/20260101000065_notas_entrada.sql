-- GAP DE VERSIONAMENTO — notas_entrada / notas_entrada_itens /
-- fn_criar_nota_entrada NUNCA tiveram nenhum SQL versionado neste
-- repositório: confirmado por grep exaustivo em migrations/*.sql e
-- supabase/migrations/*.sql (nenhum resultado, nem mesmo na pasta solta,
-- diferente do caso de estornos_financeiros/fn_baixar_titulo, que ao menos
-- estavam em migrations/). Achado já registrado no comentário de topo de
-- scripts/tests/collection/notas-entrada-controle-acesso.test.mjs (PR #75) —
-- "fn_criar_nota_entrada() e as tabelas notas_entrada / notas_entrada_itens /
-- movimentacoes_estoque NÃO existem em nenhum SQL versionado do repositório".
--
-- Objeto já vivo em produção (usado por POST/GET /api/notas-entrada,
-- src/routes/notas-entrada.js), criado manualmente em algum momento não
-- auditável via git log/git blame — mesma classe de drift documentada em
-- 20260101000034/20260101000045/20260101000057.
--
-- Corpo abaixo é o texto CONFIRMADO via SQL Editor de produção real ao longo
-- de 3 rodadas de auditoria (colunas, tipos, precisão, constraints, índices
-- e corpo verbatim de fn_criar_nota_entrada) — consolidado em
-- docs/financeiro/schema-real-producao-dre-notas-entrada.md. Nenhuma linha
-- de definição foi inventada; só idempotência (IF NOT EXISTS/CREATE OR
-- REPLACE) foi adicionada por cima do texto confirmado.
--
-- Verificação pendente (sem acesso a produção real nesta sessão) — ver
-- consultas read-only prontas em
-- docs/financeiro/verificacao-producao-notas-entrada-dre.md antes de aplicar
-- esta migration em produção.

CREATE TABLE IF NOT EXISTS public.notas_entrada (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  numero_nota          text NOT NULL,
  serie                text,
  fornecedor_nome      text NOT NULL,
  fornecedor_cnpj      text,
  data_emissao         date NOT NULL,
  data_entrada         date NOT NULL DEFAULT CURRENT_DATE,
  valor_total          numeric NOT NULL,
  forma_pagamento      text,
  gerar_conta_pagar    boolean NOT NULL DEFAULT false,
  vencimento           date,
  observacoes          text,
  usuario_id           uuid REFERENCES public.usuarios(id),
  conta_financeira_id  uuid REFERENCES public.contas_financeiras(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  status               text NOT NULL DEFAULT 'confirmada'
);
CREATE INDEX IF NOT EXISTS idx_notas_entrada_fornecedor ON public.notas_entrada (fornecedor_nome);
CREATE INDEX IF NOT EXISTS idx_notas_entrada_numero ON public.notas_entrada (numero_nota);

CREATE TABLE IF NOT EXISTS public.notas_entrada_itens (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nota_entrada_id  uuid NOT NULL REFERENCES public.notas_entrada(id) ON DELETE CASCADE,
  produto_id       uuid NOT NULL REFERENCES public.produtos(id),
  quantidade       numeric,
  valor_unitario   numeric,
  valor_total      numeric
);
CREATE INDEX IF NOT EXISTS idx_notas_entrada_itens_nota ON public.notas_entrada_itens (nota_entrada_id);

-- Definição VERBATIM confirmada em produção (ver seção "Funções" de
-- docs/financeiro/schema-real-producao-dre-notas-entrada.md) — nenhuma linha
-- de lógica de negócio alterada. Sem bloco EXCEPTION WHEN: qualquer
-- RAISE EXCEPTION ou erro (ex.: violação de FK) propaga sem ser capturado,
-- revertendo a transação implícita da função inteira (comportamento real,
-- não uma escolha desta migration).
CREATE OR REPLACE FUNCTION public.fn_criar_nota_entrada(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_nota_id uuid;
  v_conta_id uuid;
  v_item jsonb;
  v_usuario_id uuid;
  v_gerar_conta boolean;
BEGIN
  v_usuario_id := NULLIF(p_payload->>'usuario_id', '')::uuid;
  v_gerar_conta := COALESCE((p_payload->>'gerar_conta_pagar')::boolean, false);

  IF p_payload->'itens' IS NULL OR jsonb_array_length(p_payload->'itens') = 0 THEN
    RAISE EXCEPTION 'A nota de entrada precisa ter ao menos 1 item';
  END IF;

  IF v_gerar_conta AND (p_payload->>'vencimento') IS NULL THEN
    RAISE EXCEPTION 'Vencimento é obrigatório para gerar conta a pagar';
  END IF;

  INSERT INTO notas_entrada (
    numero_nota, serie, fornecedor_nome, fornecedor_cnpj,
    data_emissao, data_entrada, valor_total, forma_pagamento,
    gerar_conta_pagar, vencimento, observacoes, usuario_id
  ) VALUES (
    p_payload->>'numero_nota',
    p_payload->>'serie',
    p_payload->>'fornecedor_nome',
    p_payload->>'fornecedor_cnpj',
    (p_payload->>'data_emissao')::date,
    COALESCE((p_payload->>'data_entrada')::date, current_date),
    (p_payload->>'valor_total')::numeric,
    p_payload->>'forma_pagamento',
    v_gerar_conta,
    (p_payload->>'vencimento')::date,
    p_payload->>'observacoes',
    v_usuario_id
  )
  RETURNING id INTO v_nota_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_payload->'itens')
  LOOP
    IF (v_item->>'produto_id') IS NULL OR (v_item->>'quantidade')::numeric <= 0 THEN
      RAISE EXCEPTION 'Item inválido: produto_id e quantidade positiva são obrigatórios';
    END IF;

    INSERT INTO notas_entrada_itens (nota_entrada_id, produto_id, quantidade, valor_unitario, valor_total)
    VALUES (
      v_nota_id,
      (v_item->>'produto_id')::uuid,
      (v_item->>'quantidade')::numeric,
      (v_item->>'valor_unitario')::numeric,
      (v_item->>'quantidade')::numeric * (v_item->>'valor_unitario')::numeric
    );

    INSERT INTO movimentacoes_estoque (produto_id, tipo, quantidade, motivo, documento_ref, usuario_id)
    VALUES (
      (v_item->>'produto_id')::uuid,
      'entrada',
      (v_item->>'quantidade')::numeric,
      'NE',
      p_payload->>'numero_nota',
      v_usuario_id
    );

    IF (v_item->>'atualizar_custo')::boolean IS DISTINCT FROM false THEN
      UPDATE produtos SET preco_custo = (v_item->>'valor_unitario')::numeric
      WHERE id = (v_item->>'produto_id')::uuid;
    END IF;
  END LOOP;

  IF v_gerar_conta THEN
    INSERT INTO contas_financeiras (
      tipo, descricao, valor, vencimento, categoria, pessoa_nome, documento_ref, usuario_id, status
    ) VALUES (
      'pagar',
      'Nota de entrada nº ' || (p_payload->>'numero_nota') || ' - ' || (p_payload->>'fornecedor_nome'),
      (p_payload->>'valor_total')::numeric,
      (p_payload->>'vencimento')::date,
      'Fornecedor',
      p_payload->>'fornecedor_nome',
      p_payload->>'numero_nota',
      v_usuario_id,
      'aberta'
    )
    RETURNING id INTO v_conta_id;

    UPDATE notas_entrada SET conta_financeira_id = v_conta_id WHERE id = v_nota_id;
  END IF;

  RETURN jsonb_build_object('id', v_nota_id, 'conta_financeira_id', v_conta_id);
END;
$function$;
