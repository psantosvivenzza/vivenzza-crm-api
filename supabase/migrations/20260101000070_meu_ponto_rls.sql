-- RLS para as tabelas do Meu Ponto.
--
-- POR QUE ESTE ARQUIVO EXISTE (achado de 18/09/2026): neste projeto os papeis
-- "anon" e "authenticated" tem SELECT por padrao nas tabelas de public — quem
-- protege de fato e o RLS. Ao preparar a aplicacao das migrations 048-053
-- descobri que 21 tabelas estavam sem RLS e, testando com a chave PUBLICA (a
-- que vai no bundle do site), o PostgREST devolvia linhas reais: telefone de
-- cliente com contexto de cobranca e a lista de quem pediu para nao ser
-- contatado. Aquilo foi corrigido em migration propria.
--
-- As 11 tabelas do Meu Ponto nasceriam com o MESMO problema — e aqui o dado e
-- pior: FOTO e HORARIO de funcionario. Dado pessoal de empregado, sob LGPD,
-- legivel por qualquer um com a chave publica do site.
--
-- Habilitar RLS SEM policy e o correto aqui: o backend fala com o banco por
-- service_role, que ignora RLS por definicao, e o frontend nao conversa com o
-- Supabase direto (verificado: nenhum createClient, nenhuma VITE_SUPABASE_*).
-- Sem policy, anon e authenticated leem zero linha.
alter table public.ponto_config                    enable row level security;
alter table public.ponto_habilitacoes              enable row level security;
alter table public.ponto_habilitacoes_historico    enable row level security;
alter table public.ponto_gestores                  enable row level security;
alter table public.ponto_marcacoes                 enable row level security;
alter table public.ponto_fotos                     enable row level security;
alter table public.ponto_correcoes                 enable row level security;
alter table public.ponto_solicitacoes_marcacao     enable row level security;
alter table public.ponto_equipamentos              enable row level security;
alter table public.ponto_equipamento_vinculos      enable row level security;
alter table public.ponto_equipamento_eventos       enable row level security;
alter table public.ponto_desafios                  enable row level security;
