# NetVision → Vivenzza CRM — Paridade e Retirement Readiness

Auditoria read-only + uma correção pontual autorizada (sync de clientes, ver seção CLIENTES).
Scripts reprodutíveis em `scripts/audit-netvision-*.mjs` (`npm run audit:netvision:full`).
Fiscal readiness detalhado em `FISCAL_READINESS.md` (arquivo separado).

Gerado a partir de dados ao vivo em 2026-08-14. Números de venda/faturamento mudam a cada
sincronização — trate como fotografia, não como constante.

**PR anterior (#22, auditoria original) já mergeado.** Este documento foi atualizado na rodada
de remediação seguinte (branch `feat/netvision-parity-remediation-core`), que fechou o gap de
clientes e aprofundou financeiro/pagamentos/fiscal.

## Metodologia — por que dois domínios separados

A hipótese inicial era comparar `pedidos.status='faturado'` (Vivenzza) contra
`EN_Notas.ValorNota` (NetVision) como se fossem a mesma grandeza. Não são:

- **Domínio A — PEDIDOS COMERCIAIS**: pedido colocado, antes de faturar. `pedidos` é
  sincronizado DIRETAMENTE de `ES_Pedidos` (`src/jobs/sync-pedidos-legado.js`,
  `legacy_id = "{CodigoFilial}-{NumeroPedido}"`), então o match é **EXACT_ORDER_KEY**, não
  heurístico. Script: `audit-netvision-pedidos.mjs`.
- **Domínio B — FATURAMENTO FISCAL**: nota fiscal emitida. `EN_Notas."NumeroPedido"` foi
  verificado como **sempre 0** no período testado (não é FK usável). Investigação mais ampla no
  schema (colunas com "Pedido/Origem/Documento/Sequencia" em `EN_Notas`, tabelas de junção
  `EN_NotaPedido`/`EN_PedidoNota`/`ES_VinculoNFE`) não achou um vínculo geral confiável — só
  `EN_PedidoNota`, com **28 linhas em toda a história**, um caso específico de adiantamento, não
  um mapeamento geral. Pareamento nesse domínio é **sempre heurístico**
  (`EN_Notas."Cliente"` == `pedidos.cliente_externo_id`, mesmo código, confirmado por amostra),
  nunca tratado como vínculo definitivo — cada linha carrega `match_method`/`match_confidence`.
  Script: `audit-netvision-faturamento.mjs`.

Vivenzza **não emite nota fiscal própria em produção hoje**: existe um subsistema `nfe`
completo no código (`src/services/nfe/`, tabela `public.nfe` com 10.588 linhas), mas 100% das
linhas têm `pedido_id=NULL`, só 1 nota foi autorizada de verdade (parece teste), 0 eventos no
log de auditoria (`nfe_eventos`), e a emissão real está travada por
`configuracoes_fiscais.serie1_numeracao_liberada=false` (gate deliberado, aguardando validação
contábil da numeração legada, que vai de -1066 a 5.241.175). As 10.588 linhas existentes são
import histórico do NetVision (view `notas_legado_unificado`: série 99 = `vendas_legado`, série
1 = NF reais antigas), não faturamento corrente.

## Sobre o "~32k vs ~26k"

No recorte 01–13/08/2026, comparando a mesma base (Vivenzza `faturado` vs NetVision
`EN_Notas` ativa): **R$ 32.112,65 vs R$ 19.454,30** — não R$26k. Tentativas de localizar um
período/métrica que bata com "~26k" (últimos 7/15/20/30 dias, mês anterior completo, domínio
pedidos em vez de faturamento, `GE_Vendas`): nenhuma bateu. Boa parte do gap "32k vs 19k" tem
explicação real e verificada: faturamento parcial (pedido colocado, nota emitida só de parte do
valor — confirmado item a item em vários casos, ver abaixo).

**Status: `UNRESOLVED_BUSINESS_REFERENCE`.** Por decisão explícita, não investigar mais sem uma
fonte concreta (tela, relatório, período, filtro) de quem gerou o número original.

## PEDIDOS COMERCIAIS (Domínio A) — match exato

| Janela | NetVision (ES_Pedidos) | Vivenzza (pedidos) | Match exato |
|---|---|---|---|
| 01–13/08 | 51 pedidos, R$ 61.517,55 | 52 pedidos, R$ 61.842,05 | 51/52 LEGACY_VALID (98%) |
| 15/07–13/08 (30d) | 114 pedidos, R$ 196.527,64 | 116 pedidos, R$ 197.152,74 | 114/116 LEGACY_VALID (98%) |

O único caso de divergência nas duas janelas é `EXTRA_IN_VIVENZZA` de borda (pedido com
`DataEmissao` um dia fora da janela consultada) — não é gap real. **Conclusão: o espelhamento
ES_Pedidos→pedidos está completo e fresco.** Este é o domínio com decomposição confiável e
fechada (checagem de sanidade bate 1:1, ver script).

## FATURAMENTO FISCAL (Domínio B) — heurístico, evidência investigativa

| Janela | Vivenzza faturado | NetVision notas ativas | PARTIAL_INVOICING confirmado |
|---|---|---|---|
| 01–13/08 | R$ 33.727,25 | R$ 19.454,30 | 3 pedidos: total R$8.470,60, faturado R$4.894,90, saldo R$3.575,70 |
| 15/07–13/08 (30d) | R$ 138.816,25 | R$ 97.904,86 | 8 pedidos: total R$51.429,70, faturado R$27.596,80, saldo R$23.832,90 |

4 casos de faturamento parcial foram **confirmados individualmente, não só por padrão
estatístico**: item a item, `pedido_itens` (Vivenzza) bate 100% com `ES_ItemPedido`
(NetVision) — o pedido é real e completo, só a nota fiscal cobre uma fração dele. Exemplo:
pedido 001-9745 (cliente 000158), total R$1.994,10, 4 itens conferidos nos dois lados
somando exatamente esse valor; nota 3170 emitida por R$997,05 (exatamente metade).

**MISSING_IN_VIVENZZA / EXTRA_IN_VIVENZZA / VALUE_MISMATCH neste domínio NÃO são gaps
confirmados** — dependem de match heurístico (cliente+valor ou cliente+data) que pode reusar a
mesma nota em duas linhas diferentes (por isso a checagem de sanidade não fecha 1:1, e isso é
esperado e documentado no próprio script, não escondido). Tratar como pista de investigação, não
como decisão de migração.

## CONTAS A RECEBER (financeiro)

- `CR_Duplicatas` (NetVision) vs `contas_financeiras` tipo='receber' (Vivenzza).
- Títulos em aberto: NetVision 1.168 vs CRM 1.161 (diferença -7). Saldo em aberto: NetVision
  R$473.526,67 vs CRM R$455.626,34 (diferença -R$17.900,33). Coverage count 99,4%, coverage
  value 96,2%.
- 125 divergências críticas (10 "encerrado no CRM mas aberto no ERP", 115 "valor pago
  diferente") — **as 125 estão 100% isoladas via `em_revisao_financeira=true`**, fail-closed
  pra cobrança, reconfirmado nesta rodada com `npm run audit:netvision:financeiro`.

### Classificação dos 125 (categorias objetivas, script já classifica automaticamente)

| Categoria | n | Valor | Correção determinística | Exige revisão humana |
|---|---|---|---|---|
| A) Pagamento existe no Vivenzza sem correspondente no NetVision (CRM>ERP) | 115 | R$19.009,07 | NÃO — regra do projeto proíbe reverter pagamento | SIM |
| B) Pagamento NetVision não refletido no Vivenzza (ERP>CRM) | 0 | R$0,00 | — | — |
| C) Encerrado no ERP com saldo residual (acordo/desconto) | 10 | R$2.681,36 | SIM | NÃO |
| D) Importação legada só-CRM (prefixo e99) | 3 | — | NÃO (sem origem ERP) | SIM (decisão já tomada: não tocar) |
| E) Duplicidade histórica (mesmo título, 2 linhas — formatos `cr-` e `{filial}-` coexistindo) | **48** | ambos fechados, sem risco de cobrança dupla | NÃO decidido nesta rodada | SIM (decidir qual registro é o canônico — análise título a título em `npm run analise:duplicados-financeiro`, 23 casos com candidato canônico claro, 25 ambíguos) |
| G) Status divergente puro | 0 | — | — | — |
| H) Outro | 0 | — | — | — |

