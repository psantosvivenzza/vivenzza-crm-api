# Campanhas — revisão persistente somente decisão (incremento 3)

Incremento original local, sem deploy nem alteração de env, flags, credenciais ou cron. Nesta branch de release, o SQL de Campanhas continua candidato em scripts/sql, fora de supabase/migrations; a migration de CNPJ do frete já aplicada foi preservada. `src/index.js` continua montando `createCampaignReviewRouter()` sem composição: produção responde 503 (fail-closed).

## O que está pronto para configuração

- `createCampaignReviewWorkflow` (`src/lib/campaignApproval.js`): propor, aprovar, rejeitar, consultar e listar. **Não possui execução** (`capabilities.execute = false`, sem método `execute`) e recusa qualquer `adapter`. Reusa o mesmo núcleo, hash canônico, validade, CAS, política do servidor e ator do JWT do workflow sintético.
- `createCampaignReviewComposition({ db, policy })` (`src/lib/campaignReviewComposition.js`): monta store PostgreSQL (`campaign_review.proposals`, SQL candidato em `scripts/sql/campaign_review_proposals_candidate.sql`) + workflow de revisão + intake manual. Recebe pg já configurado e política do chamador; não lê env nem credenciais; recusa adapter.
- Router (`src/routes/campaign-reviews.js`): modo `review` informa `capabilities { execute: false, intake: true }` e `consultadoEm`. `POST /:id/executar` em modo revisão responde 409 `EXECUCAO_DESABILITADA_MODO_REVISAO` antes de tocar workflow/store — testado com POST direto: linha, revisão e histórico idênticos.
- Contrato v2: `origin { kind: manual|synthetic, verified: false }` dentro do payload (hash + imutável pelo trigger). Origem verificada é recusada até existir leitor real.
- Intake `POST /propostas`: o navegador envia só alvo, ação, antes/depois, objetivo, motivo e o que observou. Servidor define origem manual não verificada, fonte, horário de registro e validade (`maxEvidenceAgeMs`). Campos extras → 400. Escopo e limites da política continuam obrigatórios.
- Homologação: `node scripts/campaign-review-homologation.mjs ID-NOVO --policy scripts/fixtures/campaign-review-homologation-policy.json [--check]` — mesmo router e composição, painel construído (`--reviews` no frontend), PostgreSQL exclusivo 15583, HTTP 5199, sem simulação/adapter/cron/index.js. Encerrar com `stop-preview` ou SIGINT.

## Origem das propostas

Não há avaliação IA nem leitor verificado de configuração Ads no código: `routes/campanhas.js` e `routes/google-ads.js` leem métricas/status, não orçamento diário nem moeda da campanha; `metaAdsGuardClient` é do job operacional de proteção e não foi reutilizado. Por isso o único intake oferecido é o registro manual de revisão humana, sempre exibido como não verificado. Fixture sintética continua exclusiva do preview/testes (`scripts/lib`).

## Execução futura — NÃO implementada nem ativada

Uma execução real só poderá existir com autorização vinculada a: plataforma, conta, campanha, ação, antes/depois, moeda, limites, hash do conteúdo, validade e ator humano. Antes de escrever: releitura verificada da fonte no provedor imediatamente antes (estado igual ao "antes"), identidade da conta conferida, CAS da proposta, escrita idempotente e readback; resultado incerto vira `inconclusiva`, sem retry, e bloqueia o alvo até reconciliação somente leitura.

Acessos e contratos reais que faltam para ajustar anúncios após aprovação:
1. Leitor verificado de configuração: Meta `daily_budget`/`status`/moeda da campanha (ou ad set, conforme o orçamento) e Google `campaign_budget.amount_micros`/`campaign.status`/moeda da conta, com conversão de unidades (centavos × micros) testada.
2. Escritor por provedor com idempotência e erro tipado. Permissões reais das credenciais existentes não foram consultadas nem validadas: o código já contém funções de escrita (guard Meta, `gadsMutate`), mas presença de configuração não prova escopo efetivo. Falta confirmar autorização e escopo para uso neste novo executor, além dos contratos/adaptadores.
3. Política real aprovada pelo responsável: contas, campanhas, ações, tetos e variação máxima.
4. Aplicação produtiva do SQL candidato depende de autorização explícita de schema e de migração versionada própria; hoje ele existe somente nos clusters locais de homologação, fora do journal produtivo.
5. Reconciliação de `em execução`/`inconclusiva` somente leitura.
6. Composição de produção que injete store/política reais — decisão deliberada, fora deste incremento.

Nenhum teste deste incremento prova Ads ou IA reais.

## Testes

- `node --test scripts/tests/unit/campaign-review-only.test.mjs` (store em memória).
- `node scripts/tests/unit/campaign-review-only-http.mjs ID-NOVO` — router + composição reais, PostgreSQL exclusivo 15582, rede restrita a loopback, cluster encerrado ao final. Relatório em `output/VIVENZZA_CAMPANHAS_REVIEW_ONLY_HTTP_<id>.json`.
- Regressão: `node scripts/tests/unit/campaign-review-http.mjs ID-NOVO` (15581).

## Release

O candidato original descendia de 750691b (VVZ-R01, relatório Meta → Sheets). Esta branch codex/campanhas-frete-release-20261015 foi recomposta sobre o frete publicado sem esse ancestral e sem delta nos três arquivos meta-report. O SQL de revisão permanece apenas candidato local; ativação produtiva exige autorização específica de schema, wiring e release. Contrato frontend/backend deve ser publicado coordenadamente; não habilitar execução Ads.
