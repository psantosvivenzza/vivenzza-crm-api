# Auditoria — hipótese "SEM REPRESENTANTE" excluída por NULL em DataEmissao (14/09/2026)

Read-only na origem. Nenhum dado alterado, nenhuma sincronização real
disparada, nenhuma configuração de produção tocada.

## Hipótese investigada

Uma auditoria anterior levantou a hipótese de que linhas **SEM
REPRESENTANTE** estariam sendo excluídas da sincronização gerencial
(`EN_NotasRepres` → `vendas_gerenciais_netvision`) por tratamento implícito
de `NULL` na coluna `DataEmissao`, usada no filtro de período do job
(`src/jobs/sync-vendas-gerenciais-legado.js`).

## Método

Consulta **read-only e sanitizada** direto na origem (NetVision `e01`,
tabela `EN_NotasRepres`), sempre por filial/período/documento — nunca por
nome/CPF de cliente (esta tabela não guarda esse dado). Nenhuma escrita.

## Resultado — hipótese específica NÃO confirmada

1. **Zero linhas com `Representante` em branco** existem em `EN_NotasRepres`
   (filial 001, toda a série histórica de 8.252 linhas). O campo é `NOT
   NULL` e sempre populado com um código válido presente em
   `EN_Representantes`.
2. **224 linhas históricas** (filial 001) têm `DataEmissao IS NULL` — mas
   **todas** são de 2019–2020 e têm `ValorDocumento = 0,00`. Nenhuma tem
   valor monetário; nenhuma pode explicar uma divergência em R$ hoje.