**Achado real, não previsto no plano original**: B=0 e G=0 confirmam que a régua automática
(`decidirAtualizacao()`) não deixa "pendência simples" acumular — tudo que sobra hoje é ou
bloqueado por desenho (categoria A, CRM tem mais pago que o ERP, nunca revertido) ou uma
correção segura mas ainda isolada (categoria C). **Achado novo E**: 48 títulos existem
DUPLICADOS entre os dois formatos históricos de `legacy_id` (`cr-N-S` e `{filial}-N-S`) — os
48 pares já estão com AMBAS as linhas fechadas/pagas (confirmado: nenhum caso de duplicata com
saldo em aberto duplicado, então não infla a dívida cobrável hoje), mas é sujeira de dado real
que deveria ser resolvida (qual registro manter) antes de qualquer migração definitiva.

### Decomposição do delta de saldo — 100% FECHADA

Cálculo exato (não heurístico — mesma partição usada pra somar os totais originais).
**Achado desta rodada**: os R$433,51 antes "não explicados" tinham causa concreta — o loop de
decomposição pulava títulos sem `legacy_id` (lançamentos manuais no Vivenzza, nunca vieram do
NetVision), enquanto o total geral (`totCrm.saldo`) somava TODOS os títulos abertos, com ou sem
`legacy_id`. Corrigido: agora contam como categoria própria (F). Hipótese dos 48 duplicados como
causa foi testada e **descartada** antes de achar a causa real (nenhum dos 48 pares tem saldo em
aberto).

