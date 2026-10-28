# Logística do frete: proteção offline do carregamento de cadastro

Escopo: caracterização de `carregarCadastroFisicoDoPedido` e sua colaboração com `calcularLogisticaPedido`. Não altera comportamento de produção.

Executar `npm run test:pedidos:logistica`: 19 testes, sendo 13 novos para ausência de itens/cadastro, propagação de erros, limites de 1000/1001 itens, vínculos ausentes, deduplicação de IDs, lotes de 100 produtos, manutenção da ordem e rejeição de total parcial quando falta produto ou logística. Os casos de cálculo usam unidades comprovadas por snapshot sintético e controle positivo de totais numéricos.

Os novos testes importam apenas o módulo de funções locais. O banco é um double de leitura; não há SDK, dotenv, worker, conexão NetVision/Supabase ou envio. Fixtures inteiramente sintéticas. Nenhuma dependência adicionada.

## Complemento HTTP — 17/10/2026

Executar `npm run test:pedidos:logistica` (19 testes) e, separadamente, `npm run test:fretes:http:offline` (8 HTTP): 27 aprovados. O segundo comando requer Node >=22.15 para `registerHooks` (confirmado em Node 24.16); foi separado para não impor esse requisito aos 19 testes anteriores ou ao runtime de produção. A rota Express real `GET /fretes/pedidos/:numero` é exercitada em `127.0.0.1`, com banco de leitura sintético e adaptadores Supabase/NetVision reais bloqueados antes do import. Não lê `.env`, não conecta ao banco e não registra cotação ou envio.

Com flag `FRETE_NETVISION_LEITURA_DIRETA` ausente ou `false`, confirma zero chamadas ao carregador do legado e uso do snapshot. Também cobre carga manual quando não há dados físicos, fallback em erro de catálogo, prevalência do cadastro local, fallback da leitura direta opt-in indisponível, proteção de itens editados e bloqueio do papel vendedor antes de consultar dados. Controles positivos verificam peso/cubagem numéricos, não somente valores vazios.

A leitura direta é **opt-in**, não uma dependência obrigatória da rota por padrão. Isso caracteriza o código; não comprova qual valor da flag está configurado no Railway. O teste injeta usuário sintético e usa a autorização por papel real; autenticação JWT/mount global, busca sem filial, ambiguidade/ausência de pedido e papel financeiro não estão homologados aqui.

Limites: não homologa REST/RLS do Supabase, unidades reais, qualidade do catálogo, snapshots em produção nem o fluxo completo de criar/enviar/receber cotação. Não prova independência integral da NetVision. Não ativa WhatsApp, IA ou sincronização, nem autoriza migração ou desligamento do legado. Nenhum código de produção alterado.
