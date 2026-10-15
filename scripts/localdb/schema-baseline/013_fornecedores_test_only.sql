-- Somente testes locais. Replica colunas verificadas por metadados do Supabase.
-- Cadastro já existe em produção; nunca aplicar este baseline em produção.
create table if not exists public.fornecedores (
 id uuid primary key default gen_random_uuid(), cnpj text not null unique,
 razao_social text not null, nome_fantasia text, ie text,
 endereco jsonb, contatos jsonb, ativo boolean not null default true,
 origem text not null default 'manual', criado_por uuid,
 criado_em timestamptz not null default now(), atualizado_em timestamptz not null default now()
);
