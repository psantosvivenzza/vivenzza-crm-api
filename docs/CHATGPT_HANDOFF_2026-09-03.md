# Vivenzza CRM — Handoff operacional/técnico
Data de referência: 2026-09-03

## Regra principal

O código em origin/main é a fonte de verdade técnica.

Este documento é contexto de continuidade, não deve prevalecer sobre código atual quando houver divergência.

Nunca inventar estruturas, flags ou regras sem confirmar no código/banco.

---

## Arquitetura

Backend:
- vivenzza-crm-api
- Node/Express
- Supabase/Postgres
- Railway

Frontend:
- vivenzza-crm-frontend
- React/Vite
- Vercel

NetVision:
- banco e01
- fonte oficial de verdade para domínios dependentes, incluindo telefone financeiro

Primitivos importantes:
- paymentGuard.js::tituloEstaQuitado
- promises.js::promessaAtivaPara
- timeline.js::registrarEvento

Cobrança:
- um job principal em cobranca-whatsapp.js::executarReguaCobranca()
- roteamento compartilhado por collectionRouting.js
- multi_whatsapp é a flag real usada
- NÃO assumir existência/uso de collection_engine_v2
- cobrança cron deve continuar automática
- não depender de botão/disparo manual diário

Janela:
- segunda a sexta
- 08:00–17:00 BRT

Limites:
- 45–90 segundos entre tentativas
- máximo 10 por hora
- máximo 30 por dia
- máximo 1 mensagem por telefone/dia

---

## WhatsApp financeiro

Instâncias financeiras conhecidas:

1. vivenzza-financeiro
2. vivenzza-financeiro-reserva-01
3. vivenzza-financeiro-reserva-02

A terceira:
- já foi criada na Evolution
- webhook configurado
- ainda NÃO está conectada por QR
- ainda NÃO deve ser registrada/ativada operacionalmente sem dispositivo físico disponível

Configuração conhecida:
- multi_whatsapp=true
- whatsapp_failover=false

Instâncias comerciais devem ficar fora da cobrança financeira.

Fallback:
- só para falhas técnicas explícitas
- não usar em pending/unknown
- 429 → cooldown
- 401/403/plataforma/recipient inválido → não fazer fallback
- limites globais continuam globais
- health/circuit é por instância

---

## Cobrança — estado atual

Cobrança automática está ATIVA.

Não desligar nem exigir toggle diário sem motivo de segurança real.

PRs importantes já concluídas:

- #44 consolidação mesmo cliente/vencimento
- #45 preservação sync financeiro
- #46 segregação WhatsApp financeiro x comercial
- #47 fallback instance_name
- #48 suppressão recipient inválido + DNC temporário
- #49 rate limit via collection_dispatch_attempts
- #50 worker resiliente de sync financeiro
- #54 testes N-instance
- #55 circuit breaker corrigido
- #57 quarentena de PERMANENT_RECIPIENT passou para 30 dias
- #58 prioridade de telefone celular > fone/telefone > contato
- #59 fila Revisão de Contatos
- #60 documentação/contexto
- #61 gitignore de backups .env
- #62 lifecycle pagamento/promessa
- #63 timeline financeiro
- #64 testes determinísticos
- #65 operador de promessa
- #66 dashboard recuperação
- #67 API operacional Revisão de Contatos
- #68 propagação de telefone oficial do NetVision para títulos existentes
- #69 correção de testes de data BRT
- #70 hardening de revalidação de DNC/pagamento/promessa antes de cada tentativa do loop de failover (mergeada em 2026-09-03, commit `01a13050f7e5f781d68a0e19cbaa2bdd242dfc91`)
- frontend #14 fluxo operacional Revisão de Contatos

---

## Revisão de Contatos

Backend #67:
- GET /api/collection-contact-review
- POST /api/collection-contact-review/:codigoCliente/acao
- ações auditáveis
- não altera telefone
- não altera DNC
- não envia WhatsApp

Tabela:
collection_contact_review_actions

Status manuais:
- revisado
- sem_contato_valido
- aguardando_atualizacao_origem

NetVision continua sendo a fonte oficial do telefone.

O telefone atualizado no NetVision chega ao CRM pelo sync financeiro natural.

Não usar PATCH financeiro de telefone como substituto do NetVision.

Frontend #14 já está em produção.

