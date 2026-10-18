# CLI financeiro: recusar simulação residente ambígua

## Falha e correção

Em origin/main 77e5a16, `--watch --dry-run` entrava no loop residente e chamava o sincronizador **sem** passar `dryRun`. Poderia portanto aplicar baixas e executar conferência/alertas mesmo quando o operador solicitava simulação. Não há evidência de uso real dessa combinação ou de dano em produção.

A combinação agora é recusada com exit 2 e mensagem explícita, em qualquer ordem e também junto de `--completo`. A allowlist atual contém quatro flags exatas: `--dry-run`, `--watch`, `--completo` e `--sem-alertas`. Outros argumentos são recusados, para não transformar `--dry-run=true`, `--dryrun` ou `-n` em operação real silenciosa. Não são ecoados os argumentos desconhecidos, pois poderiam conter dados sensíveis. A recusa ocorre antes de importar dotenv/job/conferência/alerta. Os imports são dinâmicos após a validação; dotenv permanece antes dos adaptadores habilitados. Nenhuma regra financeira, payload de baixa, limite, DNC ou política de promessa foi alterada. Sem `--sem-alertas`, watch real e modos pontuais válidos mantêm as opções anteriores.

`--sem-alertas` não importa nem chama o remetente deste CLI. Não desliga a régua geral ou voz, nem torna watch somente leitura. Conferência é executada apenas após varredura completa no modo watch, não no modo pontual. É obrigatório capturar e acompanhar os registros por outro canal antes de operar com alertas suprimidos; não se comprova aqui esse monitoramento produtivo. Ver [detalhes da opção](FINANCEIRO_SEM_ALERTAS_20261018.md).

## Verificação offline

`npm run test:financeiro:cli:safety` (Node >=22.15 pelos hooks do teste; executado em Node 24.16): atualmente 27 testes, sendo 22 de subprocesso e cinco do observador. Dotenv/job/conferência/alerta são substituídos antes do import; o resolver fecha acesso a imports inesperados. Não lê `.env`, não usa SDK/pg nem banco/rede reais. Os 13 testes do parágrafo seguinte pertencem somente ao marco inicial.

Baseline inicial: quatro casos da combinação proibida falharam porque alcançaram o job sintético (exit 88), quatro controles dos modos existentes passaram. Após a correção e revisão: 13 aprovados, incluindo cinco casos de argumentos desconhecidos. Controles pontuais verificam as opções exatas; watch real é interrompido pelo stub na primeira chamada, não é teste do loop completo nem da integração de pagamentos.

## Implantação e limites

Somente código/testes preparados, sem execução do CLI real, restart, merge, deploy ou alteração de tarefa. Esta correção não recupera o worker atualmente parado sem progresso, não resolve divergências financeiras e não prova backup recuperável. O timeout de alerta do PR 154 é independente. Implantação e qualquer recuperação que possa gravar dados continuam sujeitas à autorização específica e aos gates operacionais registrados.

## Diagnóstico por etapa — continuação

O CLI também registra eventos JSON em stderr: `tipo=financeiro_etapa`, `etapa` (sincronizacao_completa/incremental, conferencia, alerta), `evento` (inicio/fim/erro), horário UTC e duração em ms ao terminar. A etapa `alerta` só ocorre quando há divergência grave, cooldown permite e `--sem-alertas` está ausente. Uma etapa que permanece aguardando deixa somente início. Isso diferencia as fronteiras na próxima execução autorizada; não identifica retroativamente a causa da espera do worker antigo.

O observador aguarda a operação original: nenhum timeout artificial, cancelamento, retry, execução paralela ou restart. O resultado e a exceção são preservados. Falha síncrona do logger/relógio não impede a operação. Os novos eventos não incluem resultado, mensagem/stack de erro, cliente, título, telefone ou valor financeiro; nomes de etapas desconhecidas viram `desconhecida`. Logs preexistentes do CLI continuam com seu conteúdo anterior e não devem ser tratados como sanitizados.

`fim` significa Promise resolvida, não ausência de divergências ou homologação financeira. A instrumentação começa depois dos imports e não cobre espera durante carregamento de módulos. O observador não resolve I/O pendente; serve para localizar a etapa antes de tratar a fronteira correta sem abandonar escritas em andamento.

Comando atual executa **27 testes**: os 13 de proteção iniciais, cinco do observador, três ciclos watch inteiramente sintéticos (conclusão, falha de conferência, falha de alerta), erro do job pontual preservando exit 1 e cinco casos de `--sem-alertas`. Esses cinco cobrem ambas as ordens no watch, dry-run pontual sem remetente e duas recusas antecipadas. Sem flag, os controles também comprovam um alerta sintético quando cabível. Controles pontuais verificam etapas e mensagem compatível com o modo, inclusive dry-run completo. O teste sai no descanso após um ciclo; stdout/stderr são escritos sincronamente nos FDs do filho para não perder eventos antes do exit controlado no Windows. Não houve envio nem acesso real. Requisito Node dos hooks permanece separado do runtime produtivo. Nenhuma prova de produção foi adicionada.

O módulo `scripts/lib/financeiro-phase.mjs` precisa acompanhar o CLI no mesmo rollout. Estimativa no intervalo padrão: cerca de 2.900 linhas adicionais por dia; considerar retenção/rotação dos logs no planejamento operacional. Uma exceção síncrona do alerta passa a ser descrita como falha do alerta (antes era capturada como falha de conferência); ambos os caminhos continuam sem interromper o ciclo.

## Check remoto isolado

O workflow `.github/workflows/financeiro-cli-safety.yml` executa os dois arquivos
de teste em Node 24, sem instalar dependências, carregar .env ou iniciar a
aplicação. Roda em PRs que alteram esses caminhos e em pushes correspondentes
para main; inclui PRs draft. Actions oficiais fixadas por SHA, token somente
leitura, credenciais de checkout não persistidas, timeout de cinco minutos.
Não usa secrets, environments de produção, serviços de banco ou deploy.
Esse check valida apenas o CLI/observador com adaptadores sintéticos, não a
sincronização real nem as implementações dos adaptadores substituídos.
Não configurar como required check global sem rever o filtro por caminhos.
