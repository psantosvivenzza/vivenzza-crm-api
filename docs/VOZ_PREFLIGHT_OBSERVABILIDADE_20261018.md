# Preflight de voz: ausência não é invisibilidade

## Defeito e mudança

O inventário anterior filtrava Win32_Process por CommandLine e escolhia o primeiro resultado. Linha de comando inacessível era indistinguível de serviço ausente. PID/data não eram validados: uma data inválida podia fazer a comparação de código antigo retornar false e o script sair 0. A reprodução sintética demonstrou os dois defeitos antes da correção: 4/6 testes passaram e dois falharam pelos motivos esperados.

O PowerShell passa a emitir somente JSON com contagem de processos sem CommandLine visível e PID/data dos candidatos, nunca linhas de comando completas. Erro CIM terminante aborta a consulta. Helper puro distingue parado, identificado e inconclusivo, valida formato/identidade temporal mínima e recusa múltiplos candidatos conhecidos. Ausência sem invisíveis continua exit 1; invisibilidade sem serviço identificável, JSON/data/PID inválidos e ambiguidade também exit 1, agora com mensagem honesta. Um único candidato conhecido válido mantém a comparação de idade existente; processos não observáveis adicionais não invalidam esse candidato identificado. Não prova unicidade global se houver processos invisíveis.

Falha de consulta registra mensagem fixa, sem mensagem/stack do sistema. Nenhum WSL, ARI, credencial, banco, serviço ou fila é iniciado. Exit 0 ainda significa apenas processo identificado e código verificado por mtime dos arquivos JS no diretório original, NÃO telefonia saudável, autorização de contato, modelo pronto ou homologação de chamada. Critério e limitações do mtime permanecem.

## Verificação executada

node --test scripts/tests/unit/voice-preflight-inventory.test.mjs scripts/tests/unit/financial-voice.test.mjs scripts/tests/collection/voice-external-pilot-readiness.test.mjs

43/43, exit 0, sem skipped/cancelled. São 19 testes novos de inventário/CLI e 24 de lógica isolada existentes. CLI usa import hooks fail-closed: child_process e filesystem sintéticos, nenhum powershell, rede, dotenv ou serviço durante os testes. JSON malformado, shape errado, papel invisível, data/PID inválidos, múltiplos serviços, código antigo e falha de consulta cobertos. Após revisão, datas exigem UTC ISO, calendário válido e não futuro; timestamp de sete casas emitido pelo CIM é coberto. A prova estática ARI e guards injetados dos testes existentes não equivale a banco/DNC/ARI reais.

node --check scripts/voice/verificar-servico-voz.mjs e git diff --check passaram. Execução real somente do preflight novo: exit 1, inventário incompleto/ambíguo/inválido, sem discagem. Snapshot operacional antigo com WIP NÃO foi atualizado nem ativado.

## Implantação e limites

Copiar só o script sem scripts/lib/voice-preflight-inventory.mjs falha no import, portanto distribuir ambos juntos depois de revisão/autorização operacional. Não fazer merge/deploy ou sobrepor o checkout operacional sujo nesta tarefa. Não habilitar fila, voz ou WhatsApp. Aplicação de ACL/RLS continua separada na PR156 e não faz parte deste patch.

Não comprova término de chamada, trunk, TTS/STT ou recuperação financeira. Falta provar serviço atual após ativação autorizada, além de chamada atendida com fluxo IA e encerramento normal sob autorização específica.

O matcher de processo por substring run-voice-service é preexistente e continua uma limitação: argumento incidental contendo esse texto pode parecer serviço. Não usar sozinho como autorização de discagem; conferir identidade/caminho do processo e saúde do ARI antes de operação real. A saída real do PowerShell foi exercitada apenas no estado atual inconclusivo; integração com um processo de voz real saudável e PS7 permanece não homologada. Testes de import hooks exigem runtime Node com registerHooks (executado em Node24).