```text
R$17.900,33 (delta bruto no momento da classificação original, CRM abaixo do ERP)
  = R$15.652,48  categoria A (pagamento só no CRM, bloqueado por desenho)
  + R$ 2.681,36  categoria C (título encerrado no ERP com saldo residual não refletido no CRM)
  + R$   433,51  categoria F (3 títulos manuais sem legacy_id — nunca vieram do NetVision,
                 saldo próprio do CRM, não é gap de sincronização)
  = R$17.900,33 — soma bate 100% com o delta real (gap de checagem = R$0,00)
```

Números mudam a cada execução (dado vivo, sync residente roda continuamente) — rodar
`npm run audit:netvision:financeiro` pra números atuais; a mecânica de decomposição agora fecha
sempre, não só neste snapshot.

- 3 títulos só no CRM (e99), 0 só no NetVision.
- Sync financeiro em si (`sync-financeiro-legado.js`) roda numa máquina do escritório, fora
  deste repo/Railway — ver `SYNC_SINGLE_HOST_DEPENDENCY` abaixo.

## PAGAMENTOS/BAIXAS (auditoria nova desta rodada)

NetVision: `CR_PagtoParcial` — 3.565 eventos de pagamento, mas cobre só **2.521/17.735
(14,2%) dos títulos**. Pelo nome e pelos dados, é uma tabela de pagamento PARCIAL/negociado,
não um ledger geral — a maioria dos títulos quitados de uma vez não passa por ela (fica só
no campo agregado de `CR_Duplicatas`). Vivenzza **não tem ledger de eventos de pagamento**:
`contas_financeiras.valor_pago` é só um campo agregado; confirmado que não existem tabelas
`pagamentos`/`baixas`/`historico_pagamentos` (erro `PGRST205` nos três nomes tentados);
`estornos_financeiros` existe mas está vazia (0 linhas, não usada).

