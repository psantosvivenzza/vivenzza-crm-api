# Tarefas pendentes

## WhatsApp — terceira instância financeira

- [ ] Escanear o QR code do `vivenzza-financeiro-reserva-02` (aguardando
      operador).
- [ ] Confirmar `connected` na Evolution.
- [ ] Cadastrar em `whatsapp_instances` (`role=reserva`, `priority=3`,
      `enabled=true`) só depois de `connected` confirmado.
- [ ] Validar roteamento (cenários de principal/reserva apta/inapta,
      `PERMANENT_RECIPIENT`, `UNKNOWN`) sem enviar mensagem real.

## Voz — servidor definitivo

- [ ] Escolher o hardware físico definitivo.
- [ ] Instalar o kit portátil (`scripts/voice-server/`) no servidor novo.
- [ ] Conectar o celular/chip real da empresa (Bluetooth).
- [ ] Decidir mecanismo de VPN/túnel entre Railway e o servidor de voz.
- [ ] Manter `voice_external_enabled`/`TRUNK_EXTERNO_CONFIGURADO` em
      `false` até validação final completa.

## Cobrança — acompanhamento

- [ ] Acompanhar organicamente a redução de `PERMANENT_RECIPIENT` depois
      da quarentena de 30 dias entrar em regime (efeito real só aparece
      conforme novas confirmações do provider ocorrem, não é retroativo).
- [ ] Equipe do Financeiro corrigir os telefones inválidos identificados
      em `/revisao-contatos`, diretamente no NetVision.

## Higiene de repositório (auditoria em andamento)

- [ ] Sincronizar checkouts locais desatualizados com `origin/main`
      quando fizer sentido (backend estava ~108 commits atrás no momento
      da última auditoria; frontend já foi sincronizado).
- [ ] Decidir o que fazer com branches/worktrees locais de PRs já
      mergeadas (a maioria pode ser removida com segurança, mas isso é uma
      decisão separada, não automática).

## Financeiro — RPC não versionada

