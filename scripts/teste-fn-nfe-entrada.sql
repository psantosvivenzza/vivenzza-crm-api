-- Teste transacional das funções fn_confirmar_nfe_entrada e
-- fn_estornar_nfe_entrada_confirmada, direto contra o schema de produção
-- (Supabase), dentro de uma transação que termina em ROLLBACK — nada abaixo
-- fica gravado de verdade.
--
-- Roda via psql ou via mcp__Supabase__execute_sql (projeto vkncsyhugotyfwmxpzgq):
--   psql "$DATABASE_URL" -f scripts/teste-fn-nfe-entrada.sql
--
-- Revalida os 8 cenários já cobertos manualmente durante a construção da
-- Fase A (31/07), agora como um script reproduzível e versionado. Todos os
-- dados usados (fornecedor, produto, notas) têm marcadores "TESTE
-- AUTOMATIZADO" e nunca chegam a ser commitados (BEGIN...ROLLBACK).

BEGIN;

CREATE TEMP TABLE resultados_teste (ordem int, cenario text, passou boolean, detalhe text);

-- ===== Fixture =====
INSERT INTO fornecedores (cnpj, razao_social, origem)
VALUES ('55666777000181', 'FORNECEDOR TESTE AUTOMATIZADO FASE A', 'manual');

INSERT INTO produtos (nome, sku, preco_custo, unidade)
VALUES ('PRODUTO TESTE AUTOMATIZADO FASE A', 'TESTE-FASEA-NFEENTRADA', 10.0000, 'UN');

INSERT INTO nfe_entradas (fornecedor_id, numero, serie, ambiente, origem, status,
  valor_produtos, valor_frete, valor_seguro, valor_ipi, valor_outras_despesas, valor_desconto, valor_total, observacoes)
SELECT id, 999001, 1, 'homologacao', 'manual', 'recebida', 500.00, 15.00, 0, 10.00, 0, 0, 525.00, 'TESTE AUTOMATIZADO FASE A'
FROM fornecedores WHERE cnpj = '55666777000181';

INSERT INTO nfe_entrada_itens (nfe_entrada_id, numero_item, quantidade_fornecedor, valor_unitario_fornecedor,
  valor_total_item, mapeado, lote, data_validade)
SELECT id, 1, 10, 50.00, 500.00, false, 'LOTE-TESTE-01', CURRENT_DATE + 180
FROM nfe_entradas WHERE numero = 999001;

-- ===== Cenário 1: confirmar com item não mapeado deve bloquear =====
DO $$
DECLARE v_nota_id uuid; v_erro text;
BEGIN
  SELECT id INTO v_nota_id FROM nfe_entradas WHERE numero = 999001;
  BEGIN
    PERFORM fn_confirmar_nfe_entrada(v_nota_id, '1856764c-da70-471a-b8ef-d0fb82229171'::uuid, NULL);
    INSERT INTO resultados_teste VALUES (1, 'item não mapeado bloqueia confirmação', false, 'não lançou exceção — deveria ter bloqueado');
  EXCEPTION WHEN OTHERS THEN
    v_erro := SQLERRM;
    INSERT INTO resultados_teste VALUES (1, 'item não mapeado bloqueia confirmação',
      v_erro ILIKE '%sem mapeamento de produto%', v_erro);
  END;
END $$;

-- Mapear o item pro produto de teste
UPDATE nfe_entrada_itens
SET produto_id = (SELECT id FROM produtos WHERE sku = 'TESTE-FASEA-NFEENTRADA'),
    mapeado = true, fator_conversao = 1, quantidade_convertida = 10
WHERE nfe_entrada_id = (SELECT id FROM nfe_entradas WHERE numero = 999001);

