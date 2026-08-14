# NetVision → Vivenzza CRM — Paridade e Retirement Readiness

Auditoria read-only. Nenhum dado foi corrigido, importado ou alterado em nenhum dos dois bancos.
Scripts reprodutíveis em `scripts/audit-netvision-*.mjs` (`npm run audit:netvision:full`).

Gerado a partir de dados ao vivo em 2026-08-14. Números de venda/faturamento mudam a cada
sincronização — trate como fotografia, não como constante.

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
pedidos em vez de faturamento, `GE_Vendas`): nenhuma bateu. **Não foi possível confirmar a
origem exata do número "~26k"** — precisa vir de quem gerou o relatório original (período,
tela/relatório do NetVision, filtro de filial/status usado). Boa parte do gap "32k vs 19k" tem
explicação real e verificada: faturamento parcial (pedido colocado, nota emitida só de parte do
valor — confirmado item a item em vários casos, ver abaixo).

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
  R$473.526,67 vs CRM R$455.626,34 (diferença -R$17.900,33).
- 125 divergências críticas (10 "encerrado no CRM mas aberto no ERP", 115 "valor pago
  diferente") — **as 125 estão 100% isoladas via `em_revisao_financeira=true`**, fail-closed
  pra cobrança, confirmado nesta auditoria (não é número antigo reafirmado sem checar: rodado
  agora, `npm run audit:netvision:financeiro`).
- 137 títulos totais em revisão financeira (>125 — mais alguns isolados desde a rodada
  anterior, esperado com o sync residente rodando continuamente).
- 3 títulos só no CRM, 0 só no NetVision.
- Sync financeiro em si (`sync-financeiro-legado.js`) roda numa máquina do escritório, fora
  deste repo/Railway — histórico completo dessa investigação está fora do escopo desta branch
  (que é só o comparador read-only).

## CLIENTES

- NetVision: `Pessoas` (`Cliente`=1) — 2.048 registros (2.037 ativos). `CGC_CPF` preenchido em
  1.753 (85,6%), telefone/celular em 1.701 (83,0%), e-mail em 589 (28,8%).
- Vivenzza: `clientes_erp` — 2.034 registros (2.023 ativos). CPF/CNPJ 1.743 (85,7%), telefone
  1.693 (83,2%), e-mail 588 (28,9%).
- **Diff exato por código** (`Pessoas.CodigoPessoa` == `clientes_erp.legacy_id`): **14 clientes
  existem no NetVision e ainda não em `clientes_erp`** (códigos 002298–002314, cadastros
  recentes). 0 clientes existem só no Vivenzza. Esses 14 já aparecem em `pedidos` via
  `cliente_externo_id` (o pedido foi sincronizado), mas o registro de cadastro do cliente em si
  ainda não — indica que o sync de clientes está um passo atrás do sync de pedidos.
- `leads` (CRM, 3.543 linhas) é uma população DIFERENTE de `clientes_erp` — só 81 leads
  (2,3%) têm `cliente_erp_id` vinculado. Não confundir "quantidade de leads" com "quantidade de
  clientes" ao comparar com o NetVision.

## PRODUTOS

- NetVision `ES_ItensEstoque`: 274. Vivenzza `produtos`: 274. **Contagem bate exatamente.**
  Não foi feita comparação campo a campo (preço, custo, categoria) nesta rodada — só contagem.

## RELATÓRIOS NETVISION — inventário por domínio

| Domínio | Tabela(s) principal(is) | Equivalente Vivenzza | Batem? | Prioridade |
|---|---|---|---|---|
| Vendas/Pedidos | `ES_Pedidos`+`ES_ItemPedido` | `pedidos`+`pedido_itens` | Sim (98%+, match exato) | Baixa — já resolvido |
| Faturamento fiscal | `EN_Notas` (+230 col.) | `nfe` (existe, não em uso real) | Não comparável 1:1 hoje | **Alta — bloqueador de retirement** |
| Contas a receber | `CR_Duplicatas` | `contas_financeiras` | 125 conflitos isolados, resto bate | Média — monitorar |
| Recebimentos/pagamento | `EN_Pagamentos` (ligado a `RegistroNF`, forma de pagto por nota) | não auditado nesta rodada | — | Baixa nesta rodada |
| Clientes | `Pessoas` (Cliente=1) | `clientes_erp` | 99,3% (14 faltando) | Média — fácil de fechar |
| Produtos | `ES_ItensEstoque` | `produtos` | Contagem bate (274=274) | Baixa |
| Outros operacionais | estoque (`ES_*`), produção (`Ordem*`/`PR_*`), locação (`ra_*`), SPED (`SP_*`) | não auditado | — | Fora do escopo desta rodada |

## NETVISION RETIREMENT READINESS — checklist por domínio

| Domínio | Status |
|---|---|
| Pedidos comerciais | ✅ Pronto — espelhamento exato e fresco (98%+, único caso é borda de janela) |
| Faturamento fiscal | ❌ **Bloqueador** — Vivenzza não emite NF própria (`serie1_numeracao_liberada=false`), comparação com NetVision só heurística |
| Financeiro (contas a receber) | 🟡 Monitorado — 125 conflitos isolados via `em_revisao_financeira`, sync residente ativo, nenhum bate incondicionalmente |
| Pagamentos/baixas | ⚪ Não auditado nesta rodada |
| Clientes | 🟡 Quase pronto — 14/2.048 (0,7%) ainda não sincronizados |
| Produtos | ✅ Contagem bate; qualidade de campo não verificada |
| Contratos/recorrência | ⚪ Não identificado como aplicável nesta rodada |
| Relatórios críticos | 🟡 Inventariado (tabela acima); comparação campo a campo pendente pros de faturamento/pagamento |
| Sync operacional | 🟡 Roda fora do Railway/repo (máquina do escritório), sem redundância documentada |

### Top 5 bloqueios reais para desligar o NetVision

1. **Emissão fiscal própria desligada** — `configuracoes_fiscais.serie1_numeracao_liberada=false`.
   Sem isso, Vivenzza não pode ser a fonte de verdade fiscal; é o maior bloqueador.
2. **Sem vínculo confiável pedido→nota no NetVision** — mesmo com o Vivenzza emitindo, a
   migração/validação do histórico fiscal do NetVision não tem uma chave de ID exata pra
   conferir 1:1 (só heurística cliente+valor).
3. **14 clientes não sincronizados** — pequeno, mas é sync incompleto ativo, não histórico.
4. **125 títulos financeiros em conflito, sem correção automática** (por decisão deliberada) —
   precisam de revisão manual antes de qualquer corte de dependência do NetVision como fonte.
5. **Sync financeiro roda numa máquina do escritório**, fora de Railway/CI — ponto único de
   falha não documentado/redundante; se essa máquina cair, o guard de frescor já bloqueia
   cobrança (proteção existe), mas o retirement de verdade precisa desse processo rodando em
   algum lugar confiável, não um desktop.

**Estado atual: NÃO PRONTO para desligar o NetVision.** O bloqueador dominante é fiscal
(item 1) — sem emissão de NF própria, o NetVision continua sendo a única fonte de verdade
fiscal da empresa, independente de quão bem os outros domínios estejam sincronizados.