- [x] `fn_sincronizar_baixa_legado` versionada em 2026-09-11 — corpo real
      capturado de produção via `pg_get_functiondef`/`pg_proc` (consulta
      read-only, nada alterado em produção), commitado fielmente em
      `supabase/migrations/20260101000056_fn_sincronizar_baixa_legado.sql`
      (depende de `20260101000055_contas_financeiras_colunas_revisao_conflito.sql`,
      que versiona 5 colunas de `contas_financeiras` — `motivo_revisao`,
      `em_revisao_desde`, `conflito_baixa_legado`, `sincronizado_legado_em`,
      `em_revisao_financeira` — que também nunca tiveram migration, mesmo
      padrão de drift de `20260101000045`). Coberta por
      `scripts/tests/collection/fn-sincronizar-baixa-legado.test.mjs` (7
      cenários, Postgres local real, contas sintéticas `cr-997%`):
      idempotência, nunca reverter pagamento, nunca duplicar dinheiro,
      cancelamento, resolução automática de revisão, encerrado com saldo.
      **Tipos confirmados (2026-09-11):** `motivo_revisao` text,
      `em_revisao_desde` timestamptz, `conflito_baixa_legado` boolean,
      `sincronizado_legado_em` timestamptz — consulta read-only real contra
      `information_schema.columns` de produção bateu exatamente com a
      inferência original (ver comentário na migration 000055).
      **GRANTs corrigidos (2026-09-11):** confirmado via painel do Supabase
      que a function tinha `EXECUTE` concedido a `PUBLIC`, `anon`,
      `authenticated`, `postgres` e `service_role` — qualquer JWT válido (ou
      sem login, via chave anon) podia chamá-la direto via PostgREST,
      contornando o gate adminOuFinanceiro de `src/routes/financeiro.js`/
      `auth.js`. Corrigido SÓ localmente (nada aplicado em produção) em
      `supabase/migrations/20260101000057_fn_sincronizar_baixa_legado_revoga_execute_publico.sql`:
      revoga de `PUBLIC`/`anon`/`authenticated`, mantém só `service_role`
      (o papel real usado por `supabase-admin.server.js`); `postgres`
      (owner/superuser) não foi tocado. Função é `SECURITY INVOKER` — além
      do `EXECUTE`, `service_role` também precisa de `SELECT`/`INSERT`/
      `UPDATE` direto em `contas_financeiras`/`baixas_financeiras` (já tem
      isso de verdade em qualquer Supabase real; migration replica só pra
      ambiente novo/local funcionar). Coberto por
      `scripts/tests/collection/fn-sincronizar-baixa-legado-grants.test.mjs`
      (`SET ROLE` real dentro de transação, não apenas documentação):
      anon/authenticated recusados com `42501`, service_role continua
      funcionando ponta a ponta. **Ainda não aplicado em produção** —
      decisão de quando/como aplicar fica pra quem revisar a PR.
      **Cluster de teste:** suíte de teste local rodada num cluster Postgres
      EXCLUSIVO (porta/banco fora do padrão 5433/vivenzza_dev — ver
      `scripts/tests/unit/README.md`), nunca o cluster compartilhado. O
      arquivo de teste recusa (fail-closed) rodar contra porta 5432/5433 ou
      banco vivenzza_dev/postgres.
      **Correção (revisão independente, 2026-09-12):** esta PR não era
      auto-suficiente — `fn_sincronizar_baixa_legado` também lê/escreve
      `contas_financeiras.em_revisao_financeira`, coluna que só tinha
      migration na PR #79 (`20260101000063`). Reproduzido empiricamente
      (Postgres exclusivo, porta fora de 5432/5433, banco fora de
      vivenzza_dev): aplicar só as migrations desta PR contra uma base sem o
      drift de produção faz a function ser criada sem erro (PL/pgSQL não
      valida coluna referenciada em SQL embutido na criação), mas a primeira
      chamada real falha em runtime (`record "v_conta" has no field
      "em_revisao_financeira"`) — ou seja, mergear #77 sem #79 (ou nessa
      ordem) quebraria o sync legado em qualquer ambiente novo sem o drift.
      Corrigido adicionando a coluna também na migration que cria as colunas
      de revisão/conflito (mesmo tipo/default da 000063: `boolean NOT NULL
      DEFAULT false`, `ADD COLUMN IF NOT EXISTS` — no-op seguro se a 000063
      da PR #79 já tiver rodado, em qualquer ordem de merge). Suíte completa
      (`npm run test:collection`, 69 arquivos/801 casos) revalidada sem
      regressão após a correção.
      **Renumerado (revisão de fechamento, 2026-09-15):** as 3 migrations
      desta PR usavam originalmente `20260101000054-056`; a PR #101 (vendas
      gerenciais, mergeada em `origin/main` em 2026-09-14) já ocupou
      `20260101000054` com um arquivo diferente (tabela
      `sincronizacoes_vendas_gerenciais`, sem overlap semântico — só colisão
      de número de sequência, achado ao reconstruir o estado atual da PR
      contra `origin/main` antes do merge). Renumerado para
      `20260101000055-057` (ver caminhos atualizados acima) antes do merge;
      nenhuma mudança de conteúdo/lógica/grants nesta renumeração — suíte
      revalidada de novo após renomear.
- [ ] Os 15 ajustes reais listados em `PREVIEW_RESOLUCAO_125_CONFLITOS.md`
      (seção AUTO_RESOLVABLE_DETERMINISTIC, ex.: Francisco Freitas Oliveira,
      FABIANO KAMPFF LEITE, THAINA RODRIGUES) continuam **não aplicados** —
      versionar a RPC não é autorização pra rodá-la contra títulos reais.
      Precisa de decisão explícita antes de aplicar via
      `decidirAtualizacao()`/`fn_sincronizar_baixa_legado` em produção.
