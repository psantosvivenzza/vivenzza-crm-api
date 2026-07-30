-- Baixa manual de títulos: permite status='pago_parcial' quando o valor recebido
-- é menor que o saldo devedor. Testado empiricamente (linha sintética, apagada em
-- seguida) que o constraint atual só aceitava 'aberta'/'vencida'/'paga'/'cancelada'.
ALTER TABLE public.contas_financeiras DROP CONSTRAINT IF EXISTS contas_financeiras_status_check;
ALTER TABLE public.contas_financeiras ADD CONSTRAINT contas_financeiras_status_check
  CHECK (status IN ('aberta', 'vencida', 'paga', 'cancelada', 'pago_parcial'));

-- Forma de pagamento e observação específica da baixa — testado empiricamente que
-- nenhuma das duas colunas existe hoje (a coluna `observacoes` já existente é a
-- descrição geral da conta, não a nota de quem deu a baixa).
ALTER TABLE public.contas_financeiras ADD COLUMN IF NOT EXISTS forma_pagamento text;
ALTER TABLE public.contas_financeiras ADD COLUMN IF NOT EXISTS observacao_pagamento text;