-- ===== Cenário 2: soma de parcelas divergente do valor total bloqueia =====
DO $$
DECLARE v_nota_id uuid; v_erro text;
BEGIN
  SELECT id INTO v_nota_id FROM nfe_entradas WHERE numero = 999001;
  BEGIN
    PERFORM fn_confirmar_nfe_entrada(v_nota_id, '1856764c-da70-471a-b8ef-d0fb82229171'::uuid,
      '[{"valor":500.00,"vencimento":"2026-08-30"}]'::jsonb); -- deveria ser 525.00
    INSERT INTO resultados_teste VALUES (2, 'soma de parcelas errada bloqueia confirmação', false, 'não lançou exceção — deveria ter bloqueado');
  EXCEPTION WHEN OTHERS THEN
    v_erro := SQLERRM;
    INSERT INTO resultados_teste VALUES (2, 'soma de parcelas errada bloqueia confirmação',
      v_erro ILIKE '%Soma das parcelas%', v_erro);
  END;
END $$;

-- ===== Cenário 3: confirmação correta (2 parcelas somando o valor total) =====
DO $$
DECLARE v_nota_id uuid; v_resultado jsonb;
BEGIN
  SELECT id INTO v_nota_id FROM nfe_entradas WHERE numero = 999001;
  SELECT fn_confirmar_nfe_entrada(v_nota_id, '1856764c-da70-471a-b8ef-d0fb82229171'::uuid,
    '[{"valor":262.50,"vencimento":"2026-08-30"},{"valor":262.50,"vencimento":"2026-09-29"}]'::jsonb)
  INTO v_resultado;
  INSERT INTO resultados_teste VALUES (3, 'confirmação com parcelas corretas tem sucesso',
    (v_resultado->>'status') = 'confirmada', v_resultado::text);
END $$;

-- Cenário 3a: custo rateado calculado certo — esperado 52.5000
-- ( (500 + (500/500)*(15+10)) / 10 = 525/10 = 52.5 )
INSERT INTO resultados_teste
SELECT 4, 'custo rateado calculado certo (esperado 52.5000)', preco_custo = 52.5000, 'preco_custo=' || preco_custo::text
FROM produtos WHERE sku = 'TESTE-FASEA-NFEENTRADA';

-- Cenário 3b: movimentação de estoque de entrada criada (10 unidades)
INSERT INTO resultados_teste
SELECT 5, 'movimentação de entrada criada (10un, motivo NFE_ENTRADA)',
  count(*) = 1 AND max(quantidade) = 10, 'linhas=' || count(*)::text || ' qtd=' || max(quantidade)::text
FROM movimentacoes_estoque me
JOIN produtos p ON p.id = me.produto_id
WHERE p.sku = 'TESTE-FASEA-NFEENTRADA' AND me.tipo = 'entrada' AND me.motivo = 'NFE_ENTRADA';

-- Cenário 3c: saldo em `estoque` (via trigger) reflete a entrada (10)
INSERT INTO resultados_teste
SELECT 6, 'trigger de saldo de estoque aplicou a entrada (esperado 10)',
  e.quantidade = 10, 'quantidade=' || e.quantidade::text
FROM estoque e JOIN produtos p ON p.id = e.produto_id
WHERE p.sku = 'TESTE-FASEA-NFEENTRADA';

-- Cenário 3d: lote criado com a quantidade certa (10)
INSERT INTO resultados_teste
SELECT 7, 'lote criado com quantidade certa (esperado 10/10)',
  quantidade = 10 AND quantidade_disponivel = 10, 'qtd=' || quantidade::text || ' disp=' || quantidade_disponivel::text
FROM lotes_estoque le JOIN produtos p ON p.id = le.produto_id
WHERE p.sku = 'TESTE-FASEA-NFEENTRADA' AND le.lote = 'LOTE-TESTE-01';

-- Cenário 3e: as 2 parcelas foram criadas em Contas a Pagar (525 no total)
INSERT INTO resultados_teste
SELECT 8, 'parcelas criadas em contas_financeiras (2 linhas, soma 525.00)',
  count(*) = 2 AND sum(valor) = 525.00, 'linhas=' || count(*)::text || ' soma=' || sum(valor)::text
