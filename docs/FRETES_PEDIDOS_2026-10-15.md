# Fretes — telefone no cadastro e importação por pedido

Data: 15/10/2026. Estado: implementado e testado localmente; não publicado nem validado com pedido real em produção. Sem commits/PRs deste incremento.

## Comportamento

Novo fornecedor na tela de fretes aceita razão social, CNPJ e WhatsApp com DDD, participação e consentimento explícito. POST /api/fretes/transportadoras é restrito a admin, cria fornecedor e configuração de frete na mesma operação e mantém telefone_cotacao_frete como fonte de telefone desta finalidade (contatos genéricos não são sobrescritos). Cadastro sem consentimento fica inelegível para envios. CNPJ legado com ou sem máscara é localizado; concorrência devolve 201/409, sem duplicar a linha.

Nova cotação permite buscar número do pedido NetVision e filial opcional. GET /api/fretes/pedidos/:numero usa somente pedidos sincronizados sistema_origem=legado. Número duplicado entre filiais exige filial; a filial informada deve corresponder ao código na origem (sem padding presumido). Cancelado, conflito e pendência de sincronização são recusados no GET e revalidados no POST da cotação.

Destinatário e endereço vêm do cliente vinculado; se faltarem dados, ficam em branco com aviso. CPF é aceito para destinatário, mantendo CNPJ nos demais papéis. Retirada e pagador são sugeridos pelo cadastro do emitente e exigem conferência da filial/local real. Valor é o total comercial do pedido, não uma NF-e confirmada; precisa ser conferido, especialmente em embarque parcial. Importar não altera pedido, estoque ou financeiro.

Peso bruto total e quantidade de volumes vêm do pedido, quando presentes. A logística de produtos soma quantidade por peso/cubagem apenas quando todos os itens têm dados positivos e a unidade de venda corresponde à unidade de manipulação. Não soma parcialmente faltantes nem mistura códigos de peso divergentes. StatusMedidasCubicas não é tratado como unidade: mesmo com cadastros consistentes o resultado é apenas sugestão bruta.

A interface exige selecionar a unidade de origem para aplicar a sugestão de cubagem (m³, cm³ ou litros/dm³); não preenche um valor desconhecido como se fosse m³. Quando o pedido não tem peso total, a sugestão dos produtos exige escolher kg ou g. Conversão tem precisão de seis casas e pode ser corrigida manualmente. Conferência de destinatário, retirada, valor, peso/cubagem e carga embalada é obrigatória para pedido importado. Servidor grava conferido_por e conferido_em e mantém pedido_origem.

Volumes podem ser informados por quantidade e dimensões ou por quantidade total e cubagem total. O segundo modo não fabrica comprimento/largura/altura; perguntas da transportadora por dimensões ausentes vão para revisão humana. Payload omite campos do modo não escolhido. Modo manual para frete de fornecedor permanece disponível.

## Integração e publicação futura

Migration gerada pela CLI Supabase: 20261015155158_frete_logistica_pedido.sql. Apenas adiciona pedidos.frete_logistica JSONB, sem backfill, exclusões, alteração de valores ou ativação automática.

FRETE_LOGISTICA_SYNC_ATIVA=false por padrão. Depois de migration aprovada, habilitar no processo existente de sync local de pedidos para guardar snapshot de ES_ItemPedido/ES_ItensEstoque. Verificação de coluna indisponível desabilita o suplemento sem parar sincronização comercial. Erro em logística preserva snapshot anterior e deixa dados comerciais seguirem; itens com override local não são consultados. Pedidos antigos precisam ser reprocessados pelo sync autorizado para receber o snapshot; mudança apenas no cadastro do produto não garante cursor do pedido atualizado.

FRETE_NETVISION_LEITURA_DIRETA=false por padrão. Opcional em backend com acesso à LAN NetVision; tenta SELECTs somente leitura, parametrizados e limitados por tempo. Railway não alcança essa LAN diretamente: em produção usar snapshot do sync local. Falha de consulta direta retorna os dados sincronizados disponíveis e aviso, sem escrever no pedido. Não usar credenciais ou banco real nos testes.

Flags existentes de instalação/envio/IA continuam desativadas por padrão. Limites compartilhados, fail-closed de contagem e uma cotação aberta por telefone continuam decisões do MVP. Envio bloqueado por DNC/cadastro agora pausa a consulta e mostra revisão. Para desfazer o incremento, desabilitar as duas flags novas/reverter aplicação e preservar a coluna/snapshots.

## Evidências

- Metadados Supabase e NetVision consultados somente para confirmar campos/tipos/chaves. SELECT logístico compilou no NetVision com filial/número inexistentes, retornando zero itens; nenhum pedido/cliente real foi importado ou alterado.
- 38 testes de domínio, worker, HTTP/PostgreSQL e sync passaram com dados sintéticos. Cobrem CNPJ mascarado, dupla criação simultânea, telefone, ACL, pedido/filial ambíguos, CPF, conferência auditada, pendência no POST, leitura direta simulada com fallback sem gravação, não somar incompletos e falha/override de logística sem afetar comercial.
- 4 testes de webhook e 6 verificações do wrapper do sync passaram. As 57 regressões financeiras do marco anterior permanecem registradas no documento do MVP; não foram repetidas neste incremento porque contadores e limites não mudaram.
- Testes puros frontend e Chromium passaram: cadastro inicial com telefone, pedido ausente, importação, unidade explícita, conferência, cubagem manual, payload por modo, rascunhos preservados e mobile. Build Vite passou com warning preexistente de bundle grande.
- Demonstração HTTP local em 127.0.0.1:5196 validada com navegador, persistência de telefone somente em memória e importação do pedido fictício 1234. Tráfego externo bloqueado nesse teste. Servidor demo não consulta NetVision/Supabase reais e não envia WhatsApp.
- Revisões Claude Code feitas nos dois worktrees; achados válidos corrigidos e revisões finais confirmaram as correções sem novos bugs concretos.

Teste local atual: PostgreSQL sintético na porta 15548 (5548 foi recusada pelo Windows). Use FRETE_TEST_PORT=15548 para scripts fretes-api-db/fretes-sync; webhook usa LOCAL_PG_PORT=15548 e LOCAL_PG_DATABASE=vivenzza_fretes_collection_test. Esses valores nunca devem apontar a produção.

Pendências para uso real: aprovação de publicação, migrations, publicação backend/frontend, configuração do sync local, reprocessamento autorizado dos pedidos necessários e validação com um pedido real. Nenhuma dessas ações foi executada neste marco.
