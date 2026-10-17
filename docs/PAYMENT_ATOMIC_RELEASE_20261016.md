# Reconciliação atômica — pacote isolado para revisão

## Escopo e dependências

Preparação local em 16/10/2026 sobre `f8c2696` (PR146, que depende da
PR145). Reaproveita exclusivamente os adaptadores, a migration e o harness
do pacote local `da0ee04`; não incorpora o bundle de vendas/NetVision,
alterações de frete ou resultados históricos de outras execuções.

`cancelarAutomacaoPorPagamento` e `marcarPromessaCumprida` passam a chamar
RPCs transacionais: transições e seus eventos são confirmados juntos ou
desfeitos juntos. Não há fallback para a sequência não atômica. Preserva
DTOs, motivos, origens, atualizações condicionais e o contrato de PAGO
somente para quitação real. Não altera saldo, histórico antigo, contatos,
limites, DNC ou flags operacionais.

A migration existente `20261015180229_collection_payment_atomic.sql` foi
transplantada sem alterar seu payload: SHA256
`809aa2bde4af4746e535d73d524c4b577b8e9f659dd8e5f5412f372513a98972`.
O manifesto preserva a proveniência da preparação anterior, não descreve
uma execução do CLI nesta rodada. Nenhuma migration remota foi aplicada.
As funções são SECURITY INVOKER e apenas service_role recebe EXECUTE;
não são alterados grants/RLS das tabelas existentes.

## Verificação fresca

- 73/73 testes unitários: `financial-guards-regression.test.mjs`,
  `payment-atomic-rpc.test.mjs` e `payment-reconciliation-job.test.mjs`. Resolução de pacotes existentes via
  `VIVENZZA_TEST_PACKAGE_JSON`; nenhum .env ou serviço externo carregado.
- 33/33 critérios PostgreSQL/HTTP nas execuções v1 e v2, preservadas
  somente localmente. Resultado final v3: 33/33, HTTP fechado e PostgreSQL
  encerrado; caminho da estação redigido no artefato publicado em
  `docs/proposals/payment-atomic-results-release-20261016-v3.json`.
  Inclui rollback em falha de ambos os eventos, concorrência real em duas
  conexões, idempotência, isolamento, ACL, fila opcional e Router/auth/job
  reais. Caso adicional comprova timeout de lock `55P03`, estado intacto e
  recuperação sem duplicação após liberar o lock.
- Harness cria pasta de cluster nova por execução, recusa reutilização,
  usa SOMENTE PostgreSQL em 127.0.0.1:15579 e HTTP loopback efêmero. Sockets
  fora da allowlist e fetch externo são bloqueados. HTTP fechado e
  PostgreSQL encerrado no finally, com confirmação no relatório.

Reprodução no workspace Vivenzza, com o runtime PostgreSQL e dependências
locais já existentes (não instala nem baixa pacotes):

```powershell
$env:VIVENZZA_TEST_PACKAGE_JSON=Join-Path (Split-Path (Get-Location)) 'vivenzza-crm-api/package.json'
node --test scripts/tests/unit/financial-guards-regression.test.mjs scripts/tests/unit/payment-atomic-rpc.test.mjs scripts/tests/unit/payment-reconciliation-job.test.mjs
$env:VIVENZZA_ATOMIC_RUN='identificador-novo-e-exclusivo'
node scripts/tests/unit/payment-atomic-cluster.mjs
```

## Não publicado — gates obrigatórios

Não fazer merge/deploy automático deste pacote. A API depende das funções:
publicar adaptadores antes da migration causa indisponibilidade da
reconciliação. Confirmar backup recuperável, schema/major/grants/RLS do
alvo e autorização específica; coordenar drenagem de todos os executores
antigos, aplicar funções antes dos adaptadores, conferir cache PostgREST e
probes autorizados. Não usar `db push` amplo nem aplicar outras migrations
pendentes por inferência. Nenhuma recuperação retroativa de eventos perdida
está incluída. Rollback de código para a implementação anterior reintroduz
a falha conhecida e também precisa de coordenação.

Esta evidência é LOCAL e sintética, não valida PostgREST servidor real,
produção, todos os crons ou a suíte completa collection/dispatch. A
equivalência numeric/Number em extremos de precisão não foi demonstrada.
Revisão crítica do Claude é obrigatória antes de concluir a entrega.

## Tratamento da revisão crítica

Primeira revisão Claude, exit 0: sem bug de lógica bloqueante; os riscos de
publicação abaixo mantêm o pacote em DRAFT, sem autorização para merge.

1. A migration preservada tem timestamp anterior às migrations de frete
   `20261015183819` e `20261015194843`. CLI Supabase não foi encontrado
   no PATH nem no runtime local inspecionado. Resolver ordenação pelo
   procedimento suportado antes da promoção; não inventar outro timestamp,
   instalar CLI ou rodar push abrangente silenciosamente. O checksum do SQL
   é do conteúdo: renomear sozinho não altera esse hash, mas exige atualizar
   manifesto, atributo LF, referências e repetir a homologação.
2. Atomicidade é uma decisão explícita deste desenho: uma falha persistente
   de auditoria também desfaz cancelamentos. As pendências permanecem para
   retry e o guard de pagamento segue obrigatório antes de cada tentativa
   real. O job agora emite código e contagens sanitizadas, preservando a
   exceção. Configurar monitoramento operacional desse sinal e aprovar o
   trade-off antes de produção; não foi criado envio de alerta externo.
3. O lock de linha também cobre títulos ainda abertos, evitando decisão
   baseada em estado desprotegido. Espera limitada a 5s, contenção e retry
   testados. Medir impacto no sync no ambiente autorizado antes do rollout;
   não alegar ausência de impacto de desempenho em produção.
