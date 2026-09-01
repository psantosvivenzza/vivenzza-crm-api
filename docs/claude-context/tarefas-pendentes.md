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

- [ ] `fn_sincronizar_baixa_legado` (chamada por `sync-financeiro-legado.js`
      pra atualizar títulos existentes — cancelamento, encerramento,
      resolução de `em_revisao_financeira`) não tem migration correspondente
      em `supabase/migrations/` nem `migrations/`. Existe só no schema live
      do Supabase, aplicada manualmente em algum momento — não auditável via
      `git log`/`git blame`. Versionar a definição atual (via
      `pg_get_functiondef` ou equivalente) antes de qualquer alteração
      futura no fluxo de baixa financeira, pra não perder a única cópia
      existente da lógica real.

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
