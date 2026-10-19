# Checkpoint seguro de pedidos — 17/10/2026

## Contrato

Retomar somente do último ciclo `concluido`, nunca do cursor de um `concluido_com_erros`: sucesso em data posterior não comprova persistência de todas as linhas anteriores. Falha de leitura do histórico aborta antes de criar ciclo/conectar origem. Erros retornados na gravação de detalhes ou conclusão são propagados, não relatados como conclusão normal.

Mantidos: janela de segurança de dez minutos, importação comercial, overrides locais, concorrência, flags de logística e tabelas. Cursor do ciclo parcial continua registrado como observação, mas não é checkpoint elegível. Ciclo vazio mantém o checkpoint anterior, sem regredir dez minutos a cada execução.

## Verificação

`npm run test:pedidos:checkpoint`

Nove casos isolados do job e seis guards estáticos do wrapper, incluindo falha antiga seguida de sucesso mais recente e retomada do ciclo seguinte, ordenação do histórico e ciclo vazio sem regressão de checkpoint. Baseline inicial: cinco falhas esperadas e um controle aprovado, confirmando cursor incorreto e rejeições ausentes. Testes usam o job real com módulos externos substituídos antes do import por `registerHooks` (requer Node 22.15+; executado em Node 24; o runtime do job não foi alterado). Não importam SDK, dotenv, configuração real ou driver pg; não acessam bancos, rede nem workers. Não usar a suíte collection inteira como substituto deste comando.

## Implantação não autorizada por este patch

PR deve permanecer draft até revisão operacional. Sem histórico totalmente concluído, a próxima execução será backfill integral e poderá reprocessar milhares de pedidos. Uma falha persistente impede novos checkpoints concluídos: ciclos subsequentes repetem a janela desde o último sucesso, potencialmente crescendo e repetindo deletes/inserts dos itens. Este bloqueio conservador evita pular falhas, mas não oferece progresso limitado diante de pedido permanentemente inválido. Gate antes de implantação: definir recuperação limitada/quarentena ou retry durável, sem tratar falha como sucesso. Validar duração, impacto de deletes/inserts de itens, idempotência, backup e janela de execução antes de aplicar/reiniciar. O patch não repara automaticamente lacunas históricas já ultrapassadas por ciclos antigos marcados concluídos.

Complementar ao PR 151 (código de saída da CLI), sem incluí-lo. Este patch não modifica CLI, agendamento, banco, flags, env ou produção. Falha retornada ao gravar o próprio estado `falhou` ainda pode deixar metadados incompletos; se essa gravação rejeitar a Promise, pode mascarar a exceção original (comportamento anterior, não corrigido aqui). Não promete transação atômica por pedido nem processamento exatamente uma vez.

Outros gates apontados pela revisão: impedir sobreposição de execução HTTP e agendada com exclusão mútua real; limitar/reconciliar a repetição de detalhes em sincronizacao_pedidos_erros diante de falha persistente. Ordenação é verificada nos argumentos do double, não contra PostgREST real. Linhas históricas inconsistentes (concluido sem data/cursor) exigem validação operacional antes de implantação.

## Verificação automática do checkpoint (19/10/2026)

A workflow pedidos-checkpoint-safety executa os nove testes de checkpoint e os
seis guards estáticos do wrapper em Node 24, Ubuntu 24.04 e Windows. Não executa
o BAT; apenas lê sua estrutura e a cadeia de arquivos. Import hooks substituem pg, Supabase, conexão
E01 e logística física antes de carregar o job. Não instala dependências, carrega
.env, acessa banco real ou inicia a aplicação. GITHUB_TOKEN com contents: read,
actions fixadas por SHA. O check filtrado por paths não é requisito global de merge.

Os casos incluem execução parcial, preservação do último cursor concluído,
falha de leitura/persistência e sucesso posterior que não pode esconder linha
anterior com erro. Não prova importação produtiva, backfill completo, resolução
de linha permanentemente inválida ou compatibilidade da CLI da PR 151.