- [x] `fn_baixar_titulo`, `fn_estornar_baixa`, `fn_aprovar_estorno`,
      `fn_rejeitar_estorno` e `estornos_financeiros` tinham o mesmo problema
      (só existiam em `migrations/` — pasta solta, fora do pipeline real de
      `scripts/localdb-reset.mjs` — nunca em `supabase/migrations/`; gap
      citado explicitamente como não tratado na PR #77 e coberto só por
      aplicação manual/cluster avulso em `financeiro-controle-acesso.test.mjs`/
      `pgcompat-embed-fkey-financeiro.test.mjs`). Versionado na PR #79 em
      `supabase/migrations/20260101000058` a `000063` (mesmo texto de
      `migrations/*.sql`, verbatim, só com guards de idempotência) +
      hardening de GRANT (achado análogo ao da PR #77: EXECUTE exposto a
      PUBLIC/anon/authenticated por padrão do Supabase/PostgREST) + novo
      `estornos-financeiros-grants.test.mjs`. Revisão independente (2026-09-12)
      achou gap correlato — mesmo padrão da PR #77/`20260101000055`:
      `fn_estornar_baixa`/`fn_aprovar_estorno` leem/escrevem
      `contas_financeiras.em_revisao_financeira`, coluna sem migration
      commitada até então.
      **Renumerado e consolidado (revisão de fechamento, 2026-09-15):** a
      PR #79 usava originalmente `20260101000057-000063`; a PR #77 (mergeada
      em `origin/main` em 2026-09-15) já ocupou `20260101000057` com um
      arquivo diferente (`fn_sincronizar_baixa_legado_revoga_execute_publico.sql`,
      sem overlap semântico — só colisão de número de sequência). Renumerado
      para `20260101000058-000063`. A migration
      `20260101000063_contas_financeiras_em_revisao_financeira.sql` desta PR
      foi removida por redundância: a PR #77 já fecha essa mesma dependência
      em `20260101000055_contas_financeiras_colunas_revisao_conflito.sql`
      (mesma coluna, mesmo tipo/default), então a numeração final desta PR é
      6 arquivos (`000058-000063`), não 7. Nenhuma mudança de
      conteúdo/lógica/grants nas 6 migrations restantes. Verificação contra
      produção real ainda pendente para o conjunto completo (`000055` da PR
      #77 + `000058-000063` desta PR) — ver
      `docs/claude-context/verificacao-producao-estornos-baixar-titulo.md`.
- [x] `fn_criar_nota_entrada` (chamada por `POST /api/notas-entrada`) e as
      tabelas `notas_entrada`/`notas_entrada_itens` nunca tiveram nenhum SQL
      versionado neste repositório (nem mesmo em `migrations/` solta).
      `estoque`/`movimentacoes_estoque`/`atualizar_saldo_estoque()` tinham o
      mesmo problema de `migrations/` solta, mais um drift confirmado
      (produção real tem `SET search_path` no trigger function, a versão
      solta não). Versionado na PR #80 em `supabase/migrations/20260101000064`
      (estoque/movimentacoes_estoque, drift corrigido) e `000065`
      (notas_entrada/notas_entrada_itens/fn_criar_nota_entrada, verbatim) +
      hardening de GRANT em `000066` (mesmo achado de EXECUTE exposto a
      PUBLIC/anon/authenticated) + novos testes
      `notas-entrada-fn-criar-grants.test.mjs`, `notas-entrada-fluxo.test.mjs`,
      `relatorios-dre.test.mjs`. `produtos`/`nfe`/`nfe_itens` seguem sem
      migration própria (pré-existentes, nunca versionadas neste
      repositório — mesma situação de `usuarios`/`contas_financeiras`); só
      ganharam baseline de teste em
      `scripts/localdb/schema-baseline/007_notas_entrada_dre.sql`. Riscos de
      negócio não corrigidos (conta a pagar de Nota de Entrada some do DRE,
      `produtos.estoque` dessincronizada, custo do DRE recalculado
      retroativamente, sem idempotência, sem cancelamento/reversão)
      documentados em `docs/financeiro/decisoes-e-riscos-notas-entrada-dre.md`.
      **Revisão de fechamento (2026-09-15):** numeração `000064-000066` já
      nasceu correta (sem colisão com `000058-000063` da PR #79); único
      conflito de merge com `origin/main` foi neste próprio arquivo
      (documentação, resolvido por concatenação). Colunas de
      `notas_entrada`/`notas_entrada_itens`/`estoque`/`movimentacoes_estoque`/
      `produtos` confirmadas via leitura read-only real de produção (Supabase
      REST, `service_role`, só `SELECT`, nenhuma escrita) — batem
      exatamente com as migrations. Corpo de função/trigger e GRANT reais
      **não puderam ser confirmados nesta sessão** (sem acesso Postgres
      direto a produção, só REST) — verificação formal via SQL Editor
      (`docs/financeiro/verificacao-producao-notas-entrada-dre.md`) continua
      pendente antes de aplicar `000064-000066` no Supabase real.

## Concluído (não refazer)

- [x] Sync fiscal residente e resiliente (Task Scheduler).
- [x] Vendas gerenciais via `EN_NotasRepres` (backend + card do dashboard).
- [x] Certificado digital novo instalado com cadeia completa.
- [x] PR #55 — circuit breaker não afeta mais saúde por
      `PERMANENT_RECIPIENT`.
- [x] PR #57 — quarentena de 30 dias para número inválido confirmado.
- [x] PR #58 — prioridade de celular na seleção do telefone de cobrança.
- [x] Fila de revisão de contatos (backend #59 + frontend #10).
- [x] Kit portátil do servidor de voz (PR #56).
