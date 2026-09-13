# Auditoria adversarial — abuso, rate limiting e reautenticação (2026-09-12)

Continuação da fila de auditorias do piloto "Meu Ponto" (ver
`AUDITORIA_ADVERSARIAL_COMPONENTE_EQUIPAMENTO_2026-09-12.md`,
`AUDITORIA_SOLICITACOES_IDOR_2026-09-12.md`,
`AUDITORIA_CORRECOES_DUPLICACAO_2026-09-12.md`,
`AUDITORIA_FOTOS_HISTORICO_GESTAO_ADMIN_2026-09-12.md`,
`CORRECAO_UUID_MALFORMADO_20260912.md`). Esta rodada tem lente própria:
**abuso, rate limiting e reautenticação**, sobre a pilha combinada
`#78+#81+#82+#83+#84+#85`.

## 1. Metodologia

- Confirmado no GitHub (`gh pr list`) antes de montar qualquer coisa: `#78`
  (base `main`), `#81`/`#82`/`#83`/`#84` (todas base
  `codex/meu-ponto-backend-20260910`, ou seja, branches **irmãs**, não uma
  pilha linear entre si), `#85` (base = head de `#84`). Todas `MERGEABLE`,
  todas draft.
- Sessões concorrentes verificadas (`ListAgents`) — nenhuma sessão
  relacionada ao Meu Ponto estava `busy` no momento; todas `idle`/offline.
- Pilha combinada montada num worktree temporário isolado
  (`combined-ponto-audit-78-81-82-83-84-85`, a partir de
  `origin/codex/meu-ponto-backend-20260910` + merge de `#81`, `#82`, `#83`,
  `#85` — este último já traz `#84` por estar empilhado nele). Nenhum
  conflito de merge.
- Postgres exclusivo desta auditoria: `127.0.0.1:55491`, banco
  `meu_ponto_test`, data directory dentro do próprio worktree
  (`.localdev/pgdata`) — nunca `5432`/`5433`/`vivenzza_dev`, nunca
  produção, sem rede externa.
- Suíte completa (`npm run test:ponto`, processo por arquivo) rodada antes
  e depois da correção.

## 2. Escopo revisado

Todos os endpoints mutáveis/sensíveis dos três routers:

- `src/routes/ponto.js` — marcação, solicitação, correção, desafios de
  equipamento, fotos.
- `src/routes/ponto-gestao.js` — decisões (aprovação/rejeição), listagens
  com escopo de gestor, fotos.
- `src/routes/ponto-admin.js` — habilitações, gestores, equipamentos,
  config.
- `src/routes/ponto-equipamento.js` — vínculo de equipamento (única rota
  sem `auth`).

Dimensões testadas: brute force de senha, bypass de rate limit por
IPv4/IPv6/headers, limite por usuário vs. por IP, repetição concorrente,
payload grande/foto excessiva, abuso de leitura cara/exportação.

## 3. Achado corrigido nesta rodada

**`POST /api/ponto/correcoes` não tinha absolutamente nenhum limite de
taxa** — diferente de `/desafios`, `/marcacoes` e `/solicitacoes` (todas
com `limiteTentativasSensiveis`, 8/5min por usuário). A própria
`MATRIZ_AUTORIZACAO_ENDPOINTS.md` já documentava essa assimetria (coluna
"Trava adicional" vazia para `/correcoes`, preenchida para
`/solicitacoes`) sem nunca corrigi-la.

Impacto: um colaborador habilitado (`ponto_habilitacoes.habilitado=true`)
conseguia gerar volume **ilimitado** de solicitações de correção — cada
uma só precisa de um `operacao_id` novo (aleatório) para não colidir com a
idempotência — inundando a fila de revisão do gestor e a tabela
`ponto_correcoes` sem qualquer contenção. Não é um IDOR nem vazamento de
dados (o escopo por `usuario_id` já estava correto), é um vetor de abuso
puro: negação de serviço de baixo esforço contra a fila de revisão e o
banco.

### Correção aplicada

`src/routes/ponto.js`: novo limitador `limiteCriacaoCorrecao`
(`express-rate-limit`, 8 tentativas/5min, chave `req.user?.id` com
fallback `ipKeyGenerator(req.ip)` — mesmo desenho de
`limiteTentativasSensiveis`), aplicado só em `POST /correcoes`.

**Decisão de design**: orçamento PRÓPRIO, não reaproveita o contador de
`limiteTentativasSensiveis`. Motivo: `/correcoes` não exige `senha_atual`
(é um pedido por escrito sobre algo já confirmado, não uma alegação de
presença agora — ver comentário já existente no código) — compartilhar o
mesmo contador penalizaria injustamente um colaborador que só está
corrigindo registros antigos, bloqueando também suas tentativas
legítimas de `/marcacoes`/`/solicitacoes` sem relação alguma com o abuso
real. Verificado por teste dedicado (item 4 abaixo).

### Testes novos (`auditoria-rate-limit-correcoes-20260912.test.mjs`, 4/4 verde)

