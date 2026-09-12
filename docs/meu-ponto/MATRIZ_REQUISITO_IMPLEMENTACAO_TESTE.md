# Matriz requisito → implementação → teste → pendência

Revisão de 2026-09-10 (duas rodadas: achado do bloqueio de equipamento, e
depois atomicidade/permissões da aprovação). Cobre os pedidos originais do
piloto e os pontos das duas revisões adversariais. "Verificado" significa:
existe um teste automatizado que falha se o comportamento regredir — não é
uma alegação sem prova.

**Precisão de linguagem (segunda rodada)**: as três travas abaixo são
distintas e não devem ser resumidas como "nada pode virar marcação".
Aprovação humana de uma solicitação PODE (e deve) criar uma marcação —
isso é o design, não uma falha do bloqueio de equipamento. Ver
`ESPECIFICACAO_MEU_PONTO.md`, seção 0.2, para a tabela completa das três
travas.

## 1. Bloqueio por equipamento e pelas três travas distintas

| Requisito | Implementação | Teste | Pendência |
|---|---|---|---|
| Marcação DIRETA bloqueada enquanto verificação de equipamento não existe | `EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA = false` (`src/lib/ponto/equipamento.js`), constante de código, gate no topo de `POST /marcacoes` — independente de `piloto_ativo` | `equipamento-bloqueio.test.mjs` ("piloto_ativo=true + senha correta + foto válida: POST /marcacoes AINDA é bloqueado") | Continua bloqueado até o componente local existir e ser testado de verdade |
| Solicitação manual PODE resultar em marcação após aprovação humana (quando piloto ativo) | `ponto_decidir_solicitacao` (função Postgres, migration 050), chamada por `POST /api/ponto-gestao/solicitacoes/:id/decisao` | `decisao-atomica-e-permissoes.test.mjs` ("as três travas são distintas... aprovação humana consegue criar marcação") | — |
| Piloto desativado impede solicitações NOVAS e decisões que produziriam marcação (mas não bloqueia rejeitar) | `exigirPilotoAtivo` bloqueia criação; checagem de `piloto_ativo` dentro da própria função `ponto_decidir_solicitacao`/`ponto_decidir_correcao` bloqueia só o ramo "aprovada" | `decisao-atomica-e-permissoes.test.mjs` (mesmo teste, ramos 3) | — |
| equipamento_id do cliente não é aceito como prova | Rota nunca lê/desestrutura `equipamento_id` do corpo | `equipamento-bloqueio.test.mjs` ("enviar equipamento_id no corpo não muda nada") | — |
| Nenhum bypass por user-agent/cookie/IP/localStorage | Nenhum desses é lido em nenhuma rota do módulo (auditado por leitura de código) | Não há teste automatizado dedicado (é ausência de código, não comportamento a simular) | — |
| Contingência é solicitação auditada, não marcação disfarçada; interface é PROVISÓRIA, não o objetivo final | Tabela `ponto_solicitacoes_marcacao` — toda tentativa (com ou sem foto) fica `status=pendente` até decisão humana; nunca insere direto em `ponto_marcacoes` | `solicitacoes-marcacao.test.mjs`, `solicitacoes-decisao.test.mjs` | Objetivo continua sendo marcação direta em equipamento autorizado — ver `PROPOSTA_COMPONENTE_EQUIPAMENTO.md` |

## 1.1 Aprovação atômica (achado da segunda rodada)

