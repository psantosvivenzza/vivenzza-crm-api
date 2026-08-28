# Cobrança via WhatsApp

## Estado atual (confirmar contra `automacoes_config` real antes de agir)

- `cobranca_whatsapp_ativa=true`
- `multi_whatsapp=true`
- `whatsapp_failover=false` — **nunca ativar sem autorização explícita**.
- Limites globais: **10/hora**, **30/dia**.
- Cadência entre mensagens: 45–90s (aleatório).
- No máximo 1 mensagem por telefone por dia.
- Janela permitida: 08h–17h, dias úteis.

## Instâncias financeiras

- `vivenzza-financeiro` (principal).
- `vivenzza-financeiro-reserva-01` (reserva, priority=2).
- `vivenzza-financeiro-reserva-02` — criada na Evolution, webhook já
  configurado (mesmo padrão das outras duas), **pendente leitura do QR
  code pelo operador**. Enquanto não `connected`, **não cadastrar/ativar**
  como reserva operacional em `whatsapp_instances` (a lógica de seleção já
  é genérica para N instâncias — nenhuma mudança de código é necessária
  quando isso acontecer).
- Instâncias **comerciais nunca entram no pool financeiro** — segregação é
  by design (denylist), não uma convenção informal.

## Proteções do motor de cobrança (v2) — nunca regredir

- `paymentGuard` — reconsulta se o título já foi quitado antes de cada
  tentativa.
- `promessaAtivaPara` — nunca cobra um título com promessa de pagamento
  ativa.
- `timeline` — toda ação relevante (bloqueio, envio, falha) é auditável.
- DNC/opt-out (`collection_do_not_contact`) — checado antes de qualquer
  seleção de instância ou tentativa real.
- Idempotência global — `collection_dispatches.idempotency_key`, único por
  (título, etapa, dia BRT). Nunca duplica cobrança por retry/restart/duplo
  clique.
- `collection_dispatch_attempts` é a fonte de verdade de tentativa real ao
  provider — inclusive para o teto global (uma falha real também consome
  o limite, não só sucesso).

## Circuit breaker por instância — regra atual (desde a correção de 2026-08-27)

A saúde da instância (`consecutive_failures`/`cooldown_until`) só é afetada
por categorias que **provam problema da instância**, nunca por categorias
que são problema do **destinatário/dado**:

| Categoria | Afeta saúde da instância? |
|---|---|
| `PERMANENT_RECIPIENT` (número não registrado) | **Não** |
| `UNKNOWN` (sem evidência suficiente) | **Não** |
| `PLATFORM_RESTRICTION` (4xx ambíguo) | **Não** |
| `RATE_LIMIT` (429) | Sim |
| `AUTH` (401/403) | Sim |
| Técnica inequívoca (timeout/5xx/conexão) | Sim |

Nunca reverter essa distinção — ela existe porque um lote de números ruins
já derrubou as duas instâncias financeiras em produção (achado real,
2026-08-27) sem que houvesse problema técnico algum.

## Quarentena de número inválido (PERMANENT_RECIPIENT) — 30 dias

- Um telefone confirmado pelo provider como não registrado no WhatsApp
  entra em quarentena de **30 dias** (`collection_do_not_contact`,
  `motivo=numero_invalido_whatsapp`, `expira_em = now() + 30 dias`).
- Nunca vira bloqueio permanente automaticamente — reincidência não
  escala sozinha. Só renova por mais 30 dias se uma **nova falha real do
  provider** confirmar de novo, depois que a quarentena anterior expirou.
- Opt-out permanente (`expira_em IS NULL`) **nunca é sobrescrito** por essa
  lógica — nunca convertido em temporário, nunca encurtado.
- Telefone novo/corrigido **nunca herda** a quarentena do telefone antigo —
  a chave é o telefone (dígitos), não o cliente.

## Seleção do telefone de cobrança (desde 2026-08-27)

Prioridade determinística ao escolher qual contato do cadastro vira
`telefone_cobranca`: **celular > fone/telefone > contato genérico**.
Dentro do mesmo grupo, preserva a primeira ocorrência do array original.
Nunca infere se um número tem WhatsApp — só decide qual contato existente
usar.

## Fila de revisão cadastral

Tela `/revisao-contatos` (Financeiro) + `GET /api/collection-contact-review`
— lista clientes com telefone confirmado como `PERMANENT_RECIPIENT`, para o
Financeiro corrigir o cadastro **no NetVision** (nunca edição direta no
CRM). O próximo sync financeiro real traz o telefone corrigido
automaticamente.
