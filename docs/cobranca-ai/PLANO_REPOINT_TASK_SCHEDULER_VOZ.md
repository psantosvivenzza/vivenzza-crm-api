# Plano seguro — apontamentos desatualizados do Task Scheduler de voz

**Status: documento de planejamento. Nada aqui foi executado.** Task
Scheduler, flags de produção e o checkout principal (`correcao-testes-
pendurados-20260922`, com WIP não commitado) não foram tocados.

## Diagnóstico (confirmado ao vivo, 2026-09-24, leitura read-only via
`Get-ScheduledTask`/`Get-ScheduledTaskInfo`)

As duas tarefas do Agendador do Windows relevantes para a fila de cobrança
por voz apontam para dois lugares **diferentes e ambos problemáticos** —
nenhum dos dois é um checkout estável rastreando `origin/main`:

| Tarefa | Aponta para | Problema |
|---|---|---|
| `VivenzzaAncoraWslAsteriskVoz` | `C:\Users\msi\Projeto Claude Code\vivenzza-crm-api\scripts\voice\ancora-wsl-asterisk.ps1` (checkout **principal**) | O checkout principal está com `HEAD` na branch `correcao-testes-pendurados-20260922`, **55+ commits atrás de `origin/main`** e com WIP não commitado. Essa cópia do script **não tem** o fix de resiliência da PR #127 (commit `d579047`, merge `29907f3`, 24/09 15:43) — confirmado: a tarefa falhou de novo hoje às 15:45 (`LastTaskResult=1`), **depois** do merge da PR #127, porque o merge nunca chegou nesse arquivo em disco. |
| `VivenzzaFilaCobrancaVoz` | `...\vivenzza-crm-api\.claude\worktrees\recuperacao-voz-asterisk-scheduler-20260921\fila-cobranca-voz.bat` (worktree de revisão **descartável**, branch da PR #124, já mergeada) | Esse worktree tem HEAD em `8007dc2` (21/09) — **antes** das PRs #124, #125, #126 (âncora permanente WSL2/Asterisk), #128, #129, #130. A boa notícia: a integração do `collectionGuardsForVoice.js` (PR #123, `0aaa6b1`) **já está presente** nessa cópia — confirmado por leitura direta do arquivo. O risco aqui é só drift de funcionalidades futuras, não de guard de cobrança. |

Ou seja: **o guard de cobrança (pagamento/promessa/DNC) já protege as
ligações reais de produção hoje**, porque está presente tanto em
`origin/main` quanto na cópia que `VivenzzaFilaCobrancaVoz` de fato executa.
O risco real e já **confirmado ao vivo** é o apontamento da âncora
(`VivenzzaAncoraWslAsteriskVoz`), que está rodando uma versão do script sem
o fix de resiliência da PR #127 — cada falha de timeout do PowerShell
continua derrubando a âncora com stack trace cru em vez de logar e
encerrar como a PR #127 corrigiu.

## Por que isso aconteceu

Nenhum dos dois apontamentos foi pensado como "local permanente de
deploy". Ambos nasceram de sessões de correção pontuais que usaram o
checkout/worktree que tinham à mão no momento e nunca foram atualizados
depois que o trabalho foi mergeado — o padrão observado neste repositório
é: corrigir num worktree de revisão → abrir PR → mergear em `origin/main`
→ **esquecer de repointar o Task Scheduler para a nova referência**. O
próprio repositório já tem o hábito de fazer backup do XML antes de
repointar (`scripts/_backup_task_VivenzzaFilaCobrancaVoz_before_worktree_
repoint.xml`, `docs/cobranca-ai/VivenzzaFilaCobrancaVoz-backup-20260921-
201800.xml`) — falta um passo final de "trocar de volta para um lugar
estável" depois que a correção vira PR mergeada.

## Plano proposto (não executar sem aprovação explícita do usuário)

### 1. Criar um checkout dedicado e estável para produção

Um diretório separado do checkout principal (que é o espaço de trabalho
interativo, com WIP frequente) e separado de qualquer worktree de
revisão/PR (que é descartável por natureza). Sugestão:

```
C:\Users\msi\Projeto Claude Code\vivenzza-crm-api-producao-voz\
```

criado com `git worktree add` (mesma mecânica já usada pelos worktrees de
revisão) a partir de `origin/main`, numa branch dedicada só para isso
(ex.: `producao/voz`, sempre fast-forward, nunca com commits próprios).

### 2. Processo de atualização depois de cada merge relevante

```powershell
cd "C:\Users\msi\Projeto Claude Code\vivenzza-crm-api-producao-voz"
git fetch origin
git merge --ff-only origin/main   # falha alto e visível se não for fast-forward
npm install                       # só se package.json/package-lock mudou
```

Rodar isso manualmente (ou como parte do checklist de "mergear PR de voz")
depois de cada PR relevante mergeada — não automatizar sozinho sem
aprovação, já que isso troca o código que efetivamente disca.

### 3. Backup antes de repointar (mesmo padrão já usado no repo)

```powershell
schtasks /query /tn "VivenzzaFilaCobrancaVoz" /xml > docs\cobranca-ai\VivenzzaFilaCobrancaVoz-backup-<data>.xml
schtasks /query /tn "VivenzzaAncoraWslAsteriskVoz" /xml > docs\cobranca-ai\VivenzzaAncoraWslAsteriskVoz-backup-<data>.xml
```

### 4. Repointar as duas tarefas (mudança operacional — requer aprovação ao vivo do usuário no momento)

- `VivenzzaAncoraWslAsteriskVoz`: trocar a `Action` para apontar
  `ancora-wsl-asterisk.ps1` dentro do novo checkout dedicado
  (`vivenzza-crm-api-producao-voz`), não mais o checkout principal.
- `VivenzzaFilaCobrancaVoz`: trocar a `Action`/`WorkingDirectory` do
  `fila-cobranca-voz.bat` para o mesmo checkout dedicado, não mais o
  worktree de revisão `recuperacao-voz-asterisk-scheduler-20260921`.

Usar `instalar-ancora-wsl-asterisk.ps1` (idempotente, já documentado em
`docs/cobranca-ai/ANCORA_WSL_ASTERISK.md`) para a âncora; para a fila,
editar a `Action`/`WorkingDirectory` da tarefa existente (via
`Set-ScheduledTask`/`schtasks /change`) preservando todos os gatilhos,
`Principal` e condições atuais (inclusive `DisallowStartIfOnBatteries`,
cuja regra em si é uma decisão separada do usuário — ver
[[project_vivenzza_pr127_resiliencia_voz_pendente]]).

### 5. Validar antes de deixar o gatilho automático disparar de verdade

1. Rodar manualmente, no novo checkout, `node scripts\voice\rodar-fila-
   cobranca.mjs` **sem** `--confirm` (dry-run) — confirma que lê envs,
   Supabase e a fila corretamente a partir do novo caminho.
2. Rodar `ancora-wsl-asterisk.ps1` manualmente uma vez fora da janela de
   discagem, conferir o log (`logs\ancora-wsl-asterisk.log`).
3. Só depois disso, deixar o próximo disparo agendado (natural, não
   forçado) validar o caminho ponta a ponta.

### 6. O que este plano explicitamente NÃO faz

- Não altera `voice_external_enabled`, allowlist, limites globais ou
  qualquer outra flag de `automacoes_config`.
- Não mexe no checkout principal (`correcao-testes-pendurados-20260922`)
  nem descarta/commita o WIP que está lá.
- Não desabilita nem reabilita nenhuma tarefa agendada por conta própria —
  cada repoint fica pendente de aprovação ao vivo do usuário no momento do
  comando (mesmo classificador de "Irreversible"/"mudança operacional" já
  registrado em [[feedback_gh_pr_merge_bloqueado]] para merges de PR).
- Não decide sozinho a regra `DisallowStartIfOnBatteries` nem o registro
  NVOIP — ambos continuam gates separados, do usuário.

## Referência rápida do estado no momento deste diagnóstico

```
VivenzzaAncoraWslAsteriskVoz  → scripts\voice\ancora-wsl-asterisk.ps1 (checkout principal, stale)
                                 LastRunTime 24/09 15:45, LastTaskResult=1 (falha, mesmo bug pré-PR#127)
VivenzzaFilaCobrancaVoz       → .claude\worktrees\recuperacao-voz-asterisk-scheduler-20260921\fila-cobranca-voz.bat
                                 LastRunTime 24/09 17:00, LastTaskResult=1 (pré-voo abortou, fail-closed — nenhuma ligação feita)
```