3. **`EN_NotasRepres` e `EN_RepresMensal`** (tabela pré-agregada mensal,
   fonte independente, provável base real da tela "Consulta Vendas por
   Representante") **concordam exatamente** para setembro/2026, filial 001:
   24 documentos / **R$ 36.931,67** nas duas fontes, sem nenhuma linha "sem
   representante" em nenhuma delas. Isso bate exatamente com o que
   `executarSincronizacaoVendasGerenciais` já lê hoje para o mesmo
   filial+período — **zero divergência monetária ativa confirmada nesta
   auditoria**.
4. A janela exata do período (01–14/09 vs 01–30/09) não muda o resultado —
   não há documento futuro adiantado nem diferença de corte de data.
5. Nenhum documento de valor baixo (≤ R$15) nem documento fatiado em
   múltiplas linhas de representante (`GROUP BY Serie, NumeroDocumento
   HAVING COUNT(*) > 1`) foi encontrado no período — descarta explicações
   alternativas de arredondamento/soma parcial.

**Conclusão**: a divergência residual de R$10 referida na tarefa não foi
reproduzida contra os dados reais de produção no momento desta auditoria. A
hipótese original partiu de leitura de código sem acesso ao banco (sessão
anterior sem `E01_HOST`/`SUPABASE_URL` configurados no ambiente) — sem essa
verificação, não é possível distinguir uma suposição de um fato. Antes de
investir mais nesta hipótese específica, comparar novamente o total ao vivo
da tela NetVision com `EN_RepresMensal`/`EN_NotasRepres` no momento exato da
observação original, pois o legado é transacional e o total muda em tempo
real.

## Defeito latente real (corrigido nesta PR, independente da hipótese acima)

Mesmo sem confirmar a hipótese específica, o **padrão de código** era um
defeito real: `"DataEmissao" >= $2 AND "DataEmissao" <= $3` exclui qualquer
linha com `DataEmissao IS NULL` por lógica trivalorada do SQL — comparação
com `NULL` nunca é verdadeira — **sem nenhum log ou sinal**. As 224 linhas
históricas provam que isso já aconteceu (sempre com valor zero); nada
impede que aconteça de novo com valor real, e hoje isso desapareceria de
"Vendas do Mês" **para sempre, em silêncio**.

Correção mínima aplicada em `src/jobs/sync-vendas-gerenciais-legado.js`:

- Filtro `AND "DataEmissao" IS NOT NULL` tornado **explícito** na query
  principal (comportamento idêntico ao de hoje, agora autodocumentado).
- Nova checagem read-only companion (mesmo pool E01) conta/soma linhas com
  `DataEmissao IS NULL` na filial (sem filtro de período — essas linhas não
  têm período válido por definição) e gera um **aviso sanitizado**
  (`tipo: 'data_emissao_nula_nunca_sincronizavel'`, só `filial` +
  `quantidade` + `valor_total`, nunca representante/cliente) **sempre que o
  valor total for diferente de zero**, com log claro no console. As 224
  linhas históricas conhecidas (valor sempre zero) NÃO disparam aviso a
  cada ciclo — seria ruído puro pra uma condição inofensiva e já
  documentada; o objetivo é sinalizar o dia em que isso passar a ter
  impacto monetário real, não repetir pra sempre um achado sem efeito.
- **Nenhuma data é fabricada** para essas linhas nem elas entram no espelho
  — o objetivo é só visibilidade pra decisão manual futura, nunca inclusão
  forçada (não inventamos representante nem alteramos regra comercial).
- Testes adversariais novos (`scripts/tests/vendas-gerenciais-data-emissao-nula-20260914.test.mjs`,
  8 casos — 7 originais desta PR + 1 da revisão independente abaixo) provam:
  detecção/log do aviso, sanitização do aviso, ausência de
  falso positivo, comportamento idêntico em dry-run, que uma linha com
  `Representante` em branco **mas `DataEmissao` válida** já era e continua
  sendo incluída normalmente (nenhuma lógica de representante jamais
  excluiu uma linha aqui — provado, não só assumido), gatilho por linha
  (não soma) mesmo com estorno compensando o total líquido, e regressão do
  comportamento de leitura normal.
- Suíte de reconciliação de órfãos da PR #101
  (`vendas-gerenciais-reconciliacao-orfaos-20260914.test.mjs`) ajustada
  apenas pra reconhecer a nova query companion no pool fake — nenhuma
  mudança de comportamento, 11/11 testes continuam verdes.

## Migration 20260101000054 — status e ordem segura de rollout

A migration `20260101000054_sincronizacoes_vendas_gerenciais_reconciliacao.sql`
(mergeada via PR #101, adiciona `total_removido`, `reconciliacao_candidatos`,
`reconciliacao_motivo_bloqueio` em `sincronizacoes_vendas_gerenciais`) foi
confirmada por uma sessão anterior como **ainda ausente do schema live do
Supabase de produção** (ver handoff da sessão de 14/09, 2:04pm). Esta
auditoria não pôde reconfirmar isso diretamente — uma tentativa de leitura
read-only contra o Supabase de produção foi bloqueada pelo classificador de
modo automático desta sessão ("Production Reads") — mas não há motivo pra
desconfiar do achado anterior.

**Esta PR não depende dessa migration** — a correção de `DataEmissao NULL`
só toca a leitura do E01 e o array `avisos` já existente, nenhuma coluna
nova. Ainda assim, a coluna existente é usada por código já em produção
(job de sync, mergeado na PR #101), então a ordem seguraDeploy segue sendo:

1. **Aplicar a migration `20260101000054`** no Supabase de produção
   primeiro (é puramente aditiva — `ADD COLUMN IF NOT EXISTS` com
   `DEFAULT`, não quebra nenhum código já rodando, pode ser aplicada a
   qualquer momento sem downtime).
2. Confirmar que `sincronizacoes_vendas_gerenciais` passa a registrar
   `status='concluido'` (não mais preso em `'executando'`) após a próxima
   execução do `VivenzzaSyncVendasGerenciaisLegado`.
3. Só então (ou em paralelo, já que são independentes) fazer merge/deploy
   desta PR — não há ordem obrigatória entre as duas, mas a migration 54
   deveria ir primeiro por já estar pendente há mais tempo.
4. Opcional: monitorar o novo aviso `data_emissao_nula_nunca_sincronizavel`
   nos logs por alguns ciclos, pra confirmar que nenhum documento real
   (valor != 0) aparece sem `DataEmissao` — se aparecer, é o primeiro sinal
   real de que a hipótese original passou a se manifestar, e aí sim caberia
   decidir uma correção de inclusão (nunca automática, sempre com decisão
   humana sobre qual data usar).

## Revisão adversarial independente (14/09/2026, sessão separada)

Revisão independente desta PR (draft, sem merge/deploy) — confirmou GitHub
head `6b15e1f`/base `14972a7` (= `origin/main` atual), `MERGEABLE`, diff
conferido linha a linha, e reproduziu as 18 suítes (7+11) em Postgres
isolado (porta/banco dedicados desta tarefa, nunca 5432/5433/vivenzza_dev):
18/18 verde antes de qualquer alteração.

**Defeito real encontrado e corrigido nesta revisão**: o gatilho do aviso
usava `SOMA("ValorDocumento") != 0`, não uma contagem de linha individual
com valor != 0. Uma linha positiva e uma negativa (ex.: estorno/correção —
padrão já documentado nesta mesma tabela, ver docstring do módulo) com
`DataEmissao NULL` poderiam se compensar exatamente e zerar a soma líquida,
suprimindo o aviso mesmo havendo duas linhas reais com valor individual
diferente de zero — exatamente o cenário que este aviso existe pra pegar.
Corrigido: o gatilho agora conta `COUNT(*) FILTER (WHERE "ValorDocumento"
<> 0)`, nunca a soma. `valor_total` continua reportado no aviso como
contexto (pode legitimamente aparecer como `0,00` líquido mesmo com o
aviso disparado). Teste de regressão novo cobre exatamente esse caso
(8º caso da suíte de `DataEmissao NULL`, agora 8/8; suíte de órfãos segue
11/11 sem mudança de comportamento). Nenhuma mudança de escopo, migration
ou regra comercial.

**Ressalva sobre a linha de base usada por esta auditoria (não corrigida —
fora do escopo de uma PR mínima, só documentada aqui)**: a conclusão
"zero divergência monetária ativa" desta auditoria apoia-se em
`EN_NotasRepres` concordar com `EN_RepresMensal` para o período corrente.
Dois achados no próprio repositório enfraquecem essa base como prova da
divergência de R$37.179,77 (print oficial que motivou a PR #101, mesma
filial/período, 24 vendas) contra o R$36.931,67 lido por esta auditoria
(também 24 documentos):

1. `VENDAS_DO_MES_RECONCILIACAO.md` (14/08/2026, domínio fiscal) documenta
   que **`EN_RepresMensal` "tem bug comprovado"** e que a tela
   `RE_Consulta02` — mesmo nome de relatório citado no docstring do módulo
   de sync como fonte do "oficial" — é **baseada em PEDIDO**
   (`StatusPedido=5`/`Cancelado=0`, menos pedidos cujo(s) documento(s)
   fiscal(is) são só CFOP não-venda), **não** em soma de linhas de
   nota/documento por representante. É uma fórmula estruturalmente
   diferente de somar `EN_NotasRepres`/`EN_RepresMensal`.
2. A afirmação no docstring de `sync-vendas-gerenciais-legado.js` e no
   commit da PR #53 ("comprovado por reconciliação exata: bateu
   Ana/Diego/Nicole/Tais... até o centavo, ver
   `VENDAS_DO_MES_RECONCILIACAO.md`") **não tem lastro no conteúdo atual
   desse arquivo** — ele foi escrito em 14/08/2026, treze dias antes de
   `EN_NotasRepres` ser sequer descoberto (PR #53, 27/08/2026), e não
   menciona essa tabela em nenhum lugar. Não encontrei, em `git log
   --all`, nenhum outro documento com essa reconciliação específica
   (`Nicole` não aparece em nenhum arquivo do repositório fora do próprio
   comentário de código).

**Conclusão desta ressalva**: a concordância `EN_NotasRepres` ×
`EN_RepresMensal` encontrada nesta auditoria prova consistência **entre
essas duas fontes**, mas não prova (nem esta auditoria, nem a citação no
código, afirmam prova reproduzível) que qualquer uma delas bate com o
número que o usuário efetivamente viu na tela (`RE_Consulta02`/"Consulta
Vendas por Representante") no momento do `print oficial` de R$37.179,77.
A diferença de R$248,10 com contagem de documentos idêntica (24 = 24)
permanece **não explicada por nenhuma evidência lida nesta revisão** — é
compatível tanto com (a) deriva transacional normal do legado entre os
dois momentos de observação (hipótese já levantada pela auditoria
original) quanto com (b) um descasamento de metodologia entre
`RE_Consulta02` (pedido) e `EN_NotasRepres` (documento/representante) que
nunca foi reconciliado registro a registro para este read-model
específico, ao contrário do que foi feito para o indicador fiscal em
`VENDAS_DO_MES_RECONCILIACAO.md`. Nenhuma das duas hipóteses foi testada
com dados de produção nesta revisão (sem acesso ao E01/Supabase de
produção neste ambiente). Próximo passo seguro: repetir, com autorização
explícita e acesso à produção, a mesma ponte documento-a-documento feita
em `scripts/ponte-pedido-nota.mjs` (mas para `EN_NotasRepres`, não
`EN_Notas`) contra `RE_Consulta02` ao vivo, no mesmo instante — nunca
comparar leitura ao vivo com número de tela antigo.

## Fora de escopo (não tocado nesta PR)

- Nenhuma migration nova, nenhuma mudança de schema.
- Nenhuma sincronização real disparada, nenhum dado de produção alterado.
- Nenhuma mudança de regra comercial, nenhum representante inventado.
- Scheduler, NetVision, Supabase (além desta leitura), WhatsApp, NF-e —
  intocados.
