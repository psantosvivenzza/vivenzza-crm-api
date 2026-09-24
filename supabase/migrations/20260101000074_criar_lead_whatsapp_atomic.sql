-- Achado real (investigação dedicada, 2026-09-24): 46 leads órfãos/duplicados
-- em 22-23/09, concentrados em rajadas de poucos segundos do mesmo contato
-- (reconexão da Evolution API reenviando mensagens em lote). Duas causas
-- confirmadas por leitura do código, ambas em src/routes/webhook-handler.js +
-- src/lib/distribuicao.js:
--
-- 1) DUPLICAÇÃO: processWhatsappEvent() faz um SELECT por telefone e, se não
--    achar nada, faz um INSERT — sem nenhum lock nem constraint único em
--    leads.telefone (confirmado: não existe em nenhuma migration nem no
--    schema real). Duas chamadas concorrentes pro MESMO telefone (rajada)
--    fazem as duas o SELECT achar vazio e as duas inserirem — lead
--    duplicado. Não dá pra corrigir só com UNIQUE INDEX porque produção JÁ
--    TEM duplicatas reais hoje (achado da investigação anterior) — criar o
--    índice quebraria a migration. A correção é um advisory lock
--    (pg_advisory_xact_lock) escopado ao telefone canônico, dentro de UMA
--    função — serializa concorrência pro mesmo contato sem exigir nenhuma
--    limpeza de dado existente, e sem lock nenhum entre telefones diferentes.
--
-- 2) ÓRFÃO: src/lib/distribuicao.js:proximoVendedor() não tem retry — se a
--    RPC proximo_vendedor_atomic() falhar por qualquer motivo transiente
--    (pool de conexão sob a mesma rajada, timeout), o erro só é logado e a
--    função devolve null — o lead nasce com responsavel_id NULL, permanente.
--    Corrigido no lado JS (retry controlado em distribuicao.js) — esta
--    migration cobre só o lado do banco: reaproveita a MESMA
--    proximo_vendedor_atomic() (nenhuma lógica de rodízio duplicada) dentro
--    da mesma transação do INSERT do lead, eliminando também a janela entre
--    "RPC de vendedor" e "INSERT do lead" que existia como duas chamadas
--    HTTP/PostgREST separadas antes.
--
-- Puramente aditiva — nenhuma tabela/linha existente é tocada, migration
-- segura pra aplicar em produção sem qualquer pré-limpeza de dado real.
CREATE OR REPLACE FUNCTION public.criar_lead_whatsapp_atomic(
  p_candidatos text[],
  p_telefone text,
  p_nome text,
  p_origem text,
  p_campanha_origem text,
  p_ctwa_clid text
)
RETURNS TABLE(id uuid, nome text, responsavel_id uuid, ctwa_clid text, campanha_origem text, criado boolean)
LANGUAGE plpgsql
AS $function$
DECLARE
  v_id uuid; v_nome text; v_responsavel_id uuid; v_ctwa_clid text; v_campanha_origem text;
  v_vend_id uuid;
BEGIN
  -- Serializa toda criação de lead concorrente para o MESMO telefone
  -- canônico (sempre o mesmo valor gravado pelo webhook — ver semPrefixo em
  -- webhook-handler.js). Lock de TRANSAÇÃO (não de sessão): libera sozinho
  -- no commit/rollback, mesmo se a função levantar exceção — nunca fica
  -- preso. Telefones diferentes nunca competem pelo mesmo lock (hash), então
  -- uma rajada de contatos novos e distintos continua paralela normalmente.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_telefone, 0));

  -- Re-checa DEPOIS do lock — se outra chamada concorrente pro mesmo
  -- telefone já criou o lead enquanto esta esperava o lock, usa o lead dela:
  -- nunca cria duplicado, nunca reatribui responsavel_id de um lead já
  -- existente. Mesmo critério de match do SELECT em webhook-handler.js
  -- (candidatosTelefone) — p_candidatos vem de lá, sem duplicar a lógica.
  SELECT l.id, l.nome, l.responsavel_id, l.ctwa_clid, l.campanha_origem
    INTO v_id, v_nome, v_responsavel_id, v_ctwa_clid, v_campanha_origem
  FROM public.leads l
  WHERE l.telefone = ANY(p_candidatos)
  ORDER BY l.criado_em ASC
  LIMIT 1;

  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT v_id, v_nome, v_responsavel_id, v_ctwa_clid, v_campanha_origem, false;
    RETURN;
  END IF;

  -- Mesmo rodízio de sempre (proximo_vendedor_atomic, já com seu próprio
  -- lock em distribuicao_leads.id=1) — reaproveitado, nunca duplicado. Sem
  -- vendedor ativo elegível, devolve vazio e responsavel_id fica NULL (dado
  -- operacional, não bug — ver proximo_vendedor_atomic).
  SELECT v.id INTO v_vend_id FROM public.proximo_vendedor_atomic() v;

  INSERT INTO public.leads (nome, telefone, etapa, origem, campanha_origem, ctwa_clid, responsavel_id)
  VALUES (p_nome, p_telefone, 'novo', p_origem, p_campanha_origem, p_ctwa_clid, v_vend_id)
  RETURNING leads.id, leads.nome, leads.responsavel_id, leads.ctwa_clid, leads.campanha_origem
    INTO v_id, v_nome, v_responsavel_id, v_ctwa_clid, v_campanha_origem;

  RETURN QUERY SELECT v_id, v_nome, v_responsavel_id, v_ctwa_clid, v_campanha_origem, true;
END;
$function$;

-- Mesmo achado de segurança já corrigido em 20260101000056/000062/000066
-- (PRs #77/#79/notas-entrada): Postgres concede EXECUTE em toda function
-- nova do schema public a PUBLIC por padrão, e PostgREST expõe qualquer
-- function de public como RPC pros papéis anon/authenticated salvo REVOKE
-- explícito. Sem isso, POST /rpc/criar_lead_whatsapp_atomic ficaria
-- chamável por qualquer chave anon (a que vai no bundle público), permitindo
-- criar leads arbitrários e consumir o rodízio de vendedores por fora do
-- fluxo real do webhook. service_role é o único papel que este projeto usa
-- pra chamar RPCs administrativas (src/lib/supabase-admin.server.js).
REVOKE EXECUTE ON FUNCTION public.criar_lead_whatsapp_atomic(text[], text, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.criar_lead_whatsapp_atomic(text[], text, text, text, text, text) TO service_role;
