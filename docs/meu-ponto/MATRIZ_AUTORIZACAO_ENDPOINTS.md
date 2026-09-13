# Matriz de autorização — por endpoint e por função SQL

Revisão de 2026-09-11 (quarta rodada — implementação do componente Windows).
Cada linha diz exatamente QUEM pode chamar, O QUE é revalidado a cada
requisição (nunca confiado no JWT) e ONDE mora a checagem (Express e/ou
função Postgres). "Revalidado" = consulta fresca ao banco nesta requisição,
não um valor do payload do JWT.

## 1. Endpoints — `/api/ponto/*` (colaborador)

Todos exigem `auth` (JWT válido) + `exigirUsuarioAtivo` (revalida
`usuarios.ativo`) + `exigirColaboradorHabilitado` (revalida
`ponto_habilitacoes.habilitado`), montados em `src/index.js`.

| Endpoint | Quem | Escopo do dado | Trava adicional |
|---|---|---|---|
| `GET /estado` | Próprio colaborador | Só os próprios dados (`req.user.id`) | — |
| `GET /marcacoes` | idem | idem | — |
| `GET /marcacoes/:id/foto` | idem | Verifica `marcacao.usuario_id === req.user.id`, senão 404 | — |
| `POST /desafios` | idem | `usuario_id` sempre `req.user.id` | `exigirPilotoAtivo` + `EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA` (sempre 501 hoje — ver §6) |
| `POST /marcacoes` | idem | `usuario_id` sempre `req.user.id`; corpo aceita `equipamento_id/nonce/assinatura` mas nada disso é lido antes do gate | `exigirPilotoAtivo` + `EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA` (sempre 501 hoje — ver §6). Mesmo com senha+foto+assinatura de equipamento genuinamente válidas, continua 501 (provado por teste HTTP real, não só por leitura de código). |
| `POST /solicitacoes` | idem | `usuario_id` sempre `req.user.id`, nunca do corpo | `exigirPilotoAtivo`; rate limit 8/5min por usuário |
| `GET /solicitacoes` | idem | idem | — |
| `GET /solicitacoes/por-operacao/:operacao_id` | idem | Verifica `usuario_id === req.user.id`, senão 404 | — |
| `GET /solicitacoes/:id/foto` | idem | Verifica dono, senão 404 | — |
| `POST /correcoes` | idem | `usuario_id`/`solicitado_por` sempre `req.user.id` | Rate limit 8/5min por usuário — orçamento próprio (`limiteCriacaoCorrecao`), separado do de `/solicitacoes`; achado da auditoria adversarial de rate limiting/abuso de 2026-09-12, ver `AUDITORIA_RATE_LIMIT_ABUSO_REAUTENTICACAO_20260912.md` |
| `GET /correcoes` | idem | Só os próprios | — |

## 2. Endpoints — `/api/ponto-gestao/*` (gestor/admin)

Todos exigem `auth` + `exigirUsuarioAtivo` + `exigirGestorOuAdmin`
(revalida: admin = sem restrição; qualquer outro papel = precisa de
`ponto_gestores` ativo — carrega `req.pontoEscopoGestor`).

| Endpoint | Quem | Escopo do dado | Trava adicional |
|---|---|---|---|
| `GET /colaboradores` | Gestor com escopo, ou admin | Filtra por `req.pontoEscopoGestor` | — |
| `GET /marcacoes` | idem | `colaboradorNoEscopo()` se `colaborador_id` informado; senão filtra pelo escopo inteiro | Mesmo endpoint usado pela exportação CSV/PDF do frontend — sem endpoint de export separado |
| `GET /marcacoes/:id/foto` | idem | `colaboradorNoEscopo(marcacao.usuario_id)`, senão 404 | — |
| `GET /correcoes` | idem | idem (por `usuario_id`) | — |
| `GET /solicitacoes` | idem | idem | — |
| `GET /solicitacoes/:id/foto` | idem | idem | — |
| `POST /correcoes/:id/decisao` | idem | Pré-check Express (404 se fora de escopo) **+ revalidado dentro de `ponto_decidir_correcao`** | Autoaprovação bloqueada (app + função + `CHECK`); `piloto_ativo` revalidado dentro da função só quando `decisao='aprovada'` |
| `POST /solicitacoes/:id/decisao` | idem | idem, via `ponto_decidir_solicitacao` | idem |

## 3. Endpoints — `/api/ponto-admin/*` (só admin)

Todos exigem `auth` + `exigirUsuarioAtivo` + `adminOnly` (`req.user.role === 'admin'`).

