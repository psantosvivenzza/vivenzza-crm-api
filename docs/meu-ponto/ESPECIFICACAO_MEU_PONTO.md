# Módulo "Meu Ponto" — Especificação de viabilidade e arquitetura (piloto)

Status: **piloto, desativado por padrão em produção**. Não é REP-P, não é
reconhecimento facial, não é prova de vida, não substitui o registro oficial
de ponto. Este documento é a etapa 2 pedida antes de qualquer implementação.

## 0. Contexto e tensão com pesquisa anterior

Em 2026-09-10, uma pesquisa comercial (`PESQUISA_CONTROLE_PONTO_VIVENZZA_2026-09-10.md`,
raiz do repo `Projeto Claude Code`) recomendou contratar um fornecedor REP-P
homologado (Pontotel/Sólides/Oitchau) em vez de construir um registrador
próprio, citando exigências do Decreto 10.854 e Portaria 671 (INPI, AFD/AEJ,
assinatura digital, hora legal brasileira). Este módulo **não contradiz**
aquela recomendação — é uma ferramenta interna complementar, deliberadamente
limitada, para 3 funcionários presenciais, enquanto a decisão de compra
amadurece. Em nenhum lugar da interface, API, exportação ou documentação este
módulo deve se apresentar como REP-P, homologado, antifraude ou substituto do
registro oficial.

## 0.1 Correção estrutural (revisão adversarial, 2026-09-10)

A primeira versão desta especificação (seção 2.5, abaixo, texto original
preservado) tratava `ponto_config.piloto_ativo=false` como o único bloqueio
de "registro operacional". Uma revisão encontrou o problema: com
`piloto_ativo=true` (inclusive em teste isolado), `POST /marcacoes`
criava uma marcação `origem='normal'` de verdade — sem NENHUMA verificação
de equipamento, porque essa verificação nunca existiu. Ou seja, o bloqueio
dependia de um admin nunca ligar a flag, não da ausência real da
capacidade. Isso foi corrigido estruturalmente:

- `EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA = false` (`src/lib/ponto/equipamento.js`)
  é uma **constante de código**, não uma flag de banco. `POST /marcacoes`
  (criação direta) fica bloqueada por ela, **independente** de
  `piloto_ativo`.
- O caminho operacional real desta etapa passou a ser
  `POST /api/ponto/solicitacoes` — toda tentativa (com ou sem foto) vira uma
  linha em `ponto_solicitacoes_marcacao`, `status='pendente'`, e só produz
  uma marcação de verdade depois que um gestor aprova
  (`POST /api/ponto-gestao/solicitacoes/:id/decisao`). "Contingência" deixou
  de ser um valor de `origem` aceito direto em `POST /marcacoes` — agora é
  literalmente uma solicitação auditada, nunca uma marcação normal
  disfarçada.
- Ver `MATRIZ_REQUISITO_IMPLEMENTACAO_TESTE.md` para o mapeamento completo
  requisito → código → teste desta correção.

As seções 2.3/2.5/2.6/3 abaixo já refletem o modelo corrigido.

## 0.2 Precisão sobre as travas (revisão adversarial, segunda rodada) e caráter provisório

A revisão seguinte apontou que a frase "EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA=false
impede toda marcação" é **imprecisa** — a aprovação humana de uma
solicitação CONSEGUE criar uma marcação, e isso é o design pretendido, não
uma falha. As três travas são distintas e não devem ser confundidas:

| Trava | O que bloqueia | O que NÃO bloqueia |
|---|---|---|
| `EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA=false` | Criação **direta** de marcação (`POST /marcacoes`, origem='normal') | Solicitação (`POST /solicitacoes`) e aprovação dela |
| `ponto_config.piloto_ativo=false` | Criação de **solicitações novas** e **decisões que produziriam uma marcação** (aprovar) | Rejeitar uma solicitação pendente (não produz marcação); consulta de histórico |
| Escopo/habilitação (`ponto_habilitacoes`, `ponto_gestores`) | Quem pode enviar/decidir | — |

Nenhuma dessas travas, isoladamente ou juntas, significa "nenhuma marcação
pode existir". Significa: **nenhuma marcação existe sem uma decisão humana
explícita de um gestor**, e essa decisão só é possível quando o piloto está
ativo.