FROM contas_financeiras
WHERE nfe_entrada_id = (SELECT id FROM nfe_entradas WHERE numero = 999001);

-- ===== Cenário 4: confirmação dupla (idempotência) bloqueia =====
DO $$
DECLARE v_nota_id uuid; v_erro text;
BEGIN
  SELECT id INTO v_nota_id FROM nfe_entradas WHERE numero = 999001;
  BEGIN
    PERFORM fn_confirmar_nfe_entrada(v_nota_id, '1856764c-da70-471a-b8ef-d0fb82229171'::uuid, NULL);
    INSERT INTO resultados_teste VALUES (9, 'confirmação dupla bloqueia', false, 'não lançou exceção — deveria ter bloqueado');
  EXCEPTION WHEN OTHERS THEN
    v_erro := SQLERRM;
    INSERT INTO resultados_teste VALUES (9, 'confirmação dupla bloqueia',
      v_erro ILIKE '%já confirmada%', v_erro);
  END;
END $$;

-- ===== Cenário 5: estorno da nota confirmada =====
DO $$
DECLARE v_nota_id uuid; v_resultado jsonb;
BEGIN
  SELECT id INTO v_nota_id FROM nfe_entradas WHERE numero = 999001;
  SELECT fn_estornar_nfe_entrada_confirmada(v_nota_id, '1856764c-da70-471a-b8ef-d0fb82229171'::uuid, 'Teste automatizado — reversão de validação Fase A')
  INTO v_resultado;
  INSERT INTO resultados_teste VALUES (10, 'estorno da nota confirmada tem sucesso',
    (v_resultado->>'status') = 'cancelada', v_resultado::text);
END $$;

-- Cenário 5a: custo restaurado ao valor anterior (10.0000)
INSERT INTO resultados_teste
SELECT 11, 'custo restaurado ao valor anterior (esperado 10.0000)', preco_custo = 10.0000, 'preco_custo=' || preco_custo::text
FROM produtos WHERE sku = 'TESTE-FASEA-NFEENTRADA';

-- Cenário 5b: movimentação de saída compensatória criada (estoque líquido = 0)
INSERT INTO resultados_teste
SELECT 12, 'estoque líquido das movimentações voltou a zero',
  COALESCE(SUM(CASE WHEN tipo = 'entrada' THEN quantidade ELSE -quantidade END), 0) = 0,
  'liquido=' || COALESCE(SUM(CASE WHEN tipo = 'entrada' THEN quantidade ELSE -quantidade END), 0)::text
FROM movimentacoes_estoque me JOIN produtos p ON p.id = me.produto_id
WHERE p.sku = 'TESTE-FASEA-NFEENTRADA';

-- Cenário 5c: saldo em `estoque` (trigger) voltou a zero
INSERT INTO resultados_teste
SELECT 13, 'trigger de saldo de estoque reverteu a entrada (esperado 0)',
  e.quantidade = 0, 'quantidade=' || e.quantidade::text
FROM estoque e JOIN produtos p ON p.id = e.produto_id
WHERE p.sku = 'TESTE-FASEA-NFEENTRADA';

-- Cenário 5d: lote zerado, MAS não apagado (preserva auditoria/FK)
INSERT INTO resultados_teste
SELECT 14, 'lote zerado sem ser apagado (registro continua existindo)',
  quantidade = 0 AND quantidade_disponivel = 0, 'qtd=' || quantidade::text || ' disp=' || quantidade_disponivel::text
FROM lotes_estoque le JOIN produtos p ON p.id = le.produto_id
WHERE p.sku = 'TESTE-FASEA-NFEENTRADA' AND le.lote = 'LOTE-TESTE-01';

-- Cenário 5e: as 2 parcelas foram canceladas
INSERT INTO resultados_teste
SELECT 15, 'parcelas em aberto foram canceladas no estorno',
  count(*) FILTER (WHERE status = 'cancelada') = 2, 'canceladas=' || count(*) FILTER (WHERE status = 'cancelada')::text
