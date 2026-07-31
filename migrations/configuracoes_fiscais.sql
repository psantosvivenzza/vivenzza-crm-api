-- Trava de segurança pra decisão que depende do contador antes da 1ª emissão
-- real da série 1: a numeração legada está bagunçada (numero de -1066 a
-- 5.241.175, contador de emissão zerado — ver nfe_numeracao_serie99_avanco.sql,
-- linhas 12-21). Enquanto serie1_numeracao_liberada=false, POST /api/nfe/:id/emitir
-- bloqueia qualquer NFe de série 1 (fiscal real) com mensagem clara — mesmo em
-- homologação, pra não confundir testes futuros com o valor real definido depois.
--
-- Pra liberar (só depois do contador confirmar o número inicial seguro):
--   UPDATE public.configuracoes_fiscais
--   SET serie1_numeracao_liberada = true, serie1_numero_inicial = <numero>,
--       serie1_liberada_por = '<uuid do usuário>', serie1_liberada_em = now()
--   WHERE id = 1;
--   UPDATE public.nfe_numeracao SET ultimo_numero = <numero> - 1 WHERE serie = 1;
CREATE TABLE public.configuracoes_fiscais (
  id integer PRIMARY KEY DEFAULT 1,
  serie1_numeracao_liberada boolean NOT NULL DEFAULT false,
  serie1_numero_inicial integer,
  serie1_liberada_por uuid REFERENCES public.usuarios(id),
  serie1_liberada_em timestamptz,
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT configuracoes_fiscais_singleton CHECK (id = 1)
);

INSERT INTO public.configuracoes_fiscais (id) VALUES (1);