| Endpoint | Trava |
|---|---|
| `GET/PATCH /habilitacoes[/:usuario_id]` | Só admin |
| `GET/POST/DELETE /gestores[/:id]` | Só admin; não permite `gestor_usuario_id === colaborador_usuario_id` |
| `GET/POST/DELETE /equipamentos[/:id]` | Só admin; `modo` sempre forçado para `'demonstracao'` no servidor, nunca aceito do corpo |
| `POST /equipamentos/:id/vinculos` | Só admin; `EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA` (sempre 501 hoje — ver §6) |
| `GET/PATCH /config` | Só admin; `piloto_ativo` só muda por ação humana explícita, nunca automaticamente |

## 4. Funções Postgres — `ponto_decidir_solicitacao` / `ponto_decidir_correcao`

Definidas em `supabase/migrations/20260101000050_meu_ponto_decisao_atomica.sql`,
endurecidas em `20260101000051_meu_ponto_seguranca_funcoes.sql`.

| Propriedade | Valor | Por quê |
|---|---|---|
| `SECURITY` | `INVOKER` (explícito) | Nunca eleva privilégio — a função só faz o que o papel chamador já poderia fazer nas tabelas. Autorização real é validada DENTRO da função (linha abaixo), não obtida "de graça" via `DEFINER`. |
| `search_path` | `SET search_path = public, pg_temp` (fixo) | Evita *search_path hijacking* — nomes não qualificados dentro da função sempre resolvem para `public`, nunca para um schema criado por um papel malicioso à frente no `search_path` da sessão. |
| `EXECUTE` | `REVOKE ALL FROM PUBLIC`; `GRANT` condicional só para `service_role` (se existir) | Por padrão, Postgres concede `EXECUTE` a `PUBLIC` em toda função nova — isso é revogado explicitamente. `anon`/`authenticated` (papéis padrão do Supabase para chamadas via PostgREST) nunca recebem `GRANT` nenhum. |
| Quem pode executar direto (produção, assumido) | Só `service_role` — o mesmo papel que `SUPABASE_SECRET_KEY` usa | **Não verificado contra o Supabase real desta conta** — ver nota de ambiente na migration 051 e seção 6 abaixo. |
| `p_decisor_id` pode ser forjado? | Não tem efeito útil mesmo se for | A função revalida `usuarios.role`/`usuarios.ativo` do `p_decisor_id` informado e, se não for admin, exige uma linha ativa em `ponto_gestores` ligando esse decisor ao colaborador da solicitação/correção — um `p_decisor_id` sem essas condições reais é rejeitado (`fora_do_escopo`/`decisor_invalido_ou_inativo`), **mesmo chamando a função direto, contornando o Express inteiramente**. Testado com um papel Postgres restrito de verdade, não só com o pré-check em JS. |
| Autoaprovação | Bloqueada dentro da função (`RAISE EXCEPTION`) + `CHECK` no banco (`ponto_correcoes_sem_autoaprovacao`/`ponto_solicitacoes_marcacao_sem_autoaprovacao`) | Duas camadas dentro do MESMO objeto de autorização (a função + a tabela) — não depende do Express lembrar de checar. |
| Concorrência | `SELECT ... FOR UPDATE` na linha da solicitação/correção | Serializa decisões concorrentes — a segunda chamada só prossegue depois que a primeira commitar. |
| Atomicidade | Toda a lógica (validação + `UPDATE` de status + `INSERT` da marcação + link de volta) numa única função = uma transação | Falha em qualquer passo desfaz tudo — nunca fica "aprovada" sem marcação. |

## 5. O que foi verificado de verdade vs. o que é assumido

**Verificado** (testes automatizados contra Postgres real, papel restrito
de verdade, não superusuário — `scripts/tests/ponto/seguranca-funcoes-postgres.test.mjs`):
- `REVOKE ALL FROM PUBLIC` bloqueia um papel sem `GRANT` (erro `42501` real).
- Um papel com `GRANT EXECUTE` **e** os privilégios de tabela equivalentes
  ao perfil real de `service_role` consegue executar.
- Chamada direta da função (sem passar pelo Express) com um decisor sem
  escopo real é rejeitada pela própria função.
- Chamada direta com decisor inativo é rejeitada pela própria função.
- Referências órfãs (`origem_solicitacao_id`/`marcacao_gerada_id`
  apontando pra linha inexistente) são rejeitadas pelas FKs reais.

**Assumido, não verificado** (pendência explícita):
- Que o papel real do Supabase para `SUPABASE_SECRET_KEY` desta conta se
  chama de fato `service_role` (convenção padrão, nunca confirmada contra
  o projeto real).