FROM contas_financeiras
WHERE nfe_entrada_id = (SELECT id FROM nfe_entradas WHERE numero = 999001);

-- ===== Cenário 6: estorno duplicado bloqueia =====
DO $$
DECLARE v_nota_id uuid; v_erro text;
BEGIN
  SELECT id INTO v_nota_id FROM nfe_entradas WHERE numero = 999001;
  BEGIN
    PERFORM fn_estornar_nfe_entrada_confirmada(v_nota_id, '1856764c-da70-471a-b8ef-d0fb82229171'::uuid, 'segunda tentativa — deve bloquear');
    INSERT INTO resultados_teste VALUES (16, 'estorno duplicado bloqueia', false, 'não lançou exceção — deveria ter bloqueado');
  EXCEPTION WHEN OTHERS THEN
    v_erro := SQLERRM;
    INSERT INTO resultados_teste VALUES (16, 'estorno duplicado bloqueia',
      v_erro ILIKE '%Só é possível estornar%', v_erro);
  END;
END $$;

-- ===== Cenário 7: estorno bloqueado se alguma parcela já foi paga =====
INSERT INTO produtos (nome, sku, preco_custo, unidade)
VALUES ('PRODUTO TESTE AUTOMATIZADO FASE A #2', 'TESTE-FASEA-NFEENTRADA-2', 20.0000, 'UN');

INSERT INTO nfe_entradas (fornecedor_id, numero, serie, ambiente, origem, status,
  valor_produtos, valor_frete, valor_seguro, valor_ipi, valor_outras_despesas, valor_desconto, valor_total, observacoes)
SELECT id, 999002, 1, 'homologacao', 'manual', 'recebida', 200.00, 0, 0, 0, 0, 0, 200.00, 'TESTE AUTOMATIZADO FASE A #2'
FROM fornecedores WHERE cnpj = '55666777000181';

INSERT INTO nfe_entrada_itens (nfe_entrada_id, numero_item, quantidade_fornecedor, valor_unitario_fornecedor,
  valor_total_item, mapeado, produto_id, fator_conversao, quantidade_convertida)
SELECT ne.id, 1, 4, 50.00, 200.00, true, p.id, 1, 4
FROM nfe_entradas ne, produtos p WHERE ne.numero = 999002 AND p.sku = 'TESTE-FASEA-NFEENTRADA-2';

DO $$
DECLARE v_nota_id uuid;
BEGIN
  SELECT id INTO v_nota_id FROM nfe_entradas WHERE numero = 999002;
  PERFORM fn_confirmar_nfe_entrada(v_nota_id, '1856764c-da70-471a-b8ef-d0fb82229171'::uuid, '[{"valor":200.00,"vencimento":"2026-08-30"}]'::jsonb);
END $$;

-- Marca a parcela única como paga (simulando o financeiro já ter baixado)
UPDATE contas_financeiras SET status = 'paga', data_pagamento = CURRENT_DATE
WHERE nfe_entrada_id = (SELECT id FROM nfe_entradas WHERE numero = 999002);

DO $$
DECLARE v_nota_id uuid; v_erro text;
BEGIN
  SELECT id INTO v_nota_id FROM nfe_entradas WHERE numero = 999002;
  BEGIN
    PERFORM fn_estornar_nfe_entrada_confirmada(v_nota_id, '1856764c-da70-471a-b8ef-d0fb82229171'::uuid, 'não deveria ser permitido');
    INSERT INTO resultados_teste VALUES (17, 'estorno com parcela paga bloqueia', false, 'não lançou exceção — deveria ter bloqueado');
  EXCEPTION WHEN OTHERS THEN
    v_erro := SQLERRM;
    INSERT INTO resultados_teste VALUES (17, 'estorno com parcela paga bloqueia',
      v_erro ILIKE '%já paga%', v_erro);
  END;
END $$;

-- ===== Resultado final =====
SELECT ordem, cenario, passou, detalhe FROM resultados_teste ORDER BY ordem;

ROLLBACK;
