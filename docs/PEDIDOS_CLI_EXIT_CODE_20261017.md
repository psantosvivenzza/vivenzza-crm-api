# Pedidos — sinalização do CLI ao agendador

Base main 77e5a16. Defeito: o CLI usava status parcial ? 0 : 0, sinalizando
sucesso mesmo em relatório concluido_com_erros ou status inesperado.

Contrato corrigido: exit 0 SOMENTE status concluido e total_com_erro inteiro
seguro igual a 0. Rejeição do job permanece exit 1; relatório parcial, status
desconhecido, contador ausente/inválido/positivo e relatório nulo retornam1.
Nenhuma regra de sincronização, cursor, payload, log ou wrapper alterada.

Testes invocam CLI real em processo Node descartável com hook substituindo
dotenv/config e job ANTES dos imports. Nenhum .env, banco, rede ou mensagem.
Teste exige marcador do CLI em stdout para não aceitar erro de carregamento
como teste negativo válido. Harness inicial tinha caminho errado (defeito
do teste corrigido); baseline válido mostrou 10 falhas / 3 pass no código antigo.

Harness exige Node com module.registerHooks (22.15+); verificado em Node24.16
no Windows. Não altera requisitos do CLI de produção. Resultado final:
16 testes de subprocesso + 6 estáticos, 22/22. Revisão Claude sem bloqueantes
por leitura; testes foram executados pelo Codex, não pelo revisor.

Operação observada via leitura: VivenzzaSyncPedidosLegado Ready, última
execução 16/10 20:10-03 com resultado 1, próxima 19/10 08:00-03. Histórico real
das duas últimas sincronizações falhou antes de ler pedidos; último sucesso
16/10 16:40 UTC. A ausência de execução no sábado é coerente com dados novos
pendentes, mas não prova causa única das seis diferenças de chaves.

Correção somente preparada; não aplicada à tarefa/checkout operacional,
não iniciado sync real nem alterado agendamento. Não corrige automaticamente
os 2 pedidos ausentes ou 4 extras. Cursor pode avançar após sucesso parcial e
persistência final ignora erros retornados: achados adjacentes para outra
correção isolada, não resolvidos por esta mudança de exit code.

Ativar retry do agendador com exit 1 pode repetir escritas parciais: revisar
idempotência/cursor e política de retentativas antes da implantação. Sem
autorizar sync ou afirmar êxito com base só no código de saída.