4. Depois de aplicar funções, exigir reload do cache (`NOTIFY pgrst,
   'reload schema'`) e probe antes dos adaptadores. BEGIN/COMMIT impede
   criação parcial nesta migration: CREATE sem OR REPLACE é deliberadamente
   fail-closed contra sobrescrita. Não reaplicar cegamente após resultado
   desconhecido. Em rollback coordenado, preservar funções inertes em vez
   de excluir objetos; nenhum DROP automático autorizado.
5. Testes internos substituídos por contrato RPC não são cobertura
   equivalente; o harness PostgreSQL/HTTP passa a ser gate manual obrigatório
   além dos unitários. Não há pipeline CI configurado neste repositório.
6. O baseline reproduz somente os campos e constraints usados, não triggers,
   grants e RLS reais. A guarda de sockets/fetch é defesa adicional do
   harness, não isolamento de sistema operacional nem prova de produção.

O teste `payment-reconciliation-job.test.mjs` cobre retorno bem-sucedido,
propagação da falha parcial e ausência de detalhes sensíveis nos logs.

## Preflight remoto somente leitura — 16/10/2026 23:38 UTC

Conexão selecionada explicitamente: Supabase — Vivenzza, projeto
`vkncsyhugotyfwmxpzgq`. Não foi usada a conexão Unhas de Guria.

PostgreSQL 17.6, READ COMMITTED, ambas as novas funções ausentes. As quatro
tabelas do pacote têm RLS habilitada, sem FORCE RLS; service_role tem
BYPASSRLS e SELECT/INSERT/UPDATE nas quatro tabelas. Isso não substitui
conferência integral de schema, triggers, backup recuperável ou probes.
O runtime sintético é 17.11, mesmo major, patch diferente não homologado
contra serviço real. Última migration registrada `20261016135055`:
confirma que a ordenação do arquivo preservado precisa ser resolvida.

A última sincronização financeira real continua concluída às 17:09 UTC,
com atraso de 389,9 minutos nessa leitura. É incidente externo separado
da atomicidade: este pacote não restaura rede, DNS ou acesso ao NetVision.
Nenhuma escrita em dados financeiros, função, migration ou configuração
remota ocorreu neste preflight.

Segunda revisão Claude, exit 0: nenhum bug de lógica bloqueante. Ajustes
de evidência: comando sem usuário local; relatórios v1/v2 não serão enviados
ao repositório; harness valida o caminho real, mas publica marcador redigido.
Na segunda revisão, o sinal ainda não distinguia as causas de falha; essa
pendência de diagnóstico foi tratada no incremento abaixo. Monitoramento
operacional permanece gate explícito antes de produção. FOR UPDATE pode
conflitar com KEY SHARE de FKs e triggers do sync; esse risco de contenção
e deadlock exige validação no ambiente autorizado, sem presumir paridade
do baseline parcial. Não foi alterado o SQL revisado nesta rodada.

## Incremento — classificação sanitizada de falhas

O job acrescenta `causas` ao log já existente: lista deduplicada e fechada
de classes operacionais, tanto para erro individual quanto para os erros
diretos de um AggregateError. Nunca expõe mensagem, detalhes, IDs, códigos
arbitrários ou a árvore bruta de causas. Erro desconhecido ou agregado vazio
produz `desconhecida`; a exceção original continua sendo propagada.

| Código reconhecido | Classe registrada |
| --- | --- |
| PGRST202 | rpc_indisponivel (função ausente ou cache/assinatura desatualizado) |
| 55P03 | timeout_lock |
| 25001 | contexto_transacao (estas RPCs exigem READ COMMITTED) |
| 40P01 | deadlock |
| 40001 | falha_serializacao |
| 42501 | permissao_negada |
| 42P01, PGRST204, PGRST205 | schema_incompativel |
| 57014 | consulta_cancelada |
| ECONNRESET, ETIMEDOUT, 08006 | conexao_indisponivel |
| 23514 | integridade_dados |
| P0001 | rejeicao_banco |

Allowlist propositalmente limitada; códigos não listados não são copiados
nem inferidos pela mensagem. Classes indicam a categoria, não provam a causa
raiz nem autorizam retry, correção de schema, ativação ou envio.

Reprodução inicial antes da implementação: 17 casos novos falharam por
ausência do campo de causas; os 3 testes anteriores ainda com suas asserções
originais passaram. A primeira implementação passou 20/20 do job e 67/67
financeiros. Revisão acrescentou deadlock, serialização e proteção contra
getters/logger lançando erro: cobertura final de 26 testes do job e 73 financeiros.
Casos incluem códigos arbitrários, `__proto__`, dados sensíveis sintéticos,
causas repetidas e agregado vazio. Falhas ao construir/gravar o diagnóstico
nunca substituem a exceção original; metadados ilegíveis viram desconhecidos.
Nenhum SQL, guard de pagamento, transição financeira ou flag foi alterado.
Referências primárias consultadas:
[PostgREST](https://docs.postgrest.org/en/stable/references/errors.html) e
[PostgreSQL](https://www.postgresql.org/docs/current/errcodes-appendix.html).

Revisão final Claude deste incremento: exit 0, sem bug bloqueante ou
regressão. Limites retidos: erros de rede sem `code` no nível direto (por
exemplo, código somente em `cause`) continuam desconhecidos; não inspecionar
mensagem ou árvore arbitrária para inferir conectividade. Um objeto com
getter inválido pode rebaixar todo o diagnóstico para o fallback genérico,
sem afetar a exceção original. Alertas devem contemplar ambos os códigos
de falha, não depender exclusivamente de PARTIAL_FAILURE.