| Requisito | Implementação | Teste | Pendência |
|---|---|---|---|
| Aprovar e criar a marcação em uma única transação | `ponto_decidir_solicitacao`/`ponto_decidir_correcao` (funções Postgres, migration 050) — uma chamada de função é uma transação só | `decisao-atomica-e-permissoes.test.mjs` ("atomicidade real: falha injetada...") | — |
| Falha no INSERT da marcação não deixa solicitação "aprovada" sem marcação | Exceção não capturada dentro da função aborta a transação inteira, inclusive o `UPDATE` de status já executado | **Falha REAL injetada via trigger Postgres** (não simulada em JS) — mesmo teste acima | — |
| Falha na atualização da solicitação não deixa marcação órfã | Mesmo mecanismo — `UPDATE ... SET marcacao_gerada_id` roda na mesma transação do `INSERT` | Coberto pelo mesmo teste (a função só tem uma transação, não duas) | — |
| Duas aprovações concorrentes geram só uma marcação | `SELECT ... FOR UPDATE` na função serializa decisões concorrentes na mesma linha | `solicitacoes-decisao.test.mjs`, `correcoes.test.mjs` (`Promise.all` real) | — |
| Aprovação concorrente com rejeição tem um único resultado | Mesmo `FOR UPDATE` — a segunda chamada sempre vê o status já decidido pela primeira | Mesmos testes acima | — |
| Repetição após timeout recupera a decisão existente | Resultado `'ja_decidida_antes'` devolve status/decidido_por/decidido_em/marcacao_gerada_id reais, não um erro genérico | `decisao-atomica-e-permissoes.test.mjs` ("retry após timeout recupera a decisão existente") | — |
| Proteção no banco contra mais de uma marcação para a mesma solicitação | `UNIQUE INDEX` em `ponto_marcacoes.origem_solicitacao_id` (migration 050) | `decisao-atomica-e-permissoes.test.mjs` ("proteção no banco... UNIQUE INDEX") — insert direto contornando a função, confirma rejeição real (23505) | — |
| Não depender só de checagem prévia em JavaScript | Checagens em JS (escopo, 404 rápido) continuam existindo, mas a garantia real (pendente/autoaprovação/atomicidade) está na função Postgres, à prova de pular o pré-check | Todos os testes de corrida acima chamam a rota HTTP fim-a-fim, não a função isolada | — |

## 2. Habilitação e gestão

| Requisito | Implementação | Teste | Pendência |
|---|---|---|---|
| Usuário só marca/consulta a si mesmo | Toda rota usa `req.user.id`, nunca id do corpo/query | `permissoes-e-piloto-gate.test.mjs` | — |
| Gestor só acessa colaboradores autorizados | `ponto_gestores` + `colaboradorNoEscopo()` | `permissoes-e-piloto-gate.test.mjs`, `solicitacoes-decisao.test.mjs` | — |
| Financeiro não vira gestor automaticamente | `exigirGestorOuAdmin` não reconhece nenhum `role`, só admin ou vínculo explícito | `permissoes-e-piloto-gate.test.mjs` ("papel financeiro não vira gestor") | — |
| Revogação (habilitação/escopo) vale mesmo com JWT antigo | Checagem sempre contra o banco a cada requisição, nunca contra o payload do JWT | `permissoes-e-piloto-gate.test.mjs` (2 testes dedicados, habilitação e escopo) | — |
| Proibida autoaprovação | Checagem em app + dentro da função Postgres (`RAISE EXCEPTION 'autoaprovacao_bloqueada'`) + `CHECK` no banco | `correcoes.test.mjs`, `solicitacoes-decisao.test.mjs`, `decisao-atomica-e-permissoes.test.mjs` | — |
| Gestor precisa continuar ATIVO (usuarios.ativo) no momento da decisão | `exigirDecisorAtivo` (`src/routes/ponto-gestao.js`) — reconsulta o banco a cada decisão; mais estrito que o resto do repo (auth.js só checa `ativo` no login) | `decisao-atomica-e-permissoes.test.mjs` ("gestor desativado... não decide, mesmo com JWT ainda válido") | Esse reforço é só nas rotas de decisão de ponto — não estendido a outras rotas do CRM |
| Solicitação pendente de colaborador desabilitado no meio do caminho | Desabilitar bloqueia só solicitações NOVAS (`exigirColaboradorHabilitado`); pendências já enviadas continuam decidíveis pelo gestor, histórico nunca é apagado | `decisao-atomica-e-permissoes.test.mjs` ("solicitação pendente de colaborador desabilitado...") | Comportamento documentado como decisão deliberada, não testado quanto a alternativas (ex.: exigir re-habilitação antes de aprovar) |

## 3. Reautenticação

