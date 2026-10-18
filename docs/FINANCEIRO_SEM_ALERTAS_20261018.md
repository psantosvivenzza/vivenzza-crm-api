# CLI financeiro sem alertas próprios

Opção explícita `--sem-alertas`: não importa o módulo remetente e não envia
os alertas da conferência deste processo. Sem a opção, o comportamento é
preservado. A conferência continua executando e registrando seu resultado.
As divergências deixam de gerar notificação por este canal; a operação precisa
de acompanhamento dos registros por outro canal durante essa modalidade.

Isso NÃO desliga a régua geral de cobrança, voz ou outros remetentes do CRM.
Também NÃO torna `--watch` uma leitura: a sincronização e a conferência
continuam podendo gravar. `--watch --dry-run` permanece recusado antes de IO.

Antes de qualquer retomada real: autorização específica para baixas/pagamentos,
contenção confirmada de todos os disparadores gerais, revisão do patch e
protocolo de parada com ACK do processo antigo. Não iniciar trabalhador duplicado.

Validação: subprocessos herméticos substituem dotenv, job, conferência e
remetente. Cobrem ambas as ordens da opção, ausência de import/envio do alerta,
preservação do ciclo e do dry-run pontual, e rejeição de argumentos inválidos.
Nenhum envio, sincronização real ou alteração de configuração em produção.