Limite correto do campo motivo:
- 500 caracteres

Não confundir com observação de promessa:
- 280 caracteres

---

## Sync financeiro

NetVision:
DESKTOP-Q6O54R1:5432
DB e01

Worker:
DESKTOP-L0ICI4A
usuário msi

Projeto:
C:\Users\msi\Projeto Claude Code\vivenzza-crm-api

Worker:
- sync incremental ~60s
- full ~30min
- watchdog via Windows Task Scheduler

COBRANCA_EXIGE_SYNC=true
máximo atraso permitido:
240 minutos

Quando PC do escritório estiver desligado à noite/viagem:
sync stale é esperado.

Não disparar sync manual sem necessidade.

---

## Financeiro

Conflitos históricos:
- existem títulos com em_revisao_financeira=true
- cobrança deve excluí-los

Nunca alterar automaticamente:
- pagamento
- status
- revisão financeira

Fonte real de pagamento:
saldo = valor - valor_pago

PAGO só pode ocorrer com baixa real.

Não atribuir causalidade entre cobrança e pagamento quando não existir vínculo técnico.

Dashboard usa:
"Recebido no período"
e não
"Valor recuperado pela cobrança".

---

## Promessas

Endpoints operador já implementados.

Mutations:
adminOnly

Regras importantes:
- não criar promessa para título pago/cancelado/revisão
- máximo 90 dias
- observação máximo 280
- substituição explícita
- concorrência tratada
- PAGO nunca inventado

Payment reconciliation:
- sweep 15min

Promise expiry:
- diário 07:50 BRT

---

## Auditoria operacional de 2026-09-03

Snapshot:

- 1.210 títulos abertos
- 894 vencidos
- R$273.059,88 vencidos
- 219 clientes
- 563 títulos estruturalmente elegíveis
- 160 clientes elegíveis
- R$194.691,86 elegíveis

Principais bloqueios:

DNC quarentena:
- 215 títulos
- 41 clientes
- ~R$55 mil

Revisão financeira:
- 102 títulos
- 83 clientes
- ~R$17,6 mil

Sem telefone:
- 14 títulos
- 7 clientes
- ~R$5,8 mil

Promessas ativas:
- 0 naquele snapshot

Opt-out permanente:
- 0 naquele snapshot

---

## Performance WhatsApp observada

7 dias:
- 130 tentativas
- 81 sent
- 72 delivered
- 35 read
- 49 falhas

30 dias:
- 449 tentativas
- 224 sent
- 151 delivered
- 81 read
- 225 falhas

Falhas 30d:
- 100% PERMANENT_RECIPIENT
- 0 rate limit externo
- 0 401/403
- 0 timeout
- 0 5xx

Conclusão:
gargalo principal observado é qualidade/cadastro de telefone, não infraestrutura.

---

## Investigação dos 51 supostos bypasses de DNC

Auditoria inicial encontrou:
- 51 tentativas
- 27 telefones
aparentemente posteriores a DNC válido.

Investigação posterior provou:
- bypass verdadeiro = 0

Causa:
- regra antiga de quarentena até meia-noite BRT
- antes da PR #57
- PR #57 já mudou para 30 dias

Portanto:
NÃO existe evidência de leak-through atual nesses 51 casos.

---

## PR #70

Branch:
fix/collection-dnc-provider-revalidation (deletada após merge)

Objetivo:
hardening preventivo.

Descobertas reais:

1. lookup DNC comparava telefone por string exata
2. loop de failover não revalidava todos os guards entre tentativas

Produção atualmente:
whatsapp_failover=false

Correção da #70:
- revalidar pagamento
- revalidar promessa
- revalidar DNC
antes de cada iteração real do failover

Também:
- normalização canônica segura para lookup DNC

Testes:
- 14 novos
- suíte completa 647/647
- rodada 1 PASS
- rodada 2 PASS

Nenhuma migration.

**Status atual (2026-09-03): PR #70 já foi revisada, validada e mergeada
(squash) em main — commit `01a13050f7e5f781d68a0e19cbaa2bdd242dfc91`. Deploy
no Railway confirmado SUCCESS/RUNNING nesse commit exato, `/health` = 200.
Nenhuma mutation de produção, DNC ou envio de WhatsApp foi feita durante essa
validação — tudo read-only até a decisão explícita de merge.**