| Requisito | Implementação | Teste | Pendência |
|---|---|---|---|
| Senha nunca aparece em log/auditoria/banco/navegador | `logarErroPonto` nunca recebe corpo de requisição; senha só passa por `bcrypt.compare`, nunca persistida; estado React limpo ao fechar modal | `log-e-foto-storage.test.mjs` | Não há scanner automático de log em produção — é revisão de código, não prova formal |
| Proteção contra tentativas repetidas | `express-rate-limit`, 8/5min por usuário (`ipKeyGenerator` para o fallback de IP) em `/marcacoes` e `/solicitacoes` | `solicitacoes-marcacao.test.mjs` ("limite de tentativas") | — |
| Confirmação corresponde ao usuário autenticado | `bcrypt.compare` sempre contra `usuarios.senha_hash` de `req.user.id` | Coberto implicitamente em todos os testes de criação (senha errada → 401) | — |
| Não altera autenticação de outros módulos | `src/middleware/auth.js`/`src/routes/auth.js` não tocados nesta feature | `git diff` do worktree backend confirma (só `index.js`, `package.json`, `pgCompatClient.js`, arquivos novos em `src/lib/ponto|routes/ponto*|middleware/pontoAuth.js`) | — |
| Colaborador não troca autor, horário recebido ou status pelo payload | `POST /solicitacoes` nunca lê `usuario_id`/`status`/`capturado_em`/`decidido_por` do corpo — `usuario_id=req.user.id`, `status` sempre `'pendente'` no INSERT, `capturado_em` é sempre `now()` do servidor (coluna `DEFAULT now()`, nunca escrita explicitamente a partir do corpo) | `decisao-atomica-e-permissoes.test.mjs` ("colaborador não troca autor, horário recebido ou status pelo payload") — envia os 4 campos forjados no corpo e confirma que nenhum teve efeito | — |

## 3.1 Horários e origem — três instantes distintos, nunca confundidos

| Instante | Coluna | Quem controla | Nunca usado como |
|---|---|---|---|
| Horário DECLARADO pelo colaborador | `ponto_solicitacoes_marcacao.horario_declarado` | Colaborador, sempre opcional, auto-relatado | `registrado_em` da marcação (nunca); e nunca "o horário efetivo trabalhado" — é só o que a pessoa disse |
| Horário de RECEBIMENTO no servidor | `ponto_solicitacoes_marcacao.capturado_em` → vira `ponto_marcacoes.registrado_em` na aprovação | Automático, `DEFAULT now()`, nunca aceito do corpo | **"Horário efetivo trabalhado"** — isso não está definido neste piloto (ver pendência abaixo). `capturado_em` é só o instante em que o SERVIDOR recebeu a tentativa, que pode ser bem depois do evento real (ex.: colaborador esqueceu e só registrou no fim do dia) |
| Horário da DECISÃO do gestor | `ponto_solicitacoes_marcacao.decidido_em` | Automático, `now()` no momento da chamada RPC | `registrado_em` da marcação (nunca) |
| Origem da marcação aprovada | `ponto_marcacoes.origem='contingencia'` + `origem_solicitacao_id` | Explícito — nunca rotulado como marcação direta verificada | "marcação direta"/"verificada por equipamento" |

**Pendência explícita (revisão de 2026-09-11, ponto 4)**: nenhuma das três
colunas acima é apresentada como "a hora efetivamente trabalhada" — essa
noção não está definida neste piloto e não deve ser calculada ou inferida.
`registrado_em`/`capturado_em` é o instante de recebimento no servidor
(não manipulável, mas também não é prova de quando o trabalho realmente
começou); `horario_declarado` é auto-relatado, não verificado. O relatório
de conferência (CSV/PDF) mostra os campos brutos, rotulados pelo que
realmente são — nunca uma "jornada calculada". Ver `MANUAL_E_STATUS.md`,
seção 6, para a pendência de regras de jornada.

