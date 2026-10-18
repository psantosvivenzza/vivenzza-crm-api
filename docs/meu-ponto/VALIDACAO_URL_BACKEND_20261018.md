# Pareamento: URL de backend sem credenciais

O cadastro local comparava somente a origem da URL com a allowlist. O parser
URL não inclui usuário/senha na origem; uma URL com userinfo podia portanto
alcançar a criação de chave antes de o fetch rejeitá-la. Não há evidência de
cadastro real afetado. Agora username/password não vazios são recusados com400
e mensagem fixa, antes de qualquer operação CNG ou contato com o backend.
Origem/Host/token continuam obrigatórios; a allowlist não foi ampliada.

Regressão: `node --test scripts/tests/ponto/servico-local-preflight-e-allowlist.test.mjs`.
O caso novo falhou antes (500 em vez de400); após a correção8/8 passaram.
Três variantes cobertas: usuário+senha, apenas usuário e apenas senha.
Teste usa HTTP somente em loopback e intercepta child_process/node:child_process
para impedir PowerShell, CNG ou diálogo reais. Mock só exporta execFile de
propósito: mudar o import para outra função falha ruidosamente, não executa
o sistema. A asserção400 é a evidência principal do curto-circuito; ausência
do marcador em stderr é verificação adicional, não prova isolada.

Os import hooks desse teste exigem Node >=22.15; execução local Node24.16.
O serviço mantém seus requisitos anteriores. Não executar testes CNG reais
como parte desta regressão nem usar AUTO_CONFIRMAR em operação real.
Não executada a suíte inteira de banco ou validação física nesta alteração.
Nenhuma instalação/autostart, flag estrutural ou configuração produtiva mudou.
Não normalizados path/query da URL persistida: comportamento anterior fora
do escopo, a revisar separadamente se houver consumidor por concatenação.

## Check remoto independente da validação física

Workflow `ponto-local-preflight.yml` executa 14 testes em Node 24 nos
runners Windows e Ubuntu, sem instalar dependências ou fornecer secrets.
Há processo Node temporário com HTTP somente loopback; execFile é substituído
antes do import do serviço. Não executa CNG, PowerShell, MessageBox ou banco.
Nenhum serviço é instalado e nenhuma chave de equipamento é gerada.

Actions oficiais fixadas por SHA, contents read, token de checkout não
persistido, timeout de cinco minutos por job. Executa em PRs inclusive draft
e pushes main filtrados por caminhos; não marcar como required global sem
rever filtro. Cancelamento de runs anteriores apenas em PRs.
Resultado verde não homologa TPM, diálogo visível, equipamento ou produção.

O conjunto combina oito controles HTTP e seis controles de lifecycle com
EventEmitter sintético. Processo encerrado antes da prontidão rejeita logo;
limpeza não espera novamente exit já emitido e tem timeout de cinco segundos.
Token só é lido após a linha completa, mesmo com stdout fragmentado. Porta é
selecionada pelo sistema operacional antes do spawn; uma corrida residual de
ocupação ainda pode causar falha explícita de inicialização, não falso verde.
Cleanup recursivo valida o caminho temporário exato antes de remover a fixture.
Se não confirmar encerramento, preserva a fixture e falha explicitamente em vez
de apagar estado de processo possivelmente vivo. Remoção após encerramento
confirmado tem retry limitado para EBUSY/EPERM, sem ignorar erro permanente.
