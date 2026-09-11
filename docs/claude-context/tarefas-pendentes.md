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
      `supabase/migrations/20260101000055_fn_sincronizar_baixa_legado.sql`
      (depende de `20260101000054_contas_financeiras_colunas_revisao_conflito.sql`,
      que versiona 4 colunas de `contas_financeiras` — `motivo_revisao`,
      `em_revisao_desde`, `conflito_baixa_legado`, `sincronizado_legado_em` —
      que também nunca tiveram migration, mesmo padrão de drift de
      `20260101000045`). Coberta por
      `scripts/tests/collection/fn-sincronizar-baixa-legado.test.mjs` (7
      cenários, Postgres local real, contas sintéticas `cr-997%`):
      idempotência, nunca reverter pagamento, nunca duplicar dinheiro,
      cancelamento, resolução automática de revisão, encerrado com saldo.
      **Ressalva 1 (bloqueia PR):** tipo de `motivo_revisao` (text) e
      `em_revisao_desde` (timestamptz) foi inferido por convenção do schema,
      não confirmado contra `information_schema.columns` de produção — nem os
      GRANTs reais da function (`pg_get_functiondef` não os inclui; se
      exposta sem restrição via PostgREST, contornaria o gate de
      admin/financeiro do Express). Query read-only exata preparada,
      aguardando alguém rodar e devolver o resultado — ver comentário na
      migration 000054 antes de tratar como definitivo.
      **Ressalva 2:** suíte de teste local rodada num cluster Postgres
      EXCLUSIVO (porta/banco fora do padrão 5433/vivenzza_dev — ver
      `scripts/tests/unit/README.md`), nunca o cluster compartilhado. O
      arquivo de teste recusa (fail-closed) rodar contra porta 5432/5433 ou
      banco vivenzza_dev/postgres.
- [ ] Os 15 ajustes reais listados em `PREVIEW_RESOLUCAO_125_CONFLITOS.md`
      (seção AUTO_RESOLVABLE_DETERMINISTIC, ex.: Francisco Freitas Oliveira,
      FABIANO KAMPFF LEITE, THAINA RODRIGUES) continuam **não aplicados** —
      versionar a RPC não é autorização pra rodá-la contra títulos reais.
      Precisa de decisão explícita antes de aplicar via
      `decidirAtualizacao()`/`fn_sincronizar_baixa_legado` em produção.
- [ ] `fn_baixar_titulo`, `fn_estornar_baixa`, `fn_aprovar_estorno`,
      `fn_rejeitar_estorno` e a tabela `estornos_financeiros` têm o MESMO
      problema (achado ao investigar esta tarefa, 2026-09-11): não têm
      migration em `supabase/migrations/`, só existem manualmente aplicadas
      num cluster Postgres local separado (`.localdev/pgdata_financeiro_20260908`,
      fora deste repositório versionado — ver comentário em
      `scripts/tests/collection/pgcompat-embed-fkey-financeiro.test.mjs`).
      `npm run db:local:reset` no cluster padrão NÃO recria essas 4
      functions/tabela — os testes que dependem delas
      (`financeiro-controle-acesso.test.mjs`,
      `pgcompat-embed-fkey-financeiro.test.mjs`) só passam contra aquele
      cluster exclusivo, não contra um `db:local:reset` do zero. Mesmo
      tratamento que `fn_sincronizar_baixa_legado` recebeu aqui: versionar a
      partir da definição real via `pg_get_functiondef`/`pg_proc` antes de
      mexer no fluxo de baixa manual/estorno.

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
