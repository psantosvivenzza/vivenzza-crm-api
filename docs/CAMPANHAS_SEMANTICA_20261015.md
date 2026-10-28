# Campanhas: contrato de eventos e consulta

Incremento local de 15/10/2026, base API origin/main 75b5f4f83c61d9cf873d90a9bf11fb77883c9c47. Sem alteração de anúncios, orçamento, jobs ou credenciais.

Google: metrics.conversions retorna tipoResultado=conversao, resultados (inclusive fracionário) e custoResultado. Campos legados conversas/custoConversa retornam null. Custo sem conversões e alcance indisponível são null. Histórico usa conversoes, nunca conversas.

Meta: metricas separa conversa, lead e compra observados. Nome não determina objetivo. Aliases sobrepostos usam máximo (convenção conservadora mantida), nunca soma. Resultado genérico existe somente para uma família não zero; com múltiplas ou nenhuma é null, enquanto os zeros reais permanecem em metricas. Histórico não soma famílias. Limite de 40 páginas falha explicitamente em vez de retornar série truncada como completa. Evento não prova cadastro CRM, venda recebida ou ROAS.

dados.consultadoEm: hora UTC do fim da leitura. atualizadoEm, moeda e fuso da conta são null quando não comprovados; não inventar consolidação do provedor. Falha de período anterior é comparacaoDisponivel=false. Configuração ausente retorna 503 com código CAMPANHAS_NAO_CONFIGURADO; 503 genérico não prova ausência de configuração.

Janelas existentes preservadas: Meta datas inclusivas UTC e dia corrente (potencialmente 31 datas); Google LAST_30_DAYS segue conta. Frontend separa fontes e não oferece comparativo dessas janelas. Leitura anterior Meta permanece por compatibilidade, embora novo painel não exiba deltas. Conciliar janelas/atribuição e confirmar moeda/fuso são próximos incrementos.

Validação final: 11/11 testes via node --test scripts/tests/unit/campaigns-contract.test.mjs, Node 24.16.0; três regressões Meta falharam antes da correção. Rotas reais com Router e provedores simulados; sem rede/banco/credenciais reais. Não comprova contrato HTTP/autenticação/produção. Evidências consolidadas em output/VIVENZZA_CAMPANHAS_VERIFICACAO_20261015.json no workspace.

Publicação futura: frontend compatível primeiro, depois API. Frontend novo tolera backend antigo sem reciclar conversões como conversas; API nova com frontend antigo pode exibir zero em conversas Google. Sem push/merge/deploy neste incremento.
