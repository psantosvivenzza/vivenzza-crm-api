# CLI financeiro: recusar simulação residente ambígua

## Falha e correção

Em origin/main 77e5a16, `--watch --dry-run` entrava no loop residente e chamava o sincronizador **sem** passar `dryRun`. Poderia portanto aplicar baixas e executar conferência/alertas mesmo quando o operador solicitava simulação. Não há evidência de uso real dessa combinação ou de dano em produção.

A combinação agora é recusada com exit 2 e mensagem explícita, em qualquer ordem e também junto de `--completo`. Argumentos diferentes das três flags exatas também são recusados, para não transformar `--dry-run=true`, `--dryrun` ou `-n` em operação real silenciosa. Não são ecoados os argumentos desconhecidos, pois poderiam conter dados sensíveis. A recusa ocorre antes de importar dotenv/job/conferência/alerta. Os imports tornaram-se dinâmicos após a validação; dotenv permanece carregado antes dos três adaptadores. Nenhuma regra financeira, payload de baixa, envio, limite, DNC ou política de promessa foi alterada. Watch real e modos pontuais válidos continuam com as opções anteriores.

## Verificação offline

`npm run test:financeiro:cli:safety` (Node >=22.15 pelos hooks do teste; executado em Node 24.16): 13 testes de subprocesso, com dotenv/job/conferência/alerta substituídos antes do import. Resolver fecha acesso a imports inesperados. Não lê `.env`, não usa SDK/pg nem banco/rede reais.

Baseline inicial: quatro casos da combinação proibida falharam porque alcançaram o job sintético (exit 88), quatro controles dos modos existentes passaram. Após a correção e revisão: 13 aprovados, incluindo cinco casos de argumentos desconhecidos. Controles pontuais verificam as opções exatas; watch real é interrompido pelo stub na primeira chamada, não é teste do loop completo nem da integração de pagamentos.

## Implantação e limites

Somente código/testes preparados, sem execução do CLI real, restart, merge, deploy ou alteração de tarefa. Esta correção não recupera o worker atualmente parado sem progresso, não resolve divergências financeiras e não prova backup recuperável. O timeout de alerta do PR 154 é independente. Implantação e qualquer recuperação que possa gravar dados continuam sujeitas à autorização específica e aos gates operacionais registrados.
