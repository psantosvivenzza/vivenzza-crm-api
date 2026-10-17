# Logística do frete: proteção offline do carregamento de cadastro

Escopo: caracterização de `carregarCadastroFisicoDoPedido` e sua colaboração com `calcularLogisticaPedido`. Não altera comportamento de produção.

Executar `npm run test:pedidos:logistica`: 19 testes, sendo 13 novos para ausência de itens/cadastro, propagação de erros, limites de 1000/1001 itens, vínculos ausentes, deduplicação de IDs, lotes de 100 produtos, manutenção da ordem e rejeição de total parcial quando falta produto ou logística. Os casos de cálculo usam unidades comprovadas por snapshot sintético e controle positivo de totais numéricos.

Os novos testes importam apenas o módulo de funções locais. O banco é um double de leitura; não há SDK, dotenv, worker, conexão NetVision/Supabase ou envio. Fixtures inteiramente sintéticas. Nenhuma dependência adicionada.

Limites: isso não homologa REST/RLS, unidades reais, qualidade do catálogo, snapshots em produção ou o fluxo HTTP completo. Não prova independência integral da NetVision. Não ativa WhatsApp, IA ou sincronização, nem autoriza migração ou desligamento do legado.
