-- Apenas dados físicos para pedidos/frete; preserva preços, estoque e cadastros.
alter table public.produtos add column if not exists logistica_fisica jsonb;
comment on column public.produtos.logistica_fisica is 'Peso bruto e quantidade cúbica unitários espelhados do cadastro; unidades explícitas, sem fator de cubagem universal.';
