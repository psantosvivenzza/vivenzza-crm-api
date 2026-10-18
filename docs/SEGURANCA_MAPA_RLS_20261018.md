# Contenção do mapa de representantes

Alvo exclusivo: Supabase Vivenzza vkncsyhugotyfwmxpzgq, tabela public.representante_vendedor_mapa. Não usar credenciais/conexão Unhas. Sem DML, mudança de vendedor, função, trigger, proprietário ou credencial.

## Estado observado e proposta

18/10/2026 10:06Z: RLS/force false; zero policies; zero ACL explícita por coluna; anon/authenticated sem bypass/superuser mas com CRUD efetivo. Proprietário postgres com bypass; service_role bypass e CRUD. Trigger enabled O, função SECURITY DEFINER postgres/bypass. Sem views dependentes encontradas. Isso não comprova ausência de todos os caminhos indiretos nem abuso efetivo.

Migration gerada pelo CLI Supabase existente 2.121.0: 20261018101227_proteger_representante_vendedor_mapa.sql. Habilita RLS, revoga ALL de PUBLIC/anon/authenticated, preserva CRUD service_role. Pré-condições recusam estado inesperado, pós-condições verificam privilégios efetivos e RLS. Lock timeout 5s, statement timeout 15s, transação explícita. Backend/trigger continuam com bypass; não criar policies permissivas para usuários.

## Verificação

SQL final revisado duas vezes pelo Claude somente leitura; guarda da função e pós-checagem backend ampliadas após a primeira revisão. Sem bloqueantes finais. Revisor não executou testes.

Ensaio sintético final executado no PostgreSQL 17 exclusivo, loopback 56487, banco vivenzza_rls_map_20261018_0825. Fixture equivalente com proprietário postgres e função trigger previamente criada; corpo exato do SQL candidato executado dentro da transação externa de ensaio, removendo somente BEGIN/COMMIT internos para permitir rollback da fixture. Resultado exit 0: oito recusas ACL, oito verificações RLS independentes após regrant temporário, backend CRUD, trigger e atribuição manual preservados. Rollback e cluster encerrado. Fixture mínima, não clone real nem teste do conector remoto.

## Situação de aplicação

Tentativa pelo apply_migration do conector Vivenzza foi RECUSADA pela revisão automática por faltar aprovação humana específica dessa tabela/ACL. Não há sucesso ou versão remota de migration confirmado. Não executar por execute_sql, CLI ou browser para contornar. Solicitação específica enviada ao usuário; aguardar resposta antes de nova tentativa.

Após aprovação: fixar projeto/link Vivenzza, revalidar metadados, aplicar a mesma migration e conferir RLS/force, ACL, políticas, função e acesso somente leitura sob papéis de cliente/backend. Não alterar cliente real para testar trigger. Usar código/fixture e metadados como evidência parcial da preservação; homologação do fluxo real separada.

## Recuperação

ACL anterior observada: postgres, anon, authenticated e service_role tinham ALL (arwdDxtm), sem PUBLIC ou ACL por coluna. RLS e force false. Não executar rollback automático: reabriria a vulnerabilidade. Sob decisão específica de incidente, revalidar estado e dependências antes de restaurar apenas as ACL necessárias e eventual RLS anterior; preservar dados e manter registro auditável. Nenhum backup de dados foi necessário para DML porque este patch não escreve linhas, mas os gates de recuperação do projeto continuam abertos.
