# Decisões pendentes e riscos — Notas de Entrada + DRE

Achados de negócio/contábeis levantados durante a reprodução local do fluxo
`fn_criar_nota_entrada` (`POST /api/notas-entrada`) e `GET /api/relatorios/dre`
(worktree `vivenzza-financeiro-dre-notas-repro`). Nenhum destes é corrigido
nesta tarefa — são decisões que cabem ao responsável pelo negócio/contábil,
não bugs com correção óbvia. Ver
`docs/financeiro/schema-real-producao-dre-notas-entrada.md` para o schema
completo confirmado e a proveniência de cada achado.

## 1. Conta a pagar gerada por Nota de Entrada nunca aparece no DRE

`fn_criar_nota_entrada` (com `gerar_conta_pagar=true`) insere em
`contas_financeiras` sem nunca preencher `categoria_dre`
(`supabase/migrations/20260101000065_notas_entrada.sql`). `calcularSecoesDoMes`
(`src/routes/relatorios.js`) só soma `contas_financeiras` filtrando por
`categoria_dre IN (...)` em cada seção (G/H/I/K). Resultado: uma compra de
fornecedor que gera conta a pagar fica **invisível em todas as seções do
DRE** — nem operacional, nem financeira, nem retirada. Reproduzido
empiricamente em `scripts/tests/collection/relatorios-dre.test.mjs`
("achado documentado: conta a pagar de Nota de Entrada não aparece em
nenhuma seção").

**Por que não é uma correção óbvia**: a Seção E (Custo Direto de
Mercadorias) já é calculada via `nfe_itens.quantidade × produtos.preco_custo`
no momento da **venda** (COGS, seção "Funções" do doc de schema). Se a
compra (Nota de Entrada) também virasse despesa operacional no momento da
**compra**, o mesmo custo de mercadoria poderia ser contado duas vezes: uma
vez como despesa na entrada, outra como custo direto na saída/venda —
dependendo de quando/se o produto é revendido dentro do mesmo período. A
decisão de qual categoria_dre (se alguma) atribuir a essa conta — e se isso
exige mudar também a Seção E para não haver dupla contagem — é do
responsável contábil.

## 2. `produtos.estoque` (coluna) e a tabela `estoque` nunca são sincronizadas

`produtos` tem uma coluna própria `estoque` (integer, default 0) **e** existe
uma tabela separada `estoque` (numeric(14,4), mantida por
`trg_atualizar_saldo` via `movimentacoes_estoque`). Confirmado lendo o corpo
verbatim de `fn_criar_nota_entrada` e `atualizar_saldo_estoque()`
(`supabase/migrations/20260101000064` e `000065`): **nenhuma das duas
função toca `produtos.estoque`**. Essa coluna fica sempre parada no valor
que tiver (default 0), dessincronizada do saldo real mantido na tabela
`estoque`.

**Risco**: qualquer tela/relatório/integração que leia `produtos.estoque`
diretamente (em vez de `estoque.quantidade`) mostra um número
permanentemente desatualizado, sem nenhum erro visível. Não há decisão aqui
sobre qual das duas fontes é "a certa" nem se `produtos.estoque` deveria ser
removida/preenchida — só o registro do fato para quem for decidir.

## 3. DRE recalcula custo ATUAL, não custo histórico, para períodos já decorridos

`GET /api/relatorios/dre` busca `produtos.preco_custo` **atual** (uma única
query, sem histórico/snapshot por nota/venda) para calcular a Seção E (Custo
Direto de Mercadorias) de qualquer mês, inclusive meses já decorridos. Não
há nenhum mecanismo de "fechamento contábil" observado neste sistema.

**Efeito prático**: alterar `preco_custo` de um produto hoje muda
retroativamente o Custo Direto — e todo o resultado dali para baixo (Lucro
Bruto, Operacional, Efetivo) — de **qualquer mês passado** que tenha vendido
esse produto, toda vez que o DRE for gerado de novo. Um DRE de um mês
fechado há 6 meses pode dar um resultado diferente hoje do que deu na época,
sem nenhuma mudança de dado transacional — só porque o custo cadastral do
produto mudou depois. Decisão pendente: se o sistema precisa de snapshot de
custo por venda (histórico), e a partir de quando isso passaria a valer.

## 4. `fn_criar_nota_entrada` não tem nenhuma proteção de idempotência

Nenhum `UNIQUE` em `numero_nota`/`serie`, nenhum advisory lock, nenhuma
checagem de duplicata dentro da função. Reenviar a mesma requisição HTTP
duas vezes (double-click, retry de rede, timeout do cliente sem confirmação
de sucesso) cria **duas notas de entrada completas e independentes** — dois
lançamentos de estoque, potencialmente duas contas a pagar. Reproduzido em
`scripts/tests/collection/notas-entrada-fluxo.test.mjs` ("sem idempotência:
repetir a mesma requisição cria duas notas"). Decisão pendente: se vale
adicionar uma constraint de unicidade (`numero_nota` + `fornecedor_cnpj`?
`numero_nota` + `serie`?) ou uma chave de idempotência no payload — e qual,
já que "duas notas idênticas de fornecedores diferentes no mesmo número"
pode ser um cenário real legítimo (numeração de NF é por fornecedor).

## 5. `fn_criar_nota_entrada` e `atualizar_saldo_estoque()` não têm `EXCEPTION WHEN`

Qualquer erro no meio da função (FK inválida, item malformado) propaga sem
ser capturado — reverte a transação inteira (nota, itens, estoque, custo,
conta a pagar), nunca deixa estado parcial. Isso é bom para consistência,
mas significa que o erro que chega no cliente HTTP é sempre um 500 genérico
com a mensagem crua do Postgres (`src/routes/notas-entrada.js` não trata o
`error` da RPC além de `if (error) throw error`) — não uma mensagem de
validação amigável. Comportamento real, não alterado nesta tarefa; registrado
aqui só para quem for melhorar a experiência de erro da rota no futuro.