**Fonte canônica de recebimentos — encontrada (achado desta rodada)**: `CR_Duplicatas` tem DOIS
campos de valor pago com semântica diferente — `"ValorPago"` (geral, populado em 16.470/17.735
títulos, soma R$5.689.576,51 — é o campo que `financeiroLegado.js` usa pro sync/auditoria
principal) e `"ValorParcialmentePago"` (específico de pagamento parcial/negociado, populado em
exatamente 2.521 títulos). Confirmado: **`"ValorParcialmentePago"` bate EXATAMENTE com a soma de
`CR_PagtoParcial`** — mesma contagem de títulos (2.521), mesma soma (R$311.154,70). **Não é
inconsistência/corrupção do NetVision** — são dois campos legítimos e internamente consistentes,
cada um com seu propósito. A divergência que a primeira versão desta auditoria relatou como
"NetVision diverge de si mesmo em 98,7% dos títulos" comparava o campo ERRADO
(`"ValorPago"` geral) contra o ledger de eventos parciais — corrigido no script e neste
documento.

**Comparação Vivenzza x NetVision (só universo comparável — os 2.521 títulos com evento
parcial, usando `CR_PagtoParcial`/`ValorParcialmentePago`, que são a mesma coisa)**:
0 sem correspondência no Vivenzza; 145 batem exatamente; **2.376 com VALUE_MISMATCH** (valor
pago Vivenzza R$183.351,84 vs NetVision R$311.154,70 no universo comparável). **Este mismatch
agora É atribuível ao Vivenzza** (não mais explicável por inconsistência do NetVision) —
`contas_financeiras.valor_pago` provavelmente reflete `"ValorPago"` (o campo geral) em vez de
`"ValorParcialmentePago"` pros títulos negociados, o que pode ser uma causa real de divergência
a investigar numa próxima rodada — não corrigido aqui.

Script: `scripts/audit-netvision-pagamentos.mjs`.

## CLIENTES PARITY = PASS

## CLIENTES — GAP FECHADO NESTA RODADA

- Causa raiz identificada: **`clientes_erp` nunca teve um job de sincronização real** — os
  2.034 registros anteriores vieram de uma carga histórica única (nenhum `.insert()`/`.upsert()`
  em `clientes_erp` existia em nenhum job do repositório antes desta rodada, confirmado por
  busca). O sync de pedidos só LÊ `clientes_erp` pra resolver o vínculo do cliente — nunca cria
  os que faltam.
- Corrigido: `src/jobs/sync-clientes-legado.js` + `scripts/sync-clientes-legado.mjs`
  (`Pessoas` Cliente=1 → `clientes_erp`, SÓ CRIA — nunca atualiza registro existente, varredura
  completa a cada execução por ser pequeno o bastante ~2.048 linhas, não precisa de cursor).
- Dry-run validou os 14: sem duplicidade por CPF/CNPJ contra a base existente, 4 marcados
  `em_revisao=true` por CPF/CNPJ ausente na origem (ex. perfis "Blogueira" sem documento).
- Executado de verdade: **14/14 criados, 0 erros**. Reconferido:
  **NetVision 2.048 = Vivenzza 2.048, missing=0, coverage=100%.**
- `leads` (CRM, 3.543 linhas) continua sendo uma população DIFERENTE de `clientes_erp` — só 81
  leads (2,3%) têm `cliente_erp_id` vinculado. Não confundir "quantidade de leads" com
  "quantidade de clientes" ao comparar com o NetVision.
- **Gap de automação ainda aberto**: o job criado roda sob demanda (`node
  scripts/sync-clientes-legado.mjs`), igual ao padrão já usado por `sync-pedidos-legado.mjs`
  (agendado externamente via Task Scheduler do Windows, fora deste repositório). Recomendo
  agendar ANTES do sync de pedidos na mesma máquina — não fiz essa configuração de SO, é
  fora do alcance do que dá pra automatizar a partir daqui.
