-- SYNTHETIC TEST DATA ONLY — nenhuma linha deste arquivo corresponde a
-- cliente, telefone, CNPJ ou valor real.
--
-- Seed sintético de homologação — SOMENTE dados fictícios. Nenhum telefone,
-- nome, CNPJ ou valor aqui corresponde a cliente real. Todos os telefones usam
-- o prefixo 55519999 + sufixo de 3 dígitos (nunca gerado por candidatosTelefone
-- de um número real da base) e o sufixo "(TESTE)" no nome, para nunca serem
-- confundidos com dado de produção nem, por engano, com um número real.
--
-- Datas são relativas a CURRENT_DATE (não hardcoded) — reexecutar este seed em
-- qualquer dia futuro continua representando corretamente D+3/D+15/D+60/etc.
--
-- Idempotente: limpa (por padrão de nome "% (TESTE)") antes de inserir de novo —
-- rodar múltiplas vezes não duplica.

DELETE FROM public.collection_timeline_events WHERE cliente_telefone LIKE '55519999%';
DELETE FROM public.collection_promises WHERE cliente_telefone LIKE '55519999%';
DELETE FROM public.cobrancas_whatsapp WHERE cliente_telefone LIKE '55519999%';
DELETE FROM public.baixas_financeiras WHERE conta_financeira_id IN (SELECT id FROM public.contas_financeiras WHERE telefone_cobranca LIKE '55519999%');
DELETE FROM public.contas_financeiras WHERE telefone_cobranca LIKE '55519999%';

DO $$
DECLARE
  v_admin_id uuid;
  v_conta_a uuid; v_conta_b uuid; v_conta_c uuid; v_conta_d uuid; v_conta_e uuid;
  v_conta_f uuid; v_conta_g uuid; v_conta_h uuid; v_conta_i uuid; v_conta_j uuid;
  v_conta_k uuid; v_conta_l uuid; v_conta_m uuid; v_conta_n uuid; v_conta_o uuid;