`ponto_decidir_solicitacao` usa `v_solic.capturado_em` (recebimento no
servidor) como `registrado_em` da marcação — nunca `now()` no momento da
aprovação. Verificado em
`decisao-atomica-e-permissoes.test.mjs` ("horario_declarado é opcional,
distinto de capturado_em/decidido_em, e nunca vira registrado_em..."), que
também confirma que `horario_declarado` (quando o colaborador o informa)
nunca influencia `registrado_em`.

## 4. Concorrência e idempotência (banco real isolado, não mock)

| Requisito | Implementação | Teste | Pendência |
|---|---|---|---|
| Mesma operação simultânea → 1 marcação/solicitação | `UNIQUE INDEX` real em `operacao_id` | `solicitacoes-marcacao.test.mjs` ("concorrência real: 3 requisições simultâneas") | — |
| Mesma operação, conteúdo diferente → conflito | Comparação de `tipo`/`justificativa` contra o registro existente antes de tratar como idempotente | `solicitacoes-marcacao.test.mjs` ("conteúdo DIFERENTE é conflito") | — |
| Idem, para `POST /marcacoes` (inatingível hoje, ver seção 1) e `ponto_registrar_marcacao_assinada` | **Corrigido na revisão de 2026-09-12** — antes, reenviar o mesmo `operacao_id` com um `tipo` diferente devolvia silenciosamente a marcação antiga como se fosse sucesso da nova tentativa. Agora comparação de `tipo` em ambas as camadas (rota e função Postgres), erro `operacao_id_conteudo_diferente` → 409 | `componente-equipamento.test.mjs` ("mesmo operacao_id com tipo DIFERENTE é conflito") | — |
| Operações distintas legítimas preservadas | Sem chave por (usuário, tipo, dia) — só por `operacao_id` | `equipamento-bloqueio.test.mjs`/testes antigos de sequência (removidos do arquivo dedicado, mas o princípio é estrutural: nunca há `UPDATE`/`UPSERT` por tipo+dia) | — |
| Recuperação após timeout sem nova batida | `GET /solicitacoes/por-operacao/:operacao_id` | `solicitacoes-marcacao.test.mjs` (2 testes: recupera própria, 404 para terceiro) | — |
| Decisão concorrente → só uma válida | `UPDATE ... WHERE status='pendente'` + `.maybeSingle()` (antes usava `.single()`, que MASCARAVA a corrida como erro 500 — corrigido nesta revisão) | `solicitacoes-decisao.test.mjs`, `correcoes.test.mjs` (2 testes de corrida real, `Promise.all`) | — |
| Idem, para `POST /api/ponto/correcoes` | **Corrigido na auditoria adversarial de 2026-09-12** (achado independente da PR #78, motivado pela PR frontend #19) — ao contrário de `/marcacoes` e `/solicitacoes`, `ponto_correcoes` nasceu sem `operacao_id`: retry de rede, timeout ambíguo, duplo clique e concorrência sempre geravam uma linha nova (reproduzido: 2 chamadas sequenciais idênticas → 2 linhas; 5 simultâneas → 5 linhas). Corrigido com `operacao_id uuid NOT NULL UNIQUE` (migration 048 revisada) + mesma lógica de idempotência das rotas irmãs, já com o filtro por `usuario_id` desde o início (sem reintroduzir a classe de vazamento das PRs #81/#82) | `auditoria-correcoes-duplicacao-http.test.mjs` | — |
| Limites do que foi verificado | Testes rodam contra Postgres real (constraints, UNIQUE INDEX, triggers, transações são genuínas) via `pgCompatClient` | — | **Não verificado**: comportamento HTTP/erro específico do PostgREST real, pooling do Supabase, RLS (ignorada pela service role em produção também). Documentado em `solicitacoes-marcacao.test.mjs` (cabeçalho) e `MANUAL_E_STATUS.md` |

## 5. Fotos

| Requisito | Implementação | Teste | Pendência |
|---|---|---|---|
| Autorização de upload/leitura/URL assinada | Upload só server-side (service role); leitura sempre checa dono/escopo antes de gerar URL | `permissoes-e-piloto-gate.test.mjs`, `solicitacoes-decisao.test.mjs` | Bucket privado real (`ponto-fotos`) não criado em nenhum ambiente — só verificado via storage local de teste |
| Impede acesso por troca de ID | `usuario_id === req.user.id` / `colaboradorNoEscopo` antes de qualquer leitura de foto | `permissoes-e-piloto-gate.test.mjs` | — |
| Valida conteúdo real, tamanho, formato | `validarFotoBuffer` — assinatura de bytes (magic bytes), não só `mime_type` declarado; limite 5MB | `log-e-foto-storage.test.mjs`, `solicitacoes-marcacao.test.mjs` | — |
| Falha parcial foto/registro sem falso sucesso | Resposta explícita citando que a foto foi recebida mas o registro falhou; nada de sucesso fabricado | `solicitacoes-marcacao.test.mjs` ("falha parcial REAL... trigger força erro no INSERT") — **falha injetada de verdade via trigger Postgres**, não simulada em JS | Foto órfã não tem limpeza automática (decisão deliberada — ver seção 4 da especificação, "não excluir evidência sem política aprovada") |
| Sem foto de pessoa real em teste | Todas as fotos de teste são buffers JPEG sintéticos (`fotoSinteticaBase64`); Playwright usa `--use-fake-device-for-media-stream` | Todo o conjunto de testes + script de validação visual | — |
| Storage indisponível: comportamento explícito e testado | Upload lança erro tipado (`falha_upload_foto`), rota responde 502 | `solicitacoes-marcacao.test.mjs` ("storage de fotos indisponível") — **falha real** (diretório de destino forçado a ser inválido no disco) | — |

## 6. Preservação de originais e exportação

| Requisito | Implementação | Teste | Pendência |
|---|---|---|---|
| Correção não sobrescreve marcação | `ponto_correcoes`/`ponto_solicitacoes_marcacao` nunca fazem `UPDATE` em `ponto_marcacoes` já existente — aprovação sempre `INSERT` de linha nova | `correcoes.test.mjs`, `solicitacoes-decisao.test.mjs` | — |
| Auditoria com autor/decisão/horários | Colunas `solicitado_por`/`decidido_por`/`decidido_em`/`decisao_justificativa` em ambas as tabelas | Implícito em todos os testes de decisão (lêem essas colunas para validar o resultado) | — |
| Exportação respeita escopo | `GET /api/ponto-gestao/marcacoes` sempre filtra por `colaboradorNoEscopo`/`pontoEscopoGestor` | `permissoes-e-piloto-gate.test.mjs` | — |
| Proteção contra fórmula maliciosa em CSV | `celulaSegura()` extraído para `src/lib/csvSafety.js` (frontend), aplicado em `GestaoPonto.jsx` antes de `exportarCSV` | `scripts/tests/csvSafety.test.mjs` (frontend, 4 casos) | Continua só no frontend — nenhum endpoint gera CSV no backend |
| Relatório identificado como piloto, nunca AFD/AEJ | Título fixo no PDF/CSV, texto explicativo na tela de gestão | Verificação manual do texto (não há teste automatizado de string de UI) | — |

## 7. Confirmação de que o piloto permanece bloqueado para uso real

**Correção de linguagem (revisão de 2026-09-11)**: a frase "duas camadas
independentes, cada uma suficiente sozinha" estava errada — `piloto_ativo`
e `EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA` não protegem a mesma coisa
redundantemente, protegem **caminhos diferentes**. Descrição correta:

| Estado | O que bloqueia |
|---|---|
| `ponto_config.piloto_ativo = false` | Toda **solicitação nova** (`POST /solicitacoes`) e toda **decisão que geraria marcação** (aprovar). Rejeitar continua permitido. Nasce `false` em toda migration/reset; alterar exige `PATCH /api/ponto-admin/config`, ação humana autenticada e deliberada, nunca automática. |
| `ponto_config.piloto_ativo = true` | Nada — apenas **habilita** o fluxo manual autorizado (solicitação → aprovação). Não cria marcação nenhuma sozinho. |
| `EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA = false` (constante de código) | Só a criação **direta** de marcação (`POST /marcacoes`, origem='normal') — independente do valor de `piloto_ativo`. Só muda com mudança de código real (componente local implementado e testado), nunca por configuração. |
| Aprovar uma solicitação | Cria UMA marcação específica — **nunca** ativa nem desbloqueia o piloto como um todo; `piloto_ativo` e `EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA` continuam exatamente como estavam depois de qualquer decisão. |

Nenhum usuário real foi habilitado em nenhum ambiente além do banco de
teste isolado local.

## 8. Próxima etapa delimitada — componente de equipamento

Fora do escopo desta etapa (não implementado, não instalado em máquina real):

1. Serviço Windows local com chave gerada e protegida via DPAPI/Credential Manager (uma por equipamento).
2. Endpoint de desafio (`ponto_desafios`, já no schema) — nonce de uso único, validade curta, consumido uma vez.
3. Assinatura da operação (nonce + operacao_id + usuário) pelo serviço local, enviada junto com a solicitação.
4. Validação da assinatura no servidor, com proteção contra replay (nonce marcado como usado atomicamente).
5. Fluxo de cadastro/revogação de equipamento por admin (endpoints já existem em modo demonstração — `src/routes/ponto-admin.js` — faltam ser conectados a uma verificação real).
6. Só depois disso `EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA` deve virar `true` — e mesmo assim, `POST /marcacoes` deve validar a assinatura de verdade antes de aceitar, não apenas checar a constante.

Critério de pronto: um teste de integração que (a) gera um desafio, (b) assina com uma chave real, (c) valida no servidor, (d) prova que um desafio expirado ou reutilizado é rejeitado — só então a constante muda.

## 9. Revisão integrada de 2026-09-12 — dois defeitos concretos corrigidos

Revisão final integrada (backend + frontend, PRs #78/#18) contra Postgres
real isolado (porta 55491, nunca 5432/5433/vivenzza_dev). Dois defeitos
concretos encontrados e corrigidos, ambos com teste novo provando o
comportamento antes-e-depois:

| Defeito | Onde | Correção | Teste |
|---|---|---|---|
| Aprovar uma correção (`ajuste_horario`/`ajuste_tipo`/`inclusao_marcacao_faltante`) com `valor_proposto` sem `tipo`/`registrado_em` válidos marcava a correção como `'aprovada'` e simplesmente PULAVA o `INSERT` da marcação — em silêncio, sem erro, sem `marcacao_gerada_id`, sem nenhum sinal pro gestor | `ponto_decidir_correcao` (migration 051) | Validação movida para ANTES do `UPDATE` de status — `valor_proposto` inválido agora levanta `valor_proposto_invalido` (a transação inteira desfaz, a correção continua `'pendente'`), mapeado para HTTP 422; `POST /api/ponto/correcoes` também passou a validar isto na criação (defesa em profundidade — nunca confiar só na checagem em JS) | `correcoes.test.mjs` (criação: 400; aprovação de correção malformada pré-existente: 422, status permanece pendente) |
| Reenviar o mesmo `operacao_id` com um `tipo` diferente em `POST /marcacoes`/`ponto_registrar_marcacao_assinada` (hoje inatingível via HTTP, ver seção 1, mas código real testado na camada de serviço) devolvia 200 com a marcação ANTIGA, como se a nova tentativa tivesse sido aceita — o mesmo problema que a especificação (seção 2.3) já proibia para `/solicitacoes`, nunca replicado aqui | `src/routes/ponto.js` (rota) + `ponto_registrar_marcacao_assinada` (migration 053) | Comparação de `tipo` contra o registro existente em ambas as camadas; erro `operacao_id_conteudo_diferente` → 409 | `componente-equipamento.test.mjs` ("mesmo operacao_id com tipo DIFERENTE é conflito") |

Achado adicional, fora do backend: `GestaoPonto.jsx` (frontend) exportava
CSV/PDF com só a primeira página de `GET /api/ponto-gestao/marcacoes`
(limite 500/página) — com filtro largo, uma vez que o piloto passe de ~1
mês de uso (3 colaboradores × ~4 marcações/dia já ultrapassa 500), o
"relatório de conferência" ficava truncado sem nenhum aviso. Corrigido para
paginar até esgotar `total` antes de gerar o arquivo.

Suíte completa (`npm run test:ponto`, 13 arquivos) permanece verde após as
correções, incluindo os 3 testes novos.
