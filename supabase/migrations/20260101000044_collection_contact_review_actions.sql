-- Fila "Revisão de Contatos" (collection-contact-review.js) é 100% derivada
-- (nenhuma escrita) até aqui — o operador não tem como registrar que já
-- verificou um caso, então a mesma linha aparece pendente pra sempre até o
-- telefone mudar sozinho via sync. Esta tabela é SÓ um log de ação
-- operacional (auditável: quem, quando, qual cliente, qual ação, por quê) —
-- nunca altera contas_financeiras.telefone_cobranca, nunca escreve/apaga
-- collection_do_not_contact, nunca dispara WhatsApp/cobrança. O padrão de
-- "ação manual auditável" segue estornos_financeiros (solicitante + motivo +
-- timestamp), mas aqui é append-only (sem aprovação em duas etapas — não é
-- uma mutation financeira, é só um registro de acompanhamento).
CREATE TABLE IF NOT EXISTS public.collection_contact_review_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo_cliente text NOT NULL,
  telefone_revisado text,
  acao text NOT NULL CHECK (acao IN ('revisado', 'sem_contato_valido', 'aguardando_atualizacao_origem')),
  motivo text,
  registrado_por uuid NOT NULL REFERENCES public.usuarios(id),
  registrado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_collection_contact_review_actions_cliente
  ON public.collection_contact_review_actions (codigo_cliente, registrado_em DESC);