1. Mais de 8 tentativas em 5min do mesmo usuário → 429 a partir da 9ª.
2. Limite é por usuário, não por IP: dois colaboradores do mesmo processo
   de teste (mesmo IP) têm orçamentos independentes.
3. Esgotar `/correcoes` não consome nem bloqueia o orçamento separado de
   `/solicitacoes` do mesmo usuário (prova a decisão de design acima).
4. Rajada concorrente real (`Promise.all`, 12 chamadas simultâneas): nunca
   mais de 8 passam — descarta corrida no próprio contador do limitador.

## 4. Dimensões testadas sem defeito encontrado (evidência)

| Dimensão | Onde foi olhado | Resultado |
|---|---|---|
| Bypass de rate limit por header (`X-Forwarded-For` forjado) | `limiteTentativasSensiveis`/`limiteCriacaoCorrecao` usam `req.user?.id` como chave sempre que autenticado (é o caso de toda rota de `ponto.js` — `auth` roda antes) — o fallback por IP nunca é alcançado nessas rotas | Não há vetor de bypass por header nas rotas autenticadas: a chave nunca depende de `req.ip`/`X-Forwarded-For` quando há usuário logado |
| Bypass de rate limit por IPv4/IPv6 na única rota sem auth (`POST /api/ponto-equipamento/vincular`) | `limiteVinculo` usa `ipKeyGenerator(req.ip)`; `src/index.js` tem `app.set('trust proxy', 1)` — 1 hop, compatível com a topologia de proxy único do Railway. `ipKeyGenerator` normaliza IPv6 por prefixo /56 (recomendação oficial do `express-rate-limit`), evitando que variação de endereço dentro do mesmo /56 burle o limite | Configuração correta para exatamente 1 proxy reverso confiável na frente; não reproduzido bypass real (exigiria acesso direto ao container contornando o proxy do Railway — ver pendência assumida abaixo) |
| Limite por usuário vs. por IP | Todas as mutações autenticadas de `ponto.js` já usam `req.user.id` como chave primária | Confirmado (novo teste da seção 3, item 2) |
| Repetição concorrente (duplo clique, retry, corrida real) | `POST /marcacoes`, `/solicitacoes`, `/correcoes` — idempotência real por `operacao_id` (`UNIQUE` no banco + revalidação por `usuario_id`), já testada em `solicitacoes-marcacao.test.mjs`/`correcoes.test.mjs`/`auditoria-correcoes-duplicacao-http.test.mjs` com requisições simultâneas reais contra Postgres | Sem regressão; nova rajada concorrente desta rodada (seção 3, item 4) cobre o limitador em si, não só a idempotência |
| Payload grande / foto excessiva | `validarFotoBuffer` rejeita > 5MB; `express.json({limit:'50mb'})` é o teto global do processo (não específico do módulo). Decodificação do `base64` acontece antes da checagem de tamanho — pior caso é ~50MB decodificados por requisição, mitigado pelo teto de 8 tentativas/5min por usuário nas rotas que aceitam foto | Nenhuma correção mínima aplicável sem alterar o limite global do processo (afetaria rotas de outros módulos, fora do escopo desta pilha) — documentado como risco residual, não como defeito do módulo Meu Ponto |
| Leitura cara / exportação | `GET /ponto-gestao/correcoes`/`/solicitacoes` já receberam teto de 500 itens na rodada anterior (`PR #84`); `GET /ponto/solicitacoes`/`/correcoes` (autosserviço) são sempre filtrados por `usuario_id=req.user.id` — o volume máximo é limitado pelo próprio limite de criação do usuário, não por um export arbitrário | Sem gap novo nesta rodada |
| Brute force de senha nas mutações do módulo | `/marcacoes`/`/solicitacoes` exigem `senha_atual`, comparado via `bcrypt.compare` contra `usuarios.senha_hash` de `req.user.id`, sob `limiteTentativasSensiveis` (8/5min) — 8 tentativas em 5min é impraticável para força bruta de senha real | Sem gap novo nesta rodada |

## 5. Achado relacionado, fora da pilha do Meu Ponto (não corrigido aqui)

**`POST /api/auth/login` (`src/routes/auth.js`) não tem nenhum limite de
taxa** — diferente de `/api/public/leads` e `/api/public/alerta-whatsapp`
(as outras rotas públicas de `src/index.js`, ambas com `rateLimit`
próprio). Isso permite força bruta de senha sem throttle contra
**qualquer** conta do sistema (não é específico do Meu Ponto) — inclusive
contas de gestor/admin, o que tornaria irrelevante qualquer limite dentro
do módulo Meu Ponto uma vez obtida uma sessão válida por força bruta.

**Deliberadamente não corrigido nesta PR**: `MATRIZ_REQUISITO_IMPLEMENTACAO_TESTE.md`
já documenta como invariante do módulo que
`src/middleware/auth.js`/`src/routes/auth.js` **não são tocados** pela
feature Meu Ponto (linha "Não altera autenticação de outros módulos").
Corrigir o login é uma mudança de domínio diferente (autenticação geral
do CRM, não Meu Ponto) e, seguindo a regra do projeto de PR pequena e
separada por domínio, deve ir numa PR própria baseada em `main` — feita
em worktree/branch separado desta pilha (ver PR indicada na entrega desta
sessão).