**O fluxo de solicitação/aprovação é uma interface PROVISÓRIA, não o
objetivo final.** O objetivo continua sendo marcação direta em computador
autorizado, com verificação de equipamento real (ver seção 7 da proposta em
`PROPOSTA_COMPONENTE_EQUIPAMENTO.md`). Exigir aprovação humana de toda
batida não encerra o requisito original de um ponto eletrônico funcional
— é uma medida de contenção enquanto a verificação de equipamento não
existe. Não remover o fluxo de solicitações quando o componente de
equipamento for implementado: ele continua útil para os casos de exceção
reais (câmera indisponível, equipamento não cadastrado) — só deixa de ser
o único caminho.

## 1. Estado real investigado (não presumido)

**Backend** (`vivenzza-crm-api`, Node/Express + Supabase/Postgres, Railway):
- Auth é JWT stateless, `expiresIn: '8h'`, sem refresh token, sem step-up
  genérico. O único precedente de reautenticação é `PATCH /api/auth/senha`
  (exige `senha_atual`). Fonte: `src/middleware/auth.js`, `src/routes/auth.js`.
- `usuarios.role` tem CHECK constraint que só aceita `admin`/`vendedor`/
  `financeiro` (PR #76, ainda não mergeado, corrige um drift real de
  produção). **Nenhum papel novo passaria nessa constraint hoje.**
- Supabase Storage já é usado (buckets `whatsapp-media`, `backups`), mas
  **sempre com URL pública sem expiração**, sem bucket/policy versionados em
  migration (drift conhecido), sem validação de tamanho/tipo no código, sem
  nenhum precedente de signed URL nem de bucket privado.
- Padrão de idempotência existente (`src/lib/collection/idempotency.js`) é
  chave determinística por (entidade, ação, dia) — **não serve diretamente**
  para marcações de ponto, porque múltiplas marcações do mesmo tipo no
  mesmo dia podem ser legítimas (ex.: esqueceu de bater e corrigiu depois).
  Existe também um padrão de janela de 5s para absorver duplo-clique
  (`collection-contact-review.js`), esse sim reaproveitável como camada de
  UX além da idempotência real.
- Fuso horário: `America/Sao_Paulo` = UTC-3 fixo (sem horário de verão desde
  2019), util canônico `hojeBrtISO()` em
  `src/lib/collection/collectionContactPolicy.js`.
- CORS é `origin: '*'` global; rate limit só existe em duas rotas públicas
  específicas, nada em rotas autenticadas.
