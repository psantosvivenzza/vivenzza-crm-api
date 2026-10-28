# Integração de pedidos: PRs 151 e 153

Branch exclusivamente de pedidos, baseada em origin/main 77e5a16 e nos commits
revisados das PRs 151/153. Não contém o snapshot misto financeiro/voz/frete.
Não fechar nem mesclar automaticamente as PRs originais: esta draft oferece
um candidato conjunto para revisão; decidir uma única via de integração antes
de publicar, evitando tratar três PRs como entregas independentes em produção.

## Contratos preservados

- CLI retorna sucesso somente para relatório concluido com erro zero inteiro.
- Conexão rejeitada preserva apenas código de diagnóstico permitido, fecha pool
  e aborta antes de ler pedidos.
- Checkpoint vem apenas do último ciclo concluído, nunca de ciclo parcial.
- Erros ao ler histórico ou persistir conclusão/detalhes não são ocultados.
- Ciclo vazio não recua cursor; nenhuma nova lógica de importação comercial.

O teste pedidos-cli-job-integration executa CLI, job e helper reais com somente
três URLs de aplicação permitidas. Adaptadores pg/Supabase/E01/logística e
dotenv são sintéticos antes do import. Ambiente filho mínimo; nenhum acesso a
.env, SDK, banco, rede, scheduler ou aplicação. Node alvo 24.

Cinco cenários: conexão recusada e sanitização também no payload; histórico
indisponível antes de criar ciclo/Pool; persistência final recusada; ciclo vazio
com cursor preservado; uma linha recusada produz relatório parcial e exit 1.
Contador exige zero chamadas de logística mesmo se uma exceção fosse engolida.
Payload de estado emitido sincronamente; BAT apenas lido, nunca executado.

Workflow pedidos-cli-safety roda seis arquivos em Linux e Windows. O check
original de checkpoint também é preservado. Testes não comprovam conectividade
real, importação, persistência no banco ou resultados em produção.

## Gates de operação continuam abertos

Uma linha permanentemente ruim pode manter o checkpoint antigo e ampliar a
janela. Retry/quarentena durável e limitada ainda não implementados. Antes de
backfill/reprocessamento produtivo: decidir tratamento das linhas ruins,
exclusão mútua, backup/restore e impacto de repetir delete/insert de itens.
Não executar sync como teste de conexão, nem alterar pedidos/valores reais
para tornar teste verde. Não há deploy, restart, merge ou corte NetVision
autorizado por esta composição. Flags, WhatsApp, IA, voz e dados financeiros
permanecem intocados.

## Gate da primeira execução após publicação

O filtro mais restritivo pode ampliar imediatamente a janela: se só houver
ciclos parciais, desde=null causa carga total; se houver sucesso antigo, a
releitura volta a esse cursor. Antes de merge/deploy, consultar somente leitura
o último concluido versus o último parcial e registrar volume/janela. Não
iniciar o job para descobrir essa informação. A autorização de backfill ou
reprocessamento e a exclusão mútua continuam obrigatórias.

Consulta agregada em 19/10/2026 09:37Z: 684 ciclos concluídos, 89 falhos,
um executando e nenhum parcial registrado. Último concluído em 16/10 16:40Z,
cursor 16/10 14:34:03Z. Nesse instante não há recuo adicional por descartar um
parcial, mas existe atraso operacional de pedidos a diagnosticar; revalidar
antes de publicar. O registro executando não prova processo ativo.

Riscos preexistentes confirmados também em origin/main: o catch não verifica
falha devolvida ao persistir status falhou; rejeição de pool.end no finally
pode mascarar a falha primária. Não foram modificados nesta composição;
precisam de tratamento e regressão próprios antes de declarar recuperação
operacional completa. A rota HTTP e o script de primeira sincronização não
passam a adotar o gate de exit code exclusivo do CLI por esta alteração.
