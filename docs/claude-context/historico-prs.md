# Histórico resumido de PRs relevantes

Resumo curto — para o detalhe completo, ver o código e a descrição da PR
no GitHub. Todas mergeadas, salvo indicação em contrário.

## Backend (`vivenzza-crm-api`)

| PR | Objetivo |
|---|---|
| #44 | Consolida cobrança de títulos do mesmo cliente/vencimento numa única mensagem. |
| #45 | Persiste em Git o worker real de sync financeiro NetVision→CRM. |
| #46 | Segrega WhatsApp Financeiro do CRM Comercial/Vendas. |
| #47 | Hotfix: fallback de schema para `whatsapp_mensagens` sem coluna `instance_name` em produção. |
| #48 | Suprime reenvio repetido para número já confirmado como inválido no mesmo dia (versão anterior à quarentena de 30 dias). |
| #49 | Rate limit passa a contar tentativas reais ao provider, não só sucesso. |
| #50 | Sync financeiro residente e resiliente (Task Scheduler). |
| #51 | Sync fiscal residente e agendado. |
| #52 | Remove fallback inseguro de certificado (senha no caminho do arquivo). |
| #53 | Read-model de vendas gerenciais via `EN_NotasRepres`. |
| #54 | Testes provando que o pool de instâncias WhatsApp já suporta N instâncias sem mudança de código. |
| #55 | Circuit breaker: `PERMANENT_RECIPIENT` deixa de afetar a saúde da instância. |
| #56 | Kit portátil de instalação do servidor de voz definitivo. |
| #57 | Quarentena de 30 dias para telefone confirmado como `PERMANENT_RECIPIENT`. |
| #58 | Prioridade de celular sobre fixo na seleção do telefone de cobrança. |
| #59 | Fila de revisão cadastral de telefones inválidos (backend). |

## Frontend (`vivenzza-crm-frontend`)

| PR | Objetivo |
|---|---|
| #9 | Card "Vendas do Mês" do dashboard passa a usar a fonte gerencial. |
| #10 | Tela "Revisão de Contatos" (Financeiro → Cobranças), consome a PR #59. |

## Como usar este histórico

Quando uma tarefa pedir "por que isso foi feito assim", procure a PR pelo
número/objetivo aqui, depois confirme os detalhes reais no código —
mensagens de commit e o diff da PR sempre têm mais contexto do que cabe
nesta tabela.