- Log sanitizado é um padrão recente e explícito (PR #74): nunca logar
  `err.message`/`err.detail` bruto, só texto fixo + etapa fixa + código de
  erro filtrado por regex allowlist.
- Migrations são aplicadas **manualmente** em produção (sem pipeline), já
  causou drift real documentado. Próximo número livre: `20260101000048`.

**Frontend** (`vivenzza-crm-frontend`, React 18 + Vite + Tailwind, Vercel):
- Rotas centralizadas em `src/App.jsx`, menu orientado a dados em
  `src/components/Layout.jsx` (`NAV_SECTIONS` + `itemVisivel(item, user)`).
- Não existe wrapper genérico de guard por role; há inconsistência real hoje
  entre o que o menu libera e o que a página permite (bug conhecido em
  `RevisaoContatos.jsx`/`Recuperacao.jsx`) — **este módulo deve manter menu e
  página sempre sincronizados**, centralizando a checagem.
- Não existe nenhum precedente de captura de foto/vídeo, mas existe
  precedente direto e reaproveitável de mídia via `getUserMedia` +
  `MediaRecorder` + `blobToBase64` + upload JSON base64 (não multipart) em
  `src/pages/WhatsApp.jsx` — o mesmo padrão de upload (JSON+base64) é o único
  compatível com o backend hoje (não há multer/multipart em lugar nenhum).
- Já existem `exportarCSV`/`exportarTabelaPDF` genéricos em `src/lib/export.js`
  — reaproveitáveis, mas `exportarCSV` **não sanitiza fórmulas** hoje; será
  preciso um wrapper novo para a exportação de ponto.
- Não há enum central de roles; o padrão real mais próximo do que este módulo
  precisa é a flag booleana por usuário (`recebe_leads`, editável em
  `src/pages/Usuarios.jsx`), confirmando que "habilitação por colaborador,
  não por papel" é natural de encaixar sem tocar a constraint de `role`.

## 2. Decisões de arquitetura

### 2.1 Habilitação não é papel (role)

Em vez de criar um novo valor de `role` (que exigiria alterar a constraint
de produção, um risco desnecessário para um piloto), a habilitação para bater
ponto é uma **flag explícita por colaborador**, independente do papel no CRM
(`admin`/`vendedor`/`financeiro`). Isso responde diretamente à instrução de
não confundir conta do CRM com vínculo empregatício.

### 2.2 Reautenticação sem inventar infraestrutura de sessão

Não existe step-up/refresh hoje. Em vez de construir um mecanismo de sessão
novo, cada marcação exige o **reenvio da senha atual** no corpo da
requisição (mesmo mecanismo de verificação já usado em `PATCH /api/auth/senha`,
via `bcrypt.compare`), independente da idade do JWT de 8h. Isso satisfaz
literalmente "não considerar uma sessão antiga aberta como confirmação
suficiente" sem inventar um novo sistema de autenticação.

### 2.3 Idempotência por operação, não por (usuário, tipo, dia)

Cada tentativa (marcação direta, hoje inatingível — ver 2.5 —,
solicitação ou correção) carrega um `operacao_id` (UUID v4) gerado no
cliente no momento do toque no botão. O backend garante unicidade real via
`UNIQUE INDEX` (`ponto_marcacoes.operacao_id`, `ponto_solicitacoes_marcacao.operacao_id`,
`ponto_correcoes.operacao_id`) — clique duplo/retry de rede reenvia o
mesmo `operacao_id` e recebe de volta o registro já existente (idempotente
de verdade), mas duas tentativas **distintas** do mesmo tipo no mesmo dia
(ex.: esqueceu de bater e corrige depois) não são descartadas por
proximidade de horário — elas geram `operacao_id`s diferentes e são
persistidas.

Reforço da revisão de 2026-09-10: reenvio do **mesmo** `operacao_id` com
conteúdo **diferente** (tipo ou justificativa distintos) não é tratado como
"a mesma operação" — vira `409 Conflict`. Idempotência nunca deve
silenciosamente aceitar um payload diferente sob a mesma chave. Marcações
aprovadas via solicitação sempre nascem `sinalizado_para_revisao = true`
(são uma exceção por construção, dado que não há verificação de
equipamento); a avaliação de sequência inesperada (`avaliarSequencia`)
continua existindo no código para quando `POST /marcacoes` reabrir.

**Correção estrutural (auditoria adversarial de 2026-09-12, achado
independente da PR #78, motivado pela PR frontend #19)**: `POST
/api/ponto/correcoes` nasceu sem `operacao_id` — única rota de escrita do
módulo sem nenhuma defesa de banco contra reenvio. Reproduzido contra
Postgres real antes da correção: retry sequencial idêntico e concorrência
real sempre geravam uma linha nova por tentativa (nunca colapsavam para
1). Corrigido com o mesmo padrão desta seção, incluindo o filtro por
`usuario_id` na consulta de idempotência desde o primeiro commit (a classe
de vazamento entre usuários corrigida nas PRs #81/#82 para `/marcacoes` e
`/solicitacoes` nunca chegou a existir aqui). Ver
`docs/meu-ponto/AUDITORIA_CORRECOES_DUPLICACAO_2026-09-12.md`.

### 2.4 Fotos: bucket privado + signed URL (sem precedente, construído do zero)

Bucket novo `ponto-fotos` no Supabase Storage, **privado** (sem
`getPublicUrl`). Upload é feito pelo backend com a service role (como já é
padrão no projeto), a partir de um payload JSON `{ foto_base64 }` (mesmo
padrão de mídia do WhatsApp — não há multipart no projeto). Leitura para
gestor/admin é sempre via `createSignedUrl` com expiração curta (5 min),
gerada sob demanda, nunca uma URL permanente. **Passo manual pendente e
documentado**: criação do bucket no dashboard do Supabase antes de qualquer
uso além de testes locais (mesmo padrão de drift já existente no projeto —
não será feito nesta etapa).

### 2.5 Identificação de equipamento: desenhada, não aplicada — e estruturalmente bloqueada

Um serviço Windows local com chave protegida pelo SO (DPAPI/Credential
Manager), desafio de uso único e assinatura por operação **não será
implementado nem instalado em máquina real nesta etapa** — construir e testar
com segurança um agente nativo assinando operações, dentro de uma única
sessão, sem instalar nada em computador real, não é factível com garantias
reais de segurança. O schema (`ponto_equipamentos`, `ponto_desafios`) e os
endpoints de cadastro/consulta são entregues em **modo de demonstração**.

**Correção da revisão de 2026-09-10**: o bloqueio do registro operacional
real NÃO depende só de `ponto_config.piloto_ativo=false` (isso é a trava
mestra pra quando o piloto inteiro deve ficar pausado — ver seção 6). A
ausência da capacidade de verificar equipamento é bloqueada por uma
**constante de código**, `EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA = false`
(`src/lib/ponto/equipamento.js`), que barra `POST /marcacoes` (criação
direta de `origem='normal'`) incondicionalmente — inclusive com
`piloto_ativo=true`. Isso é deliberado: uma flag de banco pode ser ligada
por engano ou por um teste; a ausência real de verificação de equipamento
não pode. Até essa constante virar `true` (e a assinatura ser
implementada e testada de verdade), o único caminho pelo qual uma tentativa
vira uma marcação real é `POST /api/ponto/solicitacoes` →
`ponto_solicitacoes_marcacao` → aprovação humana de um gestor (ver 2.6).
Nenhuma chave privada no cliente, nenhum fingerprint de navegador tratado
como prova de equipamento, nenhum `equipamento_id` do corpo da requisição
aceito como prova de nada — a rota nem lê esse campo.

### 2.6 Correções e solicitações nunca sobrescrevem o original

`ponto_correcoes` (ajuste de algo já confirmado) e
`ponto_solicitacoes_marcacao` (tentativa de registrar agora, caminho real
enquanto 2.5 não muda) são tabelas de solicitação/decisão, sempre
separadas de `ponto_marcacoes`. Aprovação sempre **insere uma linha nova**
em `ponto_marcacoes` (`origem='correcao'` ou `origem='contingencia'`,
respectivamente), preservando qualquer marcação original intacta (mesmo
que sinalizada). Não existe endpoint que apague ou edite os campos centrais
(`tipo`, `registrado_em`, `usuario_id`) de uma marcação já persistida.
Autoaprovação é bloqueada em dois níveis (aplicação + `CHECK` no banco) nas
duas tabelas. Decisão concorrente (dois gestores decidindo a mesma
solicitação ao mesmo tempo) é resolvida por `UPDATE ... WHERE status='pendente'`
— só uma vence, a outra recebe `409` explícito (nunca "a última que chegou
ganha" silenciosamente).

## 3. Modelo de dados (migrations `20260101000048` e `20260101000049`, prefixo `ponto_`)

| Tabela | Papel |
|---|---|
| `ponto_config` | Linha única com `piloto_ativo boolean default false` — a trava mestra do piloto inteiro. |
| `ponto_habilitacoes` | Flag por colaborador (`usuario_id`, `habilitado`, quem habilitou/quando), histórico em `ponto_habilitacoes_historico`. |
| `ponto_gestores` | Escopo explícito gestor→colaborador (não é global). |
| `ponto_equipamentos` | Cadastro/revogação de equipamento (modo demonstração nesta etapa). |
| `ponto_desafios` | Desafio de uso único para assinatura de equipamento (modo demonstração). |
| `ponto_fotos` | Metadados da foto (path no bucket privado, mime, tamanho); bytes ficam só no Storage. |
| `ponto_marcacoes` | Registro **imutável** e só criado por aprovação (não por criação direta, hoje — ver 2.5): `operacao_id` único, `tipo`, `registrado_em` do servidor, `dia_brt`, `foto_id`, `origem` (`normal`\|`contingencia`\|`correcao`), `sinalizado_para_revisao`. |
| `ponto_solicitacoes_marcacao` | **(nova, migration 049)** O caminho operacional real desta etapa: toda tentativa de marcação (com ou sem foto, sempre com justificativa), `status` pendente/aprovada/rejeitada; aprovação gera a linha em `ponto_marcacoes`. |
| `ponto_correcoes` | Solicitação/justificativa/decisão sobre uma marcação **já confirmada**, nunca edita `ponto_marcacoes` diretamente. `operacao_id` único (ver 2.3, corrigido em 2026-09-12). |

Todas com FK para `usuarios(id)`, índices para as consultas do painel de
gestão (por colaborador + período), e comentário de contexto no topo de cada
migration (padrão do repo).

## 4. Permissões (resumo)

| Papel/flag | Pode |
|---|---|
| Colaborador com `ponto_habilitacoes.habilitado = true` | Enviar solicitação de marcação (se `piloto_ativo = true`; nunca cria marcação direto — ver 2.5), ver e exportar só o próprio histórico, solicitar correção. |
| Gestor de ponto (`ponto_gestores`) | Ver/exportar apenas os colaboradores no seu escopo, decidir correções e solicitações de marcação (nunca as próprias). |
| `admin` (role existente) | Habilitar colaboradores, gerenciar equipamentos, conceder/revogar escopo de gestor, ligar/desligar a trava mestra. |

Tudo validado no backend a partir de `req.user.id`/`req.user.role` — nunca
um `usuario_id` vindo do corpo da requisição (mesmo padrão já usado em
`collection-contact-review.js`).

## 5. Limitações conhecidas e o que falta para REP-P/produção

- Sem AFD/AEJ, sem registro INPI, sem assinatura digital homologada — os
  exports são rotulados **"Relatório de conferência — piloto"**, nunca como
  documento regulamentar.
- Sem prova de vida, sem reconhecimento facial — a foto é evidência
  complementar revisável por humano, não verificação automática.
- Sem enforcement real de equipamento nesta etapa (ver 2.5).
- Sem cálculo de folha, banco de horas, hora extra, adicionais — apenas
  registro e pendências.
- Retenção de fotos/dados: parametrizável no schema, mas **sem política
  jurídica definida ainda** — nenhuma exclusão automática será ativada.
- Custos operacionais: Storage adicional no Supabase (fotos pequenas, ~3
  usuários × poucas marcações/dia — desprezível no plano atual); nenhum
  custo de licença, já que não há serviço pago envolvido nesta fase.

## 6. Checklist objetivo de ativação (produção)

Bloqueado enquanto qualquer item abaixo não estiver marcado:

- [ ] Migrations aplicadas manualmente em produção e conferidas.
- [ ] Bucket `ponto-fotos` criado (privado) no Supabase de produção.
- [ ] Pelo menos 1 administrador revisou e habilitou explicitamente cada um
      dos 3 colaboradores em `ponto_habilitacoes`.
- [ ] Pelo menos 1 gestor de ponto com escopo definido.
- [ ] Decisão jurídica/trabalhista sobre uso do piloto comunicada aos 3
      colaboradores (transparência sobre o que a foto é/não é).
- [ ] Política de retenção definida (mesmo que "reter indefinidamente por
      ora, revisar em X meses").
- [ ] `ponto_config.piloto_ativo` alterado para `true` **manualmente e de
      forma deliberada** — nunca como efeito colateral de deploy.
- [ ] (Só se o objetivo for marcação direta, sem revisão por solicitação)
      componente de equipamento implementado, testado com desafio real
      (expiração e replay incluídos) e `EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA`
      alterado para `true` em código — nunca via configuração. **Sem isso,
      o piloto continua funcional apenas no modelo de solicitação auditada
      + aprovação humana (ver seção 2.5/2.6), o que é a operação esperada
      desta etapa.**

Este documento é a base para a implementação a seguir (migrations, rotas,
middlewares, telas). Decisões aqui tomadas (flag em vez de role nova,
reautenticação por senha, bucket privado + signed URL, equipamento em modo
demonstração) seguem diretamente as restrições explícitas do pedido original
e o estado real investigado do código — não são suposições.
