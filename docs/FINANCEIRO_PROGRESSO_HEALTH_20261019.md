# Progresso financeiro: diagnóstico somente leitura

`Get-Content logs/sync-financeiro.log -Tail 200 | node scripts/financeiro-progress-health.mjs`

O CLI recebe o recorte por stdin, no máximo 256 KiB e cinco segundos de entrada.
Não abre arquivos, carrega .env, consulta banco/processos, envia mensagens ou
reinicia serviços. Imprime apenas estado, etapa permitida, data/idade da última
conclusão e indicador de etapa pendente. Não imprime conteúdo arbitrário do log.

Saídas: 0=etapa concluída nos últimos dez minutos; 1=atraso ou erro observado;
2=evidência insuficiente/inválida. Início isolado não confirma sucesso. Heartbeat
e mtime não contam como progresso. Evento futuro, regressivo, inválido ou etapas
sobrepostas levam a inconclusivo. Erro de uma etapa persiste até conclusão da
mesma etapa; um incremental não oculta falha de conferência/alerta.

O limite mede conclusão de etapa (sync, conferência ou alerta), não conclusão de
ciclo financeiro completo. Etapa pendente recente pode coexistir com conclusão
recente; isso não prova saúde de banco, processo, paridade ou ausência de cobrança.
`fim` significa Promise resolvida: pode incluir job pulado por lock/guard, erros
por linha ou conflitos. Confirmar status/contadores do ciclo no banco separadamente.
Não mede a cadência individual da varredura completa/conferência. Saída distingue
etapa do último evento e etapa da última conclusão. Apenas logs confiáveis devem
ser fornecidos: quem controla um evento válido pode forjar evidência de conclusão.
Como não há identificador de geração nos eventos, fornecer somente o recorte
atual. Log antigo/completo pode conter relógios regressivos entre reinícios.
Início órfão seguido de outro início retorna inconclusivo; após reinício, recortar
explicitamente a geração atual, sem apagar o histórico nem ignorar eventos inválidos.
Erros fora do recorte são desconhecidos: Tail 200 é apenas exemplo, não garantia
de cobrir uma conferência inteira. Para avaliá-la, incluir ao menos seu último
ciclo completo da geração atual, respeitando o limite de entrada. O arquivo de
log precisa capturar stderr, onde o observador emite os eventos.

Ferramenta manual/de supervisão: não instalada no agendador nem conectada ao
watchdog. Um resultado atrasado nunca autoriza reinício ou alteração financeira.