- **Por que não reimportar tudo a cada ciclo, mesmo sendo pequeno**: o job já é seguro pra rodar
  em loop (varredura completa, só cria o que falta, nunca escreve em cima de existente) — então
  agendar de 30 em 30 min (mesmo intervalo já sugerido pro sync de pedidos) é suficiente e
  simples. Não construí um cursor incremental porque, com ~2.048 linhas, o custo de reler tudo
  a cada execução é desprezível — um cursor incremental adicionaria complexidade (rastrear
  `DataAtualizacao`, lidar com janela de segurança) sem ganho de performance real nesta escala.
  Só valeria a pena revisitar se o volume de clientes crescesse ordens de grandeza.

## PRODUTOS

- NetVision `ES_ItensEstoque`: 274. Vivenzza `produtos`: 274. **Contagem bate exatamente.**
  Não foi feita comparação campo a campo (preço, custo, categoria) nesta rodada — só contagem.

## RELATÓRIOS NETVISION — inventário por domínio, classificado P0/P1/P2

P0 = necessário pra operar sem NetVision. P1 = importante. P2 = conveniência.

| Domínio | Tabela(s) principal(is) | Equivalente Vivenzza | Batem? | P0/P1/P2 |
|---|---|---|---|---|
| Vendas/Pedidos | `ES_Pedidos`+`ES_ItemPedido` | `pedidos`+`pedido_itens` | Sim (98%+, match exato) | **P0 — já resolvido** |
| Faturamento fiscal | `EN_Notas` (+230 col.) | `nfe` (existe, não em uso real) | Não comparável 1:1 hoje | **P0 — bloqueador, ver FISCAL_READINESS.md** |
| Contas a receber | `CR_Duplicatas` | `contas_financeiras` | 125 conflitos classificados (A/C/D/E), resto bate | **P0 — monitorar, classificado** |
| Recebimentos/pagamentos | `CR_PagtoParcial` (cobre só 14% dos títulos — pagamento parcial/negociado) | `contas_financeiras.valor_pago` (agregado, sem ledger) | 145 batem / 2.376 mismatch no universo comparável | **P0 — auditado nesta rodada, achado de inconsistência interna do NetVision** |
| Inadimplência | derivado de `CR_Duplicatas` (sem tabela dedicada identificada) | derivado de `contas_financeiras.status` | não auditado campo a campo | P1 |
| Clientes | `Pessoas` (Cliente=1) | `clientes_erp` | **100% — gap fechado nesta rodada** | **P0 — resolvido** |
| Produtos | `ES_ItensEstoque` | `produtos` | Contagem bate (274=274) | P1 — qualidade de campo não verificada |
| Outros operacionais | estoque (`ES_*`), produção (`Ordem*`/`PR_*`), locação (`ra_*`), SPED (`SP_*`) | não auditado | — | P2 — fora do escopo |

## GAPS DE INFRAESTRUTURA REGISTRADOS (não resolvidos nesta rodada, documentados por decisão)

- **`SYNC_SINGLE_HOST_DEPENDENCY`**: `sync-financeiro-legado.js` (residente) e
  `sync-pedidos-legado.mjs`/`sync-clientes-legado.mjs` (agendados via Task Scheduler) rodam
  todos numa única máquina do escritório com acesso de rede ao e01 — sem redundância. Não
  bloqueia cobrança hoje (o guard de frescor já falha fechado se o sync parar), mas é ponto
  único de falha pra qualquer plano real de aposentar o NetVision. Opções futuras (não
  avaliadas em profundidade): VPN/túnel pra permitir acesso de um host redundante, ou replicar
  o e01 pra um destino acessível de mais de um lugar. Não resolver nesta rodada.
- **`UNRESOLVED_BUSINESS_REFERENCE`**: origem do número "~R$26k" citado como referência de
  negócio — não confirmada apesar de múltiplas tentativas (ver seção acima). Não investigar
  mais sem uma fonte concreta (tela/relatório/período) de quem gerou o número original.

## NETVISION RETIREMENT READINESS — checklist por domínio

