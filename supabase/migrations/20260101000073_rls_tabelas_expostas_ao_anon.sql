-- ACHADO (18/09/2026, ao preparar o Meu Ponto): neste projeto os papeis
-- "anon" e "authenticated" tem SELECT por padrao nas tabelas de public. Quem
-- protege de fato e o RLS - 59 das 80 tabelas tinham; 21 nao tinham.
--
-- Confirmado EMPIRICAMENTE, nao por teoria: uma requisicao ao PostgREST com a
-- chave PUBLICA (a que vai no bundle do site, visivel para qualquer um)
-- devolveu linhas reais de collection_do_not_contact, whatsapp_instances e
-- conferencias_financeiro. Contas_financeiras e usuarios devolveram vazio,
-- porque ja tinham RLS - a prova de que o RLS e o que estava segurando.
--
-- O que estava exposto: telefone de cliente com contexto de cobranca em 906
-- eventos de timeline, 910 disparos e a lista de 53 clientes que pediram para
-- NAO ser contatados. Dado pessoal sob LGPD. Nenhum segredo real vazou
-- (whatsapp_instances guarda o NOME da variavel de ambiente, nao o valor).
--
-- CORRECAO: habilitar RLS SEM criar policy. O backend fala com o Supabase
-- usando service_role, que ignora RLS por definicao - entao nada quebra do
-- lado da aplicacao. O frontend nao fala com o Supabase direto (verificado:
-- nenhum createClient no bundle, nenhuma VITE_SUPABASE_*), so com a API.
-- Sem policy, anon e authenticated passam a ler zero linha.
alter table public.ai_jobs                          enable row level security;
alter table public.ai_shadow_suggestions            enable row level security;
alter table public.ai_tool_audit                    enable row level security;
alter table public.collection_contact_review_actions enable row level security;
alter table public.collection_dispatch_attempts     enable row level security;
alter table public.collection_dispatches            enable row level security;
alter table public.collection_do_not_contact        enable row level security;
alter table public.collection_priority_scores       enable row level security;
alter table public.collection_promises              enable row level security;
alter table public.collection_recovery_scores       enable row level security;
alter table public.collection_shadow_cursor         enable row level security;
alter table public.collection_timeline_events       enable row level security;
alter table public.conferencias_financeiro          enable row level security;
alter table public.integration_events               enable row level security;
alter table public.meta_budget_guard_log            enable row level security;
alter table public.nba_shadow_log                   enable row level security;
alter table public.negotiation_policies             enable row level security;
alter table public.sincronizacao_financeiro_erros   enable row level security;
alter table public.sincronizacoes_financeiro        enable row level security;
alter table public.sincronizacoes_fiscal            enable row level security;
alter table public.whatsapp_instances               enable row level security;
