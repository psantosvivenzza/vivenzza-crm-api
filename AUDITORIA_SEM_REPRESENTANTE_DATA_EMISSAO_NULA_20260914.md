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
  6 casos) provam: detecção/log do aviso, sanitização do aviso, ausência de
  falso positivo, comportamento idêntico em dry-run, que uma linha com
  `Representante` em branco **mas `DataEmissao` válida** já era e continua
  sendo incluída normalmente (nenhuma lógica de representante jamais
  excluiu uma linha aqui — provado, não só assumido), e regressão do
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

## Fora de escopo (não tocado nesta PR)

- Nenhuma migration nova, nenhuma mudança de schema.
- Nenhuma sincronização real disparada, nenhum dado de produção alterado.
- Nenhuma mudança de regra comercial, nenhum representante inventado.
- Scheduler, NetVision, Supabase (além desta leitura), WhatsApp, NF-e —
  intocados.
