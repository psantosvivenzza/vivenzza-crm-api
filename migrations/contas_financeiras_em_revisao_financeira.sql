-- Pausa a régua de cobrança automática pra uma conta específica sem mexer no
-- status dela — usado quando um estorno por "pagamento não confirmado" ou
-- "devolução/chargeback" é aprovado (o financeiro precisa revisar antes de
-- qualquer disparo automático voltar a acontecer).
ALTER TABLE public.contas_financeiras
  ADD COLUMN IF NOT EXISTS em_revisao_financeira boolean NOT NULL DEFAULT false;
