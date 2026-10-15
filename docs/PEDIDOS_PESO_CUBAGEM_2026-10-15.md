# Peso e cubagem dos pedidos — 15/10/2026

Implementado nas branches locais `codex/cotacoes-frete` da API e da interface. Não publicado; migrations não aplicadas à produção e nenhuma sincronização de escrita executada no legado ou na base real.

## Comportamento

O detalhe do pedido exibe peso bruto do cabeçalho, peso bruto dos produtos, cubagem e cálculo por produto. Os valores unitários são multiplicados pelas quantidades atuais do CRM. Não há soma parcial quando falta um dado. A embalagem adicional exige conferência humana.

O cadastro NetVision fornece `PesoBruto`, `QtdeVolumeCubico` e `Un` em `ES_ItensEstoque`. Dimensões individuais não são reconstruídas a partir da cubagem. `StatusMedidasCubicas` não é uma unidade física. Códigos numéricos não são interpretados automaticamente como kg ou m³.

A unidade de venda vem do item explicitamente ou do snapshot local `ES_ItemPedido.Unidade`, ligado por código de produto com unidade unívoca. A unidade do cadastro do produto nunca substitui a unidade vendida. Na ausência de unidade confiável ou com divergência CX/UN, o cálculo fica indisponível. Um override local dos itens impede reutilizar unidades do snapshot legado. Isso mantém a conferência funcionando com dados já espelhados no CRM sem consulta ao legado em cada abertura.

## Importação e ativação

Migration adicional: `20261015183819_produtos_logistica_fisica.sql`, coluna JSONB `produtos.logistica_fisica`. Depende também da migration anterior `20261015155158_frete_logistica_pedido.sql` para snapshots dos pedidos.

Com `FRETE_LOGISTICA_SYNC_ATIVA=true`, o suplemento físico roda depois do fluxo comercial, com orçamento de 30 segundos e até 500 atualizações por execução. Só altera metadados físicos de produtos já vinculados; preserva preço, estoque e dados manuais. Conteúdo idêntico não é regravado; comparação de versão impede sobrescrever edição concorrente. Paginação incompleta retorna estado parcial. Leitura vazia ou falha do legado preserva snapshot anterior.

Configurações `NETVISION_LOGISTICA_UNIDADE_PESO` e `NETVISION_LOGISTICA_UNIDADE_CUBAGEM` ficam vazias até confirmação operacional. Depois de confirmadas, reexecutar o sync. São gravadas nos metadados apenas quando os códigos do catálogo completo são uniformes. A exigência conservadora de uniformidade foi mantida de propósito: divergência exige conferência em vez de conversão presumida. A seleção de unidade na interface é apenas visual e não grava no cadastro.

A conexão emprestada do pool para leitura por pedido usa transação somente leitura, timeout no servidor e liberação em finally. API e tela preservam o pedido comercial se o suplemento físico falhar. O botão de atualizar diferencia erro de leitura de cadastro ainda não sincronizado. Publicar API antes da interface.

## Validação

46 testes de domínio, fila, API e sincronização passaram, incluindo PostgreSQL local isolado, proteção do cache, concorrência, unidade de venda diferente, dados ausentes, leitura vazia e conversões explícitas. Testes de navegador cobrem totais/subtotais, atualização, reset de unidades, unidade não suportada, precisão e celular. Build da interface validado. Revisão crítica Claude executada nos dois repositórios; achados válidos corrigidos.

Pendências de publicação: aplicar migrations, confirmar unidades físicas, executar sincronização controlada, validar equivalência de totais com um pedido real e validar o CAS via PostgREST em homologação. Nenhum envio real a transportadoras foi feito.

Memória canônica reconciliada em 15/10/2026: fonte `27454ab3-240e-41fb-b028-95aa3909361f`, estado `ready` confirmado. Incidente de acesso recuperado e registrado na fonte `7258904a-c216-476c-b625-c5b5da22e99e`, também `ready`. Demonstração local de pedido validada no navegador após a revisão final, com tráfego externo bloqueado.
