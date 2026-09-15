# Meu Ponto (piloto) — manual curto e status honesto

Este documento complementa `ESPECIFICACAO_MEU_PONTO.md` (arquitetura e
decisões), `MATRIZ_REQUISITO_IMPLEMENTACAO_TESTE.md` (mapeamento
requisito → código → teste) e `PROPOSTA_COMPONENTE_EQUIPAMENTO.md`
(próxima etapa: verificação real de equipamento). Aqui: como usar, o que
está funcional de verdade, o que é simulado, e o que falta para qualquer
coisa além de um piloto interno.

## 1. Manual do colaborador ("Meu Ponto")

Nesta etapa, **toda marcação é uma solicitação** — não existe registro
direto/imediato, porque o equipamento usado ainda não é verificado
automaticamente. Um gestor revisa e decide antes de virar um registro
oficial.

1. Acesse **Meu Ponto** no menu (só aparece se você foi habilitado por um
   administrador — ter conta no CRM não habilita sozinho).
2. Clique **Solicitar marcação**, escolha o tipo (a sugestão já vem
   marcada, mas você pode trocar).
3. Foto (opcional, mas recomendada): clique **Ativar câmera**, aguarde a
   prévia aparecer, clique **Capturar**. A foto é só evidência para revisão
   humana — não há verificação automática de identidade por ela. Sem
   câmera disponível, siga sem foto — não é tratado como falta.
4. Escreva a **justificativa** (sempre obrigatória — diga o que está
   registrando e, se não tiver foto, por quê).
5. Confirme sua **senha atual** (sempre exigida, mesmo com sessão aberta) e
   clique **Enviar solicitação**. Só é sucesso quando a tela confirmar —
   nunca assuma que enviou só porque clicou. Se a conexão falhar depois do
   clique, use o botão **Consultar status** em vez de reenviar às cegas.
6. Acompanhe em **Minhas solicitações de marcação** se está pendente,
   aprovada ou rejeitada, com a justificativa do gestor quando houver.
7. Em **Histórico confirmado**, veja só as marcações já aprovadas. Peça
   **correção** quando algo já confirmado estiver errado — isso é
   diferente de solicitar uma marcação nova.

## 2. Manual do gestor de ponto

1. Acesse **Gestão de Ponto** (só aparece se você tem escopo concedido por
   um administrador, ou se você é admin).