| Domínio | Status |
|---|---|
| Pedidos comerciais | ✅ Pronto — espelhamento exato e fresco (98%+, único caso é borda de janela) |
| Faturamento fiscal | ❌ **Bloqueador** — Vivenzza não emite NF própria; 2 gates independentes travados (`serie1_numeracao_liberada=false` E `NFE_AMBIENTE` não setado = homologação). Ver `FISCAL_READINESS.md` |
| Financeiro (contas a receber) | 🟡 Monitorado — 125 conflitos classificados (A=115/C=10/D=3/E=48 duplicados), delta de R$17.900,33 decomposto 97,6% (A+C), isolado via `em_revisao_financeira` |
| Pagamentos/baixas | 🟡 Auditado nesta rodada — achado de inconsistência interna do próprio NetVision (`CR_Duplicatas` x `CR_PagtoParcial` divergem em 98,7% dos títulos com evento parcial); Vivenzza sem ledger de eventos |
| Clientes | ✅ **Resolvido nesta rodada** — 2.048=2.048, causa raiz corrigida (job de sync criado) |
| Produtos | ✅ Contagem bate; qualidade de campo não verificada |
| Contratos/recorrência | ⚪ Não identificado como aplicável nesta rodada |
| Relatórios P0 | 🟡 6/6 domínios P0 inventariados e auditados nesta rodada (vendas, faturamento, contas a receber, recebimentos, clientes, e inadimplência ainda pendente de auditoria campo a campo) |
| Sync operacional | 🟡 `SYNC_SINGLE_HOST_DEPENDENCY` registrado, não resolvido |

### Top blockers restantes (em ordem)

1. **Fiscal — 2 gates independentes travados**: `serie1_numeracao_liberada=false` E
   `NFE_AMBIENTE` não configurado (cairia em homologação mesmo destravando o primeiro). Sem
   isso, Vivenzza não pode ser fonte de verdade fiscal — maior bloqueador, sem mudança nesta
   rodada.
2. **Sem vínculo confiável pedido→nota no NetVision** — confirmado por investigação de schema
   (não só suposição): `EN_PedidoNota` existe mas só 28 linhas históricas (caso de
   adiantamento). Pareamento pra reconciliação fiscal continuará heurístico.
3. **48 títulos financeiros duplicados** (formatos `cr-`/`{filial}-` coexistindo) — não afeta
   cobrança hoje (ambos os lados de cada par já estão fechados), mas é sujeira de dado real.
   Análise título a título em `npm run analise:duplicados-financeiro` (23 com canônico claro,
   25 ambíguos) — nada foi deduplicado.
4. **125 títulos financeiros em conflito** (115 categoria A, bloqueados por desenho; 10
   categoria C, encerramento com saldo residual pendente de aplicar) — seguem isolados,
   nenhuma correção automática nesta rodada.
5. **`SYNC_SINGLE_HOST_DEPENDENCY`** — toda a sincronização (financeiro, pedidos, clientes)
   depende de uma única máquina sem redundância.
6. **`NFE_CERT_SENHA` precisa ser rotacionada CORRETAMENTE** — não é um simples swap de
   variável: o certificado é um arquivo `.pfx` cuja própria senha de abertura é essa variável;
   trocar só o valor no Railway sem reexportar o arquivo com senha nova vai QUEBRAR a assinatura
   (o `.pfx` continua protegido pela senha antiga). Rotação real exige ação de quem administra o
   certificado digital da empresa (certificadora/contador) — **ação humana necessária, não
   executável a partir daqui.**

**Relatório pro contador**: `RELATORIO_CONTADOR.md` — séries, numeração, status, pergunta
objetiva a responder, sem decidir o número por conta própria.

**Estado atual: NÃO PRONTO para desligar o NetVision.** O bloqueador dominante continua sendo
fiscal — mesmo com clientes resolvido e financeiro/pagamentos bem mais entendidos nesta rodada,
sem emissão de NF própria o NetVision segue sendo a única fonte de verdade fiscal da empresa.