ANTES DE FAZER QUALQUER COISA relacionada a este tópico em uma sessão futura:
consultar estado atual do `origin/main` e do histórico de PRs no GitHub.
Não assumir que este status continua o mesmo — pode ter avançado.

---

## D61+

Snapshot mostrou:

D61+:
- 847 títulos
- 196 clientes
- R$243.903,89

Representava cerca de 89% do valor vencido.

Isso é problema de estratégia de recuperação, não bug da régua.

Não tentar resolver simplesmente aumentando frequência de WhatsApp.

Possíveis frentes futuras:
- acordos
- segmentação
- negativação
- jurídico
- régua específica para dívida muito antiga

Qualquer mudança deve ser decidida como regra de negócio.

---

## Revisão de Contatos — operação

Fila no snapshot:
- 44 clientes pendentes
- ~R$111,5 mil
- 42/44 sem alternativa cadastrada
- 0 revisados naquele momento

A tela deve ser usada pelo financeiro como rotina operacional.

Fluxo:
1. verificar contato
2. corrigir no NetVision quando necessário
3. marcar acompanhamento na tela
4. aguardar sync natural
5. telefone novo não herda DNC do antigo

---

## Migrações Supabase — ALERTA IMPORTANTE

Foi descoberto drift entre:

- arquivos versionados em supabase/migrations
- migration history do Supabase
- objetos realmente existentes em produção

Exemplo:
migration da collection_contact_review_actions existia no Git,
mas não tinha sido aplicada em produção.

Foi aplicada manualmente depois, usando a migration versionada.

NÃO executar automaticamente todas as migrations "faltantes".

Próxima frente técnica importante:
auditar formalmente o estado das migrations.

Precisamos classificar cada migration como:
- aplicada oficialmente
- aplicada manualmente
- objeto equivalente já existe
- realmente ausente
- conflitante

Somente depois criar um pipeline seguro.

---

## Fiscal / vendas

Série 99:
- venda gerencial/comercial real
- NÃO é NF-e SEFAZ

Gerencial inclui série 99.
Fiscal exclui série 99.

Fonte NetVision:
EN_NotasRepres

Certificado fiscal:
- configurado corretamente
- não expor senha/path sensível
- NF-e real continua controlada
- serie1_numeracao_liberada=false

Não ligar emissão real sem autorização explícita.

---

## Voice

Asterisk local funciona.

Voice externo continua OFF.

Plano futuro:
servidor da empresa + gateway celular/SIM dedicado,
evitando custo por minuto.

Não ativar PSTN/Twilio sem decisão explícita.

PR #43 relacionada a Twilio/readiness:
não apagar nem alterar sem decisão explícita.

---

## Segurança operacional

Nunca:

- inventar pagamento
- marcar título pago por inferência
- alterar financeiro automaticamente
- contatar título em revisão financeira
- contatar promessa ativa
- contatar DNC válido
- expor telefone completo em relatórios
- expor secrets
- expor senha de certificado
- usar git clean
- apagar untracked locais
- conectar terceira instância sem hardware
- habilitar failover sem decisão
- disparar cobrança real como smoke test

Preferir validações read-only em produção.

---

## Git / ambiente

Backend pode conter arquivos untracked legítimos.
Preservar.

Frontend possui workarounds locais/untracked:
- deploy-shim.mjs
- dns-patch.cjs

Preservar.

Não usar git clean.

---

## Ordem recomendada de próximos trabalhos

Antes de iniciar, verificar estado REAL atual do main e das PRs.

Prioridades:

1. confirmar estado/merge da PR #70
2. usar operacionalmente Revisão de Contatos
3. auditar drift/pipeline de migrations Supabase
4. decidir estratégia para D61+
5. depois melhorias administrativas/observabilidade
6. terceira instância WhatsApp somente quando houver hardware
7. voz externa posteriormente

---

## Princípio de trabalho

Antes de modificar:

1. verificar origin/main
2. verificar produção
3. reproduzir problema
4. separar fato de hipótese
5. fazer mudança mínima
6. adicionar teste
7. rodar suíte
8. PR separada
9. não mergear automaticamente quando houver risco financeiro/comunicação

Cobrança automática deve permanecer ativa salvo risco comprovado.

---

Fim do handoff.
