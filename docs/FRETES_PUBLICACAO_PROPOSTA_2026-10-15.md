# Frete: proposta separada de banco e configuração

**Não executada em produção.** Este documento apresenta os passos que dependem da aprovação do usuário. Preparar e testar código não autoriza aplicar esta proposta nem ligar envios, IA ou sincronização real.

## Migrações propostas, nesta ordem

1. `20261014140810_cotacoes_frete_fornecedores.sql`: configuração/telefone/consentimento de fornecedores, cotações, consultas, mensagens, fila e RPCs, com índices e acesso restrito ao backend.
2. `20261015155158_frete_logistica_pedido.sql`: snapshot físico no pedido.
3. `20261015183819_produtos_logistica_fisica.sql`: espelho físico no produto.
4. `20261015194843_frete_concorrencia_orcamento.sql`: versões atômicas de configuração/proposta, auditoria de opt-out, controle de orçamento e reservas do legado. Cria gatilhos na reserva de frete e na criação de tentativa v2 para que ambos disputem a capacidade sob a mesma trava transacional. Nenhum teto global ou por instância é aumentado.

A quarta migração deixa o orçamento **inativo**. Nesse estado, frete não pode consumir uma reserva, o comportamento financeiro anterior é preservado e o remetente legado continua funcionando. Na primeira ativação é fixado o instante de corte do histórico; depois dele, reservas de legado são contadas mesmo quando o provedor falha. Trocar o motor não apaga o consumo. Reservas ambíguas não são devolvidas automaticamente.

A implantação deve validar o journal, objetos, grants/RLS e índices existentes nas colunas de data das tentativas, frete e cobranças antes de executar. As novas tabelas mantêm RLS e revogam acesso de anon/authenticated. Não mudar policies preexistentes de fornecedores. A migração não modifica valores financeiros, estoque, notas ou pedidos comerciais. Aplicar em janela controlada e avaliar o tempo das travas de DDL. O ensaio de aplicação/rollback do schema completo ocorreu somente em PostgreSQL sintético local.

## Configuração inicial proposta

| Configuração | Valor inicial |
| --- | --- |
| `FRETE_MODULO_INSTALADO` | `true`, somente após as quatro migrações e validação do schema |
| `FRETE_ENVIO_ATIVO` | `false` |
| `FRETE_IA_ATIVA` | `false` |
| `FRETE_LOGISTICA_SYNC_ATIVA` | `false` |
| `FRETE_NETVISION_LEITURA_DIRETA` | `false` |
| `NETVISION_LOGISTICA_UNIDADE_PESO` | vazia até confirmação de kg/g na origem |
| `NETVISION_LOGISTICA_UNIDADE_CUBAGEM` | vazia até confirmação de m³/cm³/litro na origem |

Não recriar, ler ou trocar chaves existentes. Nomes de Anthropic/Evolution estão presentes no Railway, mas isso não prova conectividade. Instância de frete fixa: `vivenzza-financeiro`. Confirmar também a instância configurada para o remetente financeiro legado antes da ativação do orçamento. Modelo previsto: `claude-sonnet-4-6`; habilitar interpretação é decisão separada de publicar o módulo.

API primeiro, interface depois. Antes da promoção, reconsultar o estado remoto e os deploys para não sobrescrever publicação de outro responsável. O frontend do candidato já integrou as correções publicadas de WhatsApp e referência de data do painel de voz; nenhum WIP de Campanhas foi incorporado.

## Ativação do orçamento: mudança de banco separada

Depois de instalar o código instrumentado em **todos** os processos remetentes, impedir novos disparos durante a transição e aguardar terminar os envios em andamento. Essa drenagem é indispensável: um processo antigo não instrumentado não pode enviar enquanto a contagem nova é ativada. Não alterar automações automaticamente; coordenar uma janela operacional aprovada.

Somente então, após confirmação específica, executar como serviço a função `frete_ativar_orcamento(p_instancia_legado)`, informando a instância financeira legada verificada. A função usa uma trava transacional comum, fixa o corte e não permite reassociar o histórico a outra instância em uma reativação. Validar concorrência e RPC via PostgREST em homologação antes desse passo; os testes locais usam PostgreSQL real, mas não substituem essa validação do transporte REST.

O orçamento ativo mantém os limites existentes, inclusive nas reservas que não terminarem em sucesso. A contagem pode ser conservadora ao incorporar histórico de um motor legado anterior; nunca ajustar os tetos para contornar o bloqueio. Validar o consumo do dia antes de liberar o primeiro lote.

Publicar a interface em modo manual não liga este orçamento nem envia mensagens. Ligar `FRETE_ENVIO_ATIVO` e `FRETE_IA_ATIVA`, cadastrar consentimentos e executar sincronização real são liberações próprias, posteriores. Para o sync físico, confirmar unidades e executar em máquina com acesso à rede NetVision; Railway não ganha esse acesso pela publicação.

## Conferência e reversão

Após aprovação/aplicação, validar leitura autenticada, edição com versão atual e rejeição da versão antiga, sem disparar cotação. Versões de timestamp devem ser devolvidas literalmente pelo cliente, incluindo microssegundos; não reserializar por `Date`. Confirmar total com um pedido real antes de usar os dados em uma solicitação de frete.

Se for necessário interromper a operação, pausar primeiro envios e IA de frete. Preservar tabelas, reservas e histórico. Uma reversão de interface pode usar o último deployment confirmado na hora. Reverter a API para código anterior à instrumentação exige drenagem e reconciliação do consumo: código antigo ignora reservas novas e pode subcontar o dia. Preferir manter a API corrigida com o frete pausado enquanto se avalia a falha. Não desligar `FRETE_MODULO_INSTALADO`, remover o orçamento ou apagar reservas para liberar capacidade. Não executar DROP automático.

Nenhuma dessas ações de produção foi executada na preparação desta entrega.
