# Diagnóstico fechado de conexão dos pedidos

O teste inicial SELECT 1 agora preserva somente códigos de uma lista fixa, sem mensagem/cause/host/usuário do driver. Não muda cursor, dados, retries ou agendamento. O pool permanece aberto no sucesso e fecha em falha. O erro de fechamento não substitui a falha primária.

Categorias: ENOTFOUND/EAI_AGAIN indicam resolução; ECONNREFUSED indica recusa; ETIMEDOUT indica timeout codificado; 28P01/28000 indicam autenticação; 3D000 banco inexistente; 53300 capacidade; 57P01/57P03 indisponibilidade administrativa; classe 08 conexão; 42501 privilégio. Demais códigos de transporte permitidos são emitidos literalmente. Essas categorias são diagnóstico, não autorização para mudar credenciais/rede nem garantia da causa histórica.

Erro sem código (inclusive alguns timeouts do pg.Pool) e código desconhecido resultam NAO_CLASSIFICADO. Resolução/configuração anteriores à criação do pool continuam fora deste helper. Outros jobs/erros não estão globalmente sanitizados por esta mudança. Não propagar mensagens livres para preencher essas lacunas nem instruir operador a executar sync que escreve como teste de conexão.

Testes offline: helper com pool sintético e integração do job real com imports externos interceptados antes do carregamento. Sem .env, SDK real, conexão real ou importação de pedidos. Harness de integração requer Node 22.15+ (registerHooks); execução local em Node 24.16. Testes não homologam Task Scheduler ou recuperação dos dois pedidos ausentes. Código preparado na PR151, não publicado em produção.