BEGIN
  -- Usuário admin de teste (reaproveitado se já existir).
  SELECT id INTO v_admin_id FROM public.usuarios WHERE email = 'admin-teste@vivenzza.local';
  IF v_admin_id IS NULL THEN
    INSERT INTO public.usuarios (nome, email, senha_hash, role)
    VALUES ('Admin Teste (TESTE)', 'admin-teste@vivenzza.local', '$2a$10$invalidoNaoUsarParaLogin', 'admin')
    RETURNING id INTO v_admin_id;
  END IF;

  -- CLIENTE_A — pagador pontual: título ainda não vencido + histórico de título
  -- pago integralmente (alimenta recovery_score alto).
  INSERT INTO public.contas_financeiras (tipo, pessoa_nome, valor, vencimento, status, telefone_cobranca)
  VALUES ('receber', 'Cliente A Pontual (TESTE)', 1200.00, CURRENT_DATE + 10, 'aberta', '5551999900001')
  RETURNING id INTO v_conta_a;
  INSERT INTO public.contas_financeiras (tipo, pessoa_nome, valor, valor_pago, vencimento, status, telefone_cobranca)
  VALUES ('receber', 'Cliente A Pontual (TESTE)', 900.00, 900.00, CURRENT_DATE - 40, 'paga', '5551999900001');

  -- CLIENTE_B — D+3 (etapa 4: D+3 a D+6).
  INSERT INTO public.contas_financeiras (tipo, pessoa_nome, valor, vencimento, status, telefone_cobranca)
  VALUES ('receber', 'Cliente B D3 (TESTE)', 850.00, CURRENT_DATE - 3, 'vencida', '5551999900002')
  RETURNING id INTO v_conta_b;

  -- CLIENTE_C — D+15 (etapa 6: D+15 a D+29).
  INSERT INTO public.contas_financeiras (tipo, pessoa_nome, valor, vencimento, status, telefone_cobranca)
  VALUES ('receber', 'Cliente C D15 (TESTE)', 2300.00, CURRENT_DATE - 15, 'vencida', '5551999900003')
  RETURNING id INTO v_conta_c;

  -- CLIENTE_D — D+60 (etapa 8: D+60 em diante).
  INSERT INTO public.contas_financeiras (tipo, pessoa_nome, valor, vencimento, status, telefone_cobranca)
  VALUES ('receber', 'Cliente D D60 (TESTE)', 4100.00, CURRENT_DATE - 60, 'vencida', '5551999900004')
  RETURNING id INTO v_conta_d;

  -- CLIENTE_E — promessa válida (ativa, vencendo no futuro — silêncio inteligente).
  INSERT INTO public.contas_financeiras (tipo, pessoa_nome, valor, vencimento, status, telefone_cobranca)
  VALUES ('receber', 'Cliente E Promessa Valida (TESTE)', 600.00, CURRENT_DATE - 5, 'vencida', '5551999900005')
  RETURNING id INTO v_conta_e;
  INSERT INTO public.collection_promises (contas_financeiras_id, cliente_nome, cliente_telefone, valor, promised_date, origem, status)
  VALUES (v_conta_e, 'Cliente E Promessa Valida (TESTE)', '5551999900005', 600.00, CURRENT_DATE + 3, 'HUMAN', 'ativa');

  -- CLIENTE_F — promessa quebrada (venceu no passado, nunca cumprida).
  INSERT INTO public.contas_financeiras (tipo, pessoa_nome, valor, vencimento, status, telefone_cobranca)
  VALUES ('receber', 'Cliente F Promessa Quebrada (TESTE)', 750.00, CURRENT_DATE - 20, 'vencida', '5551999900006')
  RETURNING id INTO v_conta_f;
  INSERT INTO public.collection_promises (contas_financeiras_id, cliente_nome, cliente_telefone, valor, promised_date, origem, status, broken_at)
  VALUES (v_conta_f, 'Cliente F Promessa Quebrada (TESTE)', '5551999900006', 750.00, CURRENT_DATE - 10, 'AI', 'quebrada', now());

  -- CLIENTE_G — pagamento informado (timeline, aguardando conciliação — título
  -- continua tecnicamente em aberto no banco, só a interação é registrada).
  INSERT INTO public.contas_financeiras (tipo, pessoa_nome, valor, vencimento, status, telefone_cobranca)
  VALUES ('receber', 'Cliente G Pagamento Informado (TESTE)', 500.00, CURRENT_DATE - 2, 'vencida', '5551999900007')
  RETURNING id INTO v_conta_g;
  INSERT INTO public.collection_timeline_events (contas_financeiras_id, cliente_telefone, tipo, origem, descricao)
  VALUES (v_conta_g, '5551999900007', 'PAGAMENTO_INFORMADO', 'HUMAN', 'Cliente informou pagamento — aguardando conciliação (seed sintético)');

  -- CLIENTE_H — contestação (em_revisao_financeira=true, pausa automação).
  INSERT INTO public.contas_financeiras (tipo, pessoa_nome, valor, vencimento, status, telefone_cobranca, em_revisao_financeira)
  VALUES ('receber', 'Cliente H Contestacao (TESTE)', 950.00, CURRENT_DATE - 8, 'vencida', '5551999900008', true)
  RETURNING id INTO v_conta_h;
  INSERT INTO public.collection_timeline_events (contas_financeiras_id, cliente_telefone, tipo, origem, descricao)
  VALUES (v_conta_h, '5551999900008', 'CONTESTACAO', 'HUMAN', 'Cliente não reconhece a cobrança (seed sintético)');

  -- CLIENTE_I — alto valor.
  INSERT INTO public.contas_financeiras (tipo, pessoa_nome, valor, vencimento, status, telefone_cobranca)
  VALUES ('receber', 'Cliente I Alto Valor (TESTE)', 48000.00, CURRENT_DATE - 10, 'vencida', '5551999900009')
  RETURNING id INTO v_conta_i;

  -- CLIENTE_J — baixo valor.
  INSERT INTO public.contas_financeiras (tipo, pessoa_nome, valor, vencimento, status, telefone_cobranca)
  VALUES ('receber', 'Cliente J Baixo Valor (TESTE)', 45.00, CURRENT_DATE - 10, 'vencida', '5551999900010')
  RETURNING id INTO v_conta_j;

  -- CLIENTE_K — WhatsApp enviado, sem resposta.
  INSERT INTO public.contas_financeiras (tipo, pessoa_nome, valor, vencimento, status, telefone_cobranca)
  VALUES ('receber', 'Cliente K Sem Resposta (TESTE)', 1100.00, CURRENT_DATE - 4, 'vencida', '5551999900011')
  RETURNING id INTO v_conta_k;
  INSERT INTO public.cobrancas_whatsapp (contas_financeiras_id, cliente_nome, cliente_telefone, valor, vencimento, dias_atraso, etapa, status, origem, data_envio, mensagem_enviada)
  VALUES (v_conta_k, 'Cliente K Sem Resposta (TESTE)', '5551999900011', 1100.00, CURRENT_DATE - 4, 4, 4, 'enviada', 'cron', now(), '(mensagem sintética de teste)');

  -- CLIENTE_L — WhatsApp respondeu.
  INSERT INTO public.contas_financeiras (tipo, pessoa_nome, valor, vencimento, status, telefone_cobranca)
  VALUES ('receber', 'Cliente L Respondeu (TESTE)', 1300.00, CURRENT_DATE - 5, 'vencida', '5551999900012')
  RETURNING id INTO v_conta_l;
  INSERT INTO public.cobrancas_whatsapp (contas_financeiras_id, cliente_nome, cliente_telefone, valor, vencimento, dias_atraso, etapa, status, origem, data_envio, data_resposta, mensagem_enviada)
  VALUES (v_conta_l, 'Cliente L Respondeu (TESTE)', '5551999900012', 1300.00, CURRENT_DATE - 5, 5, 4, 'respondida', 'cron', now() - interval '1 day', now(), '(mensagem sintética de teste)');
  INSERT INTO public.collection_timeline_events (contas_financeiras_id, cliente_telefone, tipo, origem, descricao)
  VALUES (v_conta_l, '5551999900012', 'RESPONDEU', 'HUMAN', 'Cliente respondeu à cobrança (seed sintético)');

  -- CLIENTE_M — solicitou segunda via.
  INSERT INTO public.contas_financeiras (tipo, pessoa_nome, valor, vencimento, status, telefone_cobranca)
  VALUES ('receber', 'Cliente M Segunda Via (TESTE)', 700.00, CURRENT_DATE - 6, 'vencida', '5551999900013')
  RETURNING id INTO v_conta_m;
  INSERT INTO public.collection_timeline_events (contas_financeiras_id, cliente_telefone, tipo, origem, descricao)
  VALUES (v_conta_m, '5551999900013', 'SEGUNDA_VIA_SOLICITADA', 'HUMAN', 'Cliente pediu segunda via / PIX (seed sintético)');

  -- CLIENTE_N — solicitou negociação.
  INSERT INTO public.contas_financeiras (tipo, pessoa_nome, valor, vencimento, status, telefone_cobranca)
  VALUES ('receber', 'Cliente N Negociacao (TESTE)', 3200.00, CURRENT_DATE - 12, 'vencida', '5551999900014')
  RETURNING id INTO v_conta_n;
  INSERT INTO public.collection_timeline_events (contas_financeiras_id, cliente_telefone, tipo, origem, descricao)
  VALUES (v_conta_n, '5551999900014', 'NEGOCIANDO', 'HUMAN', 'Cliente pediu para negociar (seed sintético)');

  -- CLIENTE_O — solicitou humano.
  INSERT INTO public.contas_financeiras (tipo, pessoa_nome, valor, vencimento, status, telefone_cobranca)
  VALUES ('receber', 'Cliente O Solicitou Humano (TESTE)', 1900.00, CURRENT_DATE - 9, 'vencida', '5551999900015')
  RETURNING id INTO v_conta_o;
  INSERT INTO public.collection_timeline_events (contas_financeiras_id, cliente_telefone, tipo, origem, descricao)
  VALUES (v_conta_o, '5551999900015', 'TRANSFERIDO_HUMANO', 'HUMAN', 'Cliente pediu para falar com humano (seed sintético)');

  RAISE NOTICE 'Seed sintético aplicado: 15 clientes de teste (A-O), telefones 5551999900001-015.';
END $$;
