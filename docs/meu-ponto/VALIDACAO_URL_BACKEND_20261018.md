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