- Que `anon`/`authenticated` não têm, por alguma configuração fora desta
  migration, algum `GRANT` adicional nessas funções (ex.: um `GRANT ALL
  ON ALL FUNCTIONS IN SCHEMA public` genérico aplicado em outro lugar do
  projeto, fora do controle desta migration).
- Comportamento exato do PostgREST ao expor `/rpc/ponto_decidir_solicitacao`
  publicamente — se o endpoint REST fica visível no schema exposto mesmo
  sem `EXECUTE`, e que erro HTTP exato o PostgREST devolve nesse caso.
- Qualquer coisa sobre RLS — nenhuma tabela deste módulo tem
  `ENABLE ROW LEVEL SECURITY`; todo o controle de acesso é na camada
  Express + nas funções acima, nunca em política de RLS (mesmo padrão do
  resto do projeto, onde a service role ignora RLS de qualquer forma).

Antes de aplicar as migrations 050/051 em produção: confirmar o nome real
do papel de serviço no dashboard do Supabase e ajustar o `GRANT`
condicional se for diferente de `service_role`.

## 6. Componente de equipamento (implementado nesta rodada, atrás de um único gate)

Três endpoints novos + uma função Postgres nova
(`ponto_registrar_marcacao_assinada`, migration 053) — nenhum deles muda
`EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA`
(`src/lib/ponto/equipamento.js`), que continua `false`. Cada um checa essa
mesma constante como a PRIMEIRA linha do handler, antes de ler qualquer
outra coisa do corpo/sessão:

| Endpoint | Auth | O que faz quando o gate abrir um dia |
|---|---|---|
| `POST /api/ponto-admin/equipamentos/:id/vinculos` | admin | Gera código de vínculo de uso único (10min) |
| `POST /api/ponto-equipamento/vincular` | **nenhuma** (sem `auth`/JWT — ver nota abaixo) | Completa o cadastro supervisionado com a chave pública + prova de posse |
| `POST /api/ponto/desafios` | colaborador | Emite desafio (nonce + HMAC do backend) |
| `POST /api/ponto/marcacoes` (corpo estendido) | colaborador | Verifica assinatura do equipamento e registra a marcação atomicamente |

**`POST /api/ponto-equipamento/vincular` é a única rota deste módulo sem
`auth`, de propósito**: o serviço local (fora do navegador) nunca deve
carregar o JWT/senha do colaborador — a única credencial aceita é o código
de vínculo de uso único, gerado só por um admin. Protegida por rate limit
por IP (20/10min) e pela alta entropia do código (~120 bits), não por
sessão.

**Verificado de verdade nesta rodada** (`scripts/tests/ponto/componente-equipamento.test.mjs`,
19 testes; `componente-equipamento-gate-http.test.mjs`, 5 testes;
`componente-windows-real.test.mjs`, 5 testes com o serviço local e o CNG
reais desta máquina — TPM disponível e exercitado de verdade, não simulado,
ver `PROTOCOLO_COMPONENTE_WINDOWS.md` §0):

- As 4 rotas continuam 501 mesmo com um payload genuinamente válido de
  ponta a ponta (assinatura ECDSA real, produzida pelo CNG real, aceita
  pela verificação real) — a propriedade de segurança mais importante desta
  rodada.
- `ponto_registrar_marcacao_assinada` segue a mesma disciplina de segurança
  das funções da migration 051 (`SECURITY INVOKER`, `search_path` fixo,
  `REVOKE`/`GRANT` condicional, testado com papel Postgres restrito de
  verdade — não só superusuário).
- A verificação da assinatura ECDSA acontece em Node (`node:crypto`) ANTES
  da função Postgres ser chamada — a função NÃO reverifica a assinatura
  (documentado no topo da migration 053); ela garante atomicidade/frescor
  (consumo do nonce, revalidação de equipamento/usuário, idempotência por
  `operacao_id`), não a prova criptográfica em si. Um chamador que
  contornasse a verificação em Node e chamasse a função direto ainda
  precisaria de um nonce real, não expirado, não usado, do
  equipamento/usuário corretos — mas não teria a assinatura reverificada
  ali.
- `chave_hardware_backed` é gravado como reportado pelo serviço local — o
  backend NÃO tem como confirmar remotamente que o CNG realmente usou o
  TPM; é informativo, nunca uma prova de atestação remota (ver
  `PROPOSTA_COMPONENTE_EQUIPAMENTO.md` §1.1).

**Assumido, não verificado** (mesma pendência do resto do módulo): o nome
real do papel de serviço no Supabase da conta real.
