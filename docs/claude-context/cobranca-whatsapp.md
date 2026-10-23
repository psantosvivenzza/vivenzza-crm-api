# Cobrança via WhatsApp

## Estado atual (confirmar contra `automacoes_config` real antes de agir)

- `cobranca_whatsapp_ativa=true`
- `multi_whatsapp=true`
- `whatsapp_failover=false` — **nunca ativar sem autorização explícita**.
- Limites de cobrança autorizados em 19/10/2026: **10/hora**, **50/dia**.
- Frete tem orçamento independente: uma tentativa a cada **60 segundos**,
  garantida no banco entre réplicas. Solicitações e respostas do assistente de
  frete não consomem os limites de cobrança, mesmo usando o número financeiro.
  Saúde da instância, DNC, consentimento e restrições do provedor permanecem.
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

## Assistente de frete — menus (19/10/2026)

Menus de transportadoras não são pedidos de atendimento financeiro: escolher
somente uma opção inequívoca de cotação/orçamento de frete, comercial ou
atendimento ao cliente. Menus ambíguos e listas de perguntas não autorizam
seleção. Avisos automáticos de ausência aguardam; recusa, mídia, encerramento,
proposta e pedido humano explícito exigem revisão. Não retomar menus expirados.
Pares repetidos de menu/resposta pausam para impedir loops entre bots.
O teto transacional de 24 respostas por conversa, DNC, consentimento, pausa humana e
cadência independente de 60s continuam vigentes. Nunca contratar, agendar
coleta, pagar, abrir links ou inventar dados para concluir uma cotação.

### Captura textual de propostas de frete

Preço/protocolo explícitos de frete podem preencher campos vazios usando a RPC
existente e CAS por versão, inclusive se a consulta foi pausada automaticamente.
Nunca sobrescrever preço/protocolo já gravados nem marcar completa sem confirmação.
Preservar observações, prazo e validade. Valor da mercadoria, preço unitário,
seguro, acréscimos e texto ambíguo não autorizam preencher o total do frete.
Falha persistente de gravação pausa para revisão e deixa alerta sanitizado no log.
Anexos não são interpretados pelo extrator textual; não converter '[mídia]' em valor.

### Continuidade e anexos — autorização humana de 19/10/2026

Propostas em andamento guardam preço, prazo em dias úteis e validade explícita
em mensagens separadas, com versão e referência à mensagem fonte por campo.
A IA pede somente pendências; proposta parcial não exige pausa humana. Completar
exige os três campos e confirmação textual de todas as taxas, validade futura,
e nenhum campo pendente de confirmação de OCR. Nunca contratar ou agendar.
Recusas, opt-out, ambiguidade contratual, intervenção humana e loops continuam
parando o fluxo; não despausar a carteira automaticamente.

PDF até8MB e PNG/JPEG até5MB são preservados em frete_anexos (RLS e acesso
somente service_role). API de download exige admin/financeiro, no-store e attachment.
Não há URL pública ou navegação por links de transportadora. Download usa apenas
chave de mensagem na instância Evolution financeira; nunca URL/mediaKey recebida.
OCR não executa ferramentas nem fornece resposta livre: campos são parciais e
precisam de confirmação textual. Arquivo ilegível pede os dados em texto.
Áudio/vídeo e formatos desconhecidos não são baixados para extração documental.
Menus listMessage/buttonsMessage são conteúdo visível, não anexos; IDs não são
executados. Nome solicitado recebe identidade verdadeira de assistente Vivenzza.

## Fila de revisão cadastral

### Formulários progressivos de frete (19/10/2026)

Campos isolados usam o cadastro: documento/CEP por papel; peso escalar só total,
medidas só com unidade e grupos compatíveis; valor declarado da carga para
estimativa (não leitura de NF, tributos ou emissão fiscal). Município exige campo
estruturado, nunca inferência de número/bairro. UF do atendimento inicial usa
o local de retirada, sem mudar origem/destino. Seleção de coleta só no menu
específico que declara não gerar coleta automaticamente: estimativa porta a porta
dos endereços solicitados, sem agendar nem contratar. Outras confirmações pausam.
Intervenção humana marca ator humano_whatsapp, impede importar preço posterior
de outro frete; eco automático é reconhecido em até100reservas, não só20.
Regressão atravessa entrada→RPC→worker sintético→proposta completa no Postgres local.

Tela `/revisao-contatos` (Financeiro) + `GET /api/collection-contact-review`
— lista clientes com telefone confirmado como `PERMANENT_RECIPIENT`, para o
Financeiro corrigir o cadastro **no NetVision** (nunca edição direta no
CRM). O próximo sync financeiro real traz o telefone corrigido
automaticamente.