Observação incidental (também fora do escopo, não corrigida): `PATCH
/api/auth/senha` não aplica o middleware `auth` na rota — `req.user` fica
indefinido antes de `req.user.id` ser lido, o que hoje faz esse endpoint
sempre falhar com 500 antes de chegar a qualquer verificação de senha ou
rate limit. É um bug de autenticação geral pré-existente, não uma
consequência de rate limiting, e também fora do domínio desta pilha.

## 6. Falhas pré-existentes na suíte combinada (não introduzidas por esta auditoria)

Ao rodar `npm run test:ponto` na pilha combinada `#78+81+82+83+84+85`,
**7 testes falham antes E depois** da correção desta rodada — todos com a
mesma causa raiz, confirmada pelo mesmo erro Postgres em todos:

```
{ message: 'o valor nulo na coluna "operacao_id" da relação "ponto_correcoes" viola a restrição de não-nulo', code: '23502' }
```

`#83` alterou a migration `20260101000048` para tornar `operacao_id`
`NOT NULL` em `ponto_correcoes`. `#84`/`#85` são branches **irmãs** de
`#83` (todas baseadas em `codex/meu-ponto-backend-20260910`, não uma na
outra) — os fixtures de teste escritos em `#84`/`#85`
(`uuid-malformado-vs-inexistente.test.mjs`,
`auditoria-fotos-historico-gestao-admin-20260912.test.mjs`,
`gestao-limite-listagem-correcoes-solicitacoes.test.mjs`) inserem em
`ponto_correcoes` sem `operacao_id`, porque na lineage de cada uma dessas
branches essa coluna ainda não existia. O problema só aparece quando as
branches são combinadas — é o mesmo tipo de risco que as sessões de
"revisão integrada" (`operacao_id contract compatibility`) já têm como
mandato explícito.

**Fora do escopo desta auditoria** (lente é rate limiting/abuso, não
integração entre PRs irmãs) — não corrigido aqui para não conflitar com
o trabalho paralelo de revisão integrada da pilha. Nenhuma dessas 7
falhas é de segurança: é comportamento CORRETO do código (a validação
`operacao_id` obrigatório de `#83` está funcionando exatamente como
projetada) batendo em fixtures de teste que não foram atualizados.

**Importante para quem for revisar a PR desta correção**: essas 7 falhas
só aparecem quando as SEIS branches são combinadas manualmente num
worktree de integração — não existem na PR real desta correção
(`fix/ponto-correcoes-rate-limit-ausente-20260912`, empilhada só sobre
`#85`, que por sua vez não inclui `#83`). Rodada a suíte completa
(`npm run test:ponto`) só com o que essa PR realmente contém, com o
Postgres isolado resetado para o schema exato dessa branch (sem a coluna
`operacao_id` de `#83` em `ponto_correcoes`): **141/141 testes verdes**,
incluindo os 4 novos desta rodada. A análise da pilha combinada (com as 7
falhas) é uma auditoria adicional, feita à parte, sobre um cenário que só
existirá de fato no momento em que as PRs irmãs forem integradas — fica
registrada aqui para quem for cuidar dessa integração, não bloqueia nem
faz parte desta correção.

## 7. Resultado da suíte

- **Nesta PR** (`fix/ponto-correcoes-rate-limit-ausente-20260912`,
  empilhada sobre `#85`): `npm run test:ponto` — 141/141 testes verdes,
  zero falhas, antes e depois comparados linha a linha com a correção
  aplicada. Nenhuma regressão.
- **Na pilha combinada** (`#78+81+82+83+84+85`, worktree de integração
  separado, não parte desta PR): mesmas 7 falhas pré-existentes da seção 6
  antes E depois desta correção — confirmando que a correção de
  `POST /correcoes` em si não altera esse resultado, positivo ou
  negativo.

## 8. Pendências assumidas, não verificadas (mesmo padrão do resto do módulo)

- Que o container da aplicação no Railway é inalcançável por conexão
  direta contornando o proxy de borda — `trust proxy=1` só é seguro contra
  falsificação de `X-Forwarded-For` se essa premissa for real. Não
  verificado nesta rodada (exigiria acesso à configuração de rede do
  Railway, fora do que este worktree pode confirmar).
- Comportamento do limitador em múltiplas réplicas horizontais: o store de
  `express-rate-limit` usado aqui é em memória, por processo — se a API
  algum dia escalar para mais de uma instância sem um store compartilhado
  (Redis), o orçamento efetivo por usuário multiplica pelo número de
  instâncias. Não é uma regressão desta rodada (mesmo comportamento já
  existente em `limiteTentativasSensiveis`/`limiteVinculo`), documentado
  aqui por ter sido revisado explicitamente sob a lente desta auditoria.
