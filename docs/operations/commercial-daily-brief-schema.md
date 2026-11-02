# Esquema usado pelo resumo diário no Comercial

Este documento acompanha a PR170 e reconcilia as referências necessárias ao job e ao transporte. Os arquivos em [reference](reference/) são **texto de referência, não migrations executáveis nem instrução para aplicar SQL**. Não devem ser renomeados, concatenados ou executados automaticamente. Nenhum SQL foi executado para produzir esta documentação.

> Os cabeçalhos “Aplicação manual” e “LOCAL PREPARADO” nos arquivos arquivados são históricos. Não constituem instrução ou autorização atual para executar, promover owner, repetir seed ou remover proteções. A extensão .txt e a localização em docs/reference distinguem estas cópias dos caminhos de migrations; o SQL ainda poderia ser executado se alguém deliberadamente o passasse a um executor, o que NÃO integra esta PR.

## Fontes e escopo

| Referência | Origem | Limite |
| --- | --- | --- |
| [Journal de entregas](reference/direction-notification-deliveries.sql.txt) | Trecho com bytes exatos da declaração de direction_notification_deliveries em migrations/direction_daily_summary.sql da fonte API 80942 | Somente a tabela consumida pelo notifier e seus RLS/grants; não inclui direction_notification_runs nem a RPC financeira direction_daily_snapshot, que não são requisitos deste job. O trecho isolado não é uma transação de instalação. |
| [Conexões FZap](reference/fzap-whatsapp-connections.sql.txt) | Fonte manual histórica completa migrations/fzap_whatsapp_connections.sql da API 80942 | Sua enumeração aceita somente comercial/financeiro. Isoladamente NÃO suporta o canal de notificações. Contém INSERTs de outras conexões, alterações de grants/policy/trigger e regra de identidade imutável. Não aplicar como reparo ou bootstrap deste job. |
| [Complemento da direção](reference/direction-notifications-connection.sql.txt) | Fonte preparada em vivenzza-fzap-api-20261029/migrations/direction_notifications_connection.sql | Amplia a finalidade para notificacoes e registra a identidade da direção com owner inicial herdado Evolution. Não promove owner para FZap, não pareia, não define token/destinatário nem ativa/envia. O arquivo preparado não prova por seu hash que este exato texto foi executado em produção. |

O registro de publicação de automações de 30/10 documenta uma operação administrativa que ampliou a finalidade e cadastrou a direção, preservando as outras conexões. Isso esclarece por que a fonte inicial sozinha é incompleta. Não é licença para repetir essa operação. As referências preservam a origem histórica e não tentam reconstruir todo o esquema atual.

## Contrato dos consumidores

O notifier usa INSERT de key e trata 23505; portanto precisa de unicidade imediata em key e default reserved no status. Depois consulta status/provider_message_id e atualiza status/provider_message_id/updated_at. A [leitura catalogal arquivada de 02/11](evidence/journal-catalog-20261102.json) já observou os tipos desses quatro campos, unicidade em key confirmada, default reserved e privilégios do service_role; anon/auth sem privilégios no escopo consultado. Não repetir essa consulta por causa desta PR.

O transporte exige a conexão lógica direcao-notificacoes, instância vivenzza-notificacoes-direcao e finalidade notificacoes, configuradas no backend. Ownership precisa coincidir com essa identidade e estar em FZap. O schema inicial ou o complemento sozinho não provam isso: o inicial rejeita notificacoes; o complemento não promove owner e não homologa dados/credenciais/pareamento.

O runtime lê a identidade em configuração e o ownership no banco; não cria ou migra conexões ao preparar o resumo. O fluxo existente de Conexões WhatsApp usa os métodos request(id) e complete(id) de [whatsappOwnershipStore.js](../../src/lib/whatsappOwnershipStore.js), por intermédio do serviço FZap. Isso não é um passo a executar neste job. O trigger histórico torna a promoção monotônica: não existe reversão automática de owner FZap para Evolution por esse fluxo. Qualquer necessidade de retorno exige plano administrativo separado, sem autorização aqui para remover trigger ou escrever ownership. Esses caminhos não pertencem ao cron do relatório. A existência desses métodos nos helpers compartilhados não autoriza executá-los.

## Prontidão e limites

A configuração de remetente, destinatário, agenda e prontidão pertence ao registro de publicação, não a um estado fixado por este documento. Veja a [proveniência dos registros](evidence/journal-catalog-20261102.json), que nomeia os arquivos locais originais da leitura e publicação. Este arquivo não valida o saldo de modelo, a sessão atual nem uma entrega. Não são prova de entrega, constraint bodies atuais, grants universais, concorrência, restore ou migração inteira. Resultados incertos não são reenviados; não há catch-up.

Esta PR continua DRAFT. Antes de qualquer merge ou nova publicação a partir desta base Git, reconciliar o contrato de ownership/schema do ambiente de destino com as fontes e evidências existentes. Não usar contatos, RPCs de negócio ou envios reais como teste. A implementação já publicada não deve ser substituída por uma base Git parcialmente reconciliada.

Nenhuma dessas referências altera SQL, dados, owner, RLS/grants, flags, env, serviços, Site, voz ou agendas. Qualquer execução administrativa é operação separada com escopo, prontidão e autorização próprios. Não ampliar papéis, refazer seed, trocar owner ou remover triggers para fazer o job passar.

## Verificação desta reconciliação

As referências foram comparadas byte a byte com as fontes locais pinadas; o journal preserva somente um trecho contínuo e os demais arquivos são cópias integrais. O runtime/testes do base Git99c25f9 não foi alterado e seus 27 casos anteriores não foram repetidos nem contados novamente. Esta etapa verifica origem/escopo da documentação, não execução do SQL.

## Proveniência textual

As duas fontes iniciais vêm da árvore congelada da API 80942, não de uma aplicação SQL neste ciclo. A fonte do complemento estava preparada localmente e não era rastreada no HEAD cd9f02fb2e4aa87641fa73ecdc8368ddb4aa1fae do worktree de origem. Seu pin é o SHA256 4434f91241aaf08c602db01c8cdb5da515b99fa781b1dda1fd977f1a17dc650f do arquivo, e NÃO um commit dessa alteração nem prova de execução. As cópias integrais preservam os bytes; o trecho do journal preserva as linhas3–10 da fonte SHA256 45e92fea67b1630ebc4a0ba30d4ff3adace71e378675fb3eed214cd3a5a5dff7. A fonte inicial de ownership tem SHA256 2ffbbc184a315531a34ef0d09a47bf29890da292fed2a53a6cd455691b54ec74.