2. Você só vê os colaboradores explicitamente vinculados a você.
3. Em **Solicitações de marcação pendentes**, é o coração do piloto nesta
   etapa: cada tentativa de um colaborador aparece aqui. Clique
   **Revisar**, veja a foto (se houver) e a justificativa, e
   **Aprove**/**Rejeite** com justificativa própria. Aprovar cria o
   registro oficial; rejeitar não cria nada. Você não pode decidir sobre
   uma solicitação sua.
4. Em **Solicitações de correção pendentes**, revise pedidos de ajuste
   sobre marcações **já confirmadas** (categoria diferente da anterior).
5. Filtre marcações confirmadas por colaborador/período, abra fotos (link
   temporário, gerado na hora).
6. Exporte **CSV** ou **PDF** — é um *relatório de conferência do piloto*,
   não um documento regulamentar (nunca chame de AFD/AEJ nem entregue como
   comprovante oficial ao contador sem ele validar o layout antes).

## 3. Manual do administrador ("Administração de Ponto")

1. **Colaboradores habilitados**: liga/desliga o piloto por pessoa —
   independente do papel dela no CRM.
2. **Escopo de gestores**: concede/revoga qual gestor vê qual colaborador.
3. **Equipamentos**: cadastro/revogação em *modo demonstração* — nenhuma
   marcação exige isso nesta etapa (ver seção 5).
4. **Trava mestra do piloto**: liga/desliga a possibilidade de qualquer
   marcação nova, para todo mundo, imediatamente. Nasce **desligada**.
   Ativar é uma decisão deliberada — nunca deve acontecer sozinha por
   causa de um deploy.

## 4. O que está funcional de verdade

Validado com testes de integração automatizados (70/70 no backend — `npm
run test:ponto`, Postgres isolado — mais 4/4 de um utilitário puro do
frontend, `node --test scripts/tests/csvSafety.test.mjs`) e com validação
visual real em navegador (Playwright/Chromium, screenshots em
`vivenzza-crm-frontend/docs/meu-ponto/validacao-visual/`), cobrindo os três
papéis (colaborador, gestor, admin). Ver
`MATRIZ_REQUISITO_IMPLEMENTACAO_TESTE.md` para o mapeamento completo.

**As três travas são distintas — não resuma como "nada vira marcação"**
(ver especificação, seção 0.2): marcação DIRETA fica bloqueada enquanto o
equipamento não for verificável; SOLICITAÇÃO + aprovação humana PODE (e
deve) criar uma marcação, isso é o design; piloto desativado bloqueia
solicitações novas e aprovações, mas não bloqueia rejeitar.

- Habilitação por colaborador (flag, não role), com histórico de alteração;
  revogação vale imediatamente mesmo com JWT antigo ainda válido (testado).
- **Bloqueio estrutural de marcação direta**: `POST /marcacoes` (criação
  sem revisão) fica 501 incondicionalmente enquanto
  `EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA=false` — testado inclusive com
  `piloto_ativo=true`, senha correta e foto válida.
- **Solicitação auditada é o único caminho real (interface provisória, não
  o objetivo final — ver especificação seção 0.2)**: `POST /solicitacoes`
  cria uma linha pendente (com ou sem foto, sempre justificativa,
  sempre reautenticação por senha); só vira marcação de verdade após
  aprovação humana de um gestor, sempre `sinalizado_para_revisao=true`.
- **Aprovação é atômica de verdade**: `ponto_decidir_solicitacao`/
  `ponto_decidir_correcao` (funções Postgres, migration 050) — uma chamada
  é uma transação só. Testado com falha REAL injetada via trigger durante
  o `INSERT` da marcação: a solicitação permanece `pendente` (nunca fica
  presa em "aprovada" sem marcação correspondente). `FOR UPDATE` serializa
  decisões concorrentes; `UNIQUE INDEX` em `ponto_marcacoes.origem_solicitacao_id`
  garante no banco (não só em JS) que nenhuma solicitação gera duas
  marcações. Retry após timeout recupera a decisão já tomada em vez de
  arriscar duplicar.
- **`usuarios.ativo` revalidado em TODA rota do módulo**, não só decisão
  (achado da revisão de 2026-09-11: checar isso só em decisão era
  insuficiente) — colaborador, gestor e admin desativados perdem acesso
  imediatamente a histórico, foto, correções, solicitações, gestão e
  administração, mesmo com JWT antigo ainda válido. Testado
  exaustivamente por rota (`usuario-inativo-todas-rotas.test.mjs`).
- **Autorização real dentro das funções Postgres, não só no Express**:
  `SECURITY INVOKER` explícito, `search_path` fixo, `EXECUTE` revogado de
  `PUBLIC` (testado com um papel Postgres restrito de verdade, não
  superusuário — recebe erro de permissão real). A função valida
  internamente que o decisor está ativo e tem escopo real sobre o
  colaborador — mesmo chamando a função direto, contornando o Express
  inteiramente, um decisor forjado é rejeitado. Ver
  `MATRIZ_AUTORIZACAO_ENDPOINTS.md`.
- **Vínculo solicitação/correção ↔ marcação continua único e rastreável
  nos dois sentidos** (FK real preservada — uma tentativa anterior de
  remover a FK pra simplificar limpeza de teste foi revertida; o problema
  era só ordem de limpeza, corrigido sem enfraquecer o schema). Referência
  órfã testada e rejeitada de verdade (violação de FK real, não simulada).
- **Três instantes nunca confundidos**: horário declarado pelo colaborador
  (opcional, auto-relatado) ≠ horário de recebimento no servidor
  (automático, é o que vira `registrado_em`) ≠ horário da decisão do
  gestor. Colaborador não troca autor/horário recebido/status enviando
  esses campos no corpo — testado enviando os 4 forjados e confirmando
  zero efeito.
- Idempotência real por `operacao_id` (UNIQUE no banco): duplo clique,
  retry de rede ou requisições concorrentes nunca duplicam (testado com 3
  requisições simultâneas reais); mesmo `operacao_id` com conteúdo
  diferente vira conflito explícito (409), nunca é tratado como a mesma
  tentativa.
- Recuperação após timeout: `GET /solicitacoes/por-operacao/:id` consulta
  o resultado sem reenviar foto/senha.
- Limite de tentativas (rate limit) contra tentativa repetida de senha, por
  usuário.
- Captura de foto real pela webcam (getUserMedia + canvas), com validação
  de formato/tamanho no backend (assinatura de bytes, não só o
  `mime_type` declarado) e armazenamento em bucket privado + URL assinada
  de curta duração (nunca URL pública).
- Falha parcial entre foto e registro tratada explicitamente — **testado
  com falha real injetada via trigger do Postgres**, não simulada; foto
  órfã documentada, nunca apagada automaticamente. Storage indisponível
  também testado com falha real (diretório de destino inválido).
- Correções (sobre marcação já confirmada) e solicitações (registrar
  agora) em tabelas separadas; aprovação sempre gera uma **nova** linha em
  `ponto_marcacoes`, a original nunca é editada; autoaprovação bloqueada
  em dois níveis (aplicação + `CHECK` no banco) nas duas tabelas; decisão
  concorrente (dois gestores ao mesmo tempo) só deixa uma valer, testado
  com corrida real.
- Escopo de gestor aplicado em toda consulta/decisão (nunca vê ou decide
  fora do que foi concedido); papel financeiro não vira gestor
  automaticamente; admin vê tudo.
- Exportação CSV com proteção contra fórmula maliciosa (`=`, `+`, `-`, `@`
  no início de célula), extraída para módulo testável.
- `ponto_config.piloto_ativo` nasce `false` — camada adicional e
  independente do bloqueio por equipamento (ver seção 5).

## 5. O que é simulado / não está aplicado nesta etapa

- **Identificação de equipamento**: schema e endpoints existem
  (`ponto_equipamentos`, `ponto_desafios`), mas **nenhuma marcação exige
  assinatura de equipamento hoje**. Não há agente local instalado em
  computador real, não há chave protegida pelo SO, não há desafio de uso
  único sendo de fato consumido. Cadastro/revogação funcionam apenas como
  registro administrativo (`modo=demonstracao`, forçado no backend mesmo
  que o cliente peça outro valor). Isso é reforçado por uma constante de
  código (`EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA=false`), não uma flag de
  banco — ver seção 4.
- **Bucket `ponto-fotos` no Supabase**: não foi criado em nenhum ambiente
  real (nem staging, nem produção) — só existe como comportamento
  verificado em armazenamento local de teste. Passo manual pendente.
- **Migrations `20260101000048`/`20260101000049`**: validadas num Postgres
  local isolado, **não aplicadas em produção**.
- **Equivalência com Supabase/PostgREST real**: os testes rodam contra
  Postgres real (constraints, UNIQUE INDEX, triggers, transações reais),
  mas não contra o Supabase real — comportamento HTTP-específico do
  PostgREST (formato exato de erro), pooling e Storage real não foram
  exercitados. Documentado no cabeçalho de
  `scripts/tests/ponto/solicitacoes-marcacao.test.mjs`.

## 6. Pendências honestas para ir além do piloto interno

**Segurança operacional:**
- Aplicar as duas migrations em produção (manualmente, como todo o resto
  do projeto — não há pipeline automático).
- Criar o bucket privado `ponto-fotos` e confirmar que credenciais
  públicas não alcançam Storage nenhum.
- Decidir e implementar o componente local de identificação de
  equipamento (ou aceitar operar permanentemente no modelo de solicitação
  auditada + aprovação humana, documentando essa escolha).

**Conformidade REP-P e documentos aplicáveis** (ver
`PESQUISA_CONTROLE_PONTO_VIVENZZA_2026-09-10.md` na raiz do repo):
- Nada aqui gera AFD/AEJ, não há registro INPI, não há assinatura digital
  homologada, não há garantia de hora legal brasileira redundante.
- Antes de qualquer uso como registro oficial, revisar com assessoria
  trabalhista se os 3 colaboradores/estabelecimento exigem REP-P e se este
  piloto pode ou não ser complementado por ele.

**Privacidade/retenção:**
- Não há política de retenção de fotos definida — nada é excluído
  automaticamente. Precisa de decisão jurídica antes de qualquer exclusão
  automática ou de qualquer prazo de guarda.
- Hipótese legal para tratamento de imagem/dados ainda não definida com o
  responsável jurídico.

**Jornada e arquivo do contador:**
- Nenhuma regra de jornada, banco de horas, hora extra, adicional ou
  tolerância foi inventada — o piloto só registra e sinaliza pendência.
- O layout de exportação para o contador não foi validado com ele.
- **"Horário efetivo trabalhado" não está definido** (achado da revisão de
  2026-09-11): o sistema guarda três instantes — declarado pelo
  colaborador (auto-relatado), recebido no servidor (automático, mas pode
  ser bem depois do evento real), e da decisão do gestor — mas nenhum dos
  três é apresentado nem deve ser tratado como "a hora que a pessoa
  trabalhou". Calcular isso exige uma decisão de negócio/jurídica que
  ainda não foi tomada.

**Custos:**
- Nenhum serviço pago foi contratado nesta etapa.
- Custo incremental esperado: armazenamento de fotos pequenas no Supabase
  Storage (3 pessoas, poucas marcações/dia — desprezível no plano atual).
- Se o componente local de equipamento avançar para produção, considerar
  custo/esforço de assinatura digital e manutenção do serviço Windows.

## 7. Como reproduzir os testes e a validação visual

- Backend: `npm run test:ponto` dentro de `vivenzza-meu-ponto-backend`
  (sobe sozinho contra o cluster isolado descrito em
  `scripts/tests/ponto/_config.mjs` — nunca 5432/5433/vivenzza_dev/produção).
- Visual: `vivenzza-crm-frontend/docs/meu-ponto/validacao-visual-script.mjs`
  (cabeçalho do arquivo documenta os passos de setup local).
