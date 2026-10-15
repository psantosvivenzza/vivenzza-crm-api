# Cotações de frete — primeira versão

Implementação local em worktrees de backend e frontend, a partir de origin/main e origin/master atualizados. Não publicada e não homologada com transportadoras reais.

## Contrato aprovado

- Reutilizar fornecedores: flag participa_cotacao_frete e WhatsApp/consentimento no próprio cadastro; não criar outra entidade de transportadora.
- Evolution existente, exclusivamente vivenzza-financeiro, sem failover/comercial.
- Carga, retirada, entrega e terceiro pagador distintos; dimensões em cm, peso bruto total em kg e cubagem física em m³.
- Menor total permanece destacado mesmo fora do prazo. Menor prazo destacado separadamente. Média aritmética apenas de propostas completas, conferidas e válidas. Custo-benefício = menor total que atende ao prazo desejado; sem prazo informado = menor total; se ninguém atende = indicação explícita, sem recomendação inventada.
- Propostas recebidas não são automaticamente confirmadas pelo assistente. Financeiro informa total/prazo/validade e confirma taxas para inclusão no ranking.
- Assistente responde perguntas previsíveis por regras e interpreta variações com Claude Sonnet já usado pelo projeto. O modelo apenas classifica campos permitidos; respostas são montadas com dados confirmados, sem texto livre ou ações externas. Dúvida, anexos, repetição e pedido de contratar/coletar/pagar pausam para atendimento humano.
- Não contrata, agenda coleta, emite documento fiscal ou altera contas financeiras.

## Instalação e liberação

1. Revisar e aplicar a migration aditiva 20261014140810_cotacoes_frete_fornecedores.sql somente após aprovação de publicação.
2. Publicar backend/frontend e habilitar FRETE_MODULO_INSTALADO=true após confirmar schema. Essa flag fica true mesmo se os envios forem pausados: tentativas anteriores continuam nos limites financeiros compartilhados.
3. Habilitar fornecedores explicitamente e cadastrar consentimento para solicitações.
4. FRETE_ENVIO_ATIVO e FRETE_IA_ATIVA nascem false. Habilitar separadamente após teste autorizado com contatos de piloto. COLLECTION_TEST_MODE/allowlist existentes continuam aplicáveis ao adapter Evolution.
5. Verificar instância financeira conectada, limites globais existentes, DNC/opt-out, webhook autenticado e dados cadastrais antes de cada envio.

Fila persistida e claim transacional evitam duplicação por duplo clique/réplicas. Uma conversa aberta por telefone no MVP; encerrar anterior antes de nova solicitação. Variações de telefone precisam ser tratadas pela normalização e associação. Intervalo mínimo de 90s entre tentativas de frete. Envio ambíguo/interrompido vai para revisão e não é reenviado automaticamente. Respostas de transportadora são interceptadas antes do fluxo de cobrança/CRM comercial. Falha de classificação preserva a mensagem no histórico financeiro bruto. Quando a transportadora já foi identificada, não marca cobrança respondida; para desconhecidos mantém o comportamento anterior da cobrança. Falha dos guards bloqueia o envio; leituras temporariamente indisponíveis antes do claim mantêm a solicitação na fila.

Limite compartilhado soma tentativas de frete aos contadores de cobrança sem aumentar limites configurados. Race entre motores distintos deve ser observada na homologação; a exclusão mútua do claim de frete não substitui a admissão do motor de cobrança.

Rollback: reverter aplicação/desabilitar FRETE_ENVIO_ATIVO e FRETE_IA_ATIVA. Preservar campos, tabelas e histórico; nunca excluir fornecedores ou cotações. Não desligar FRETE_MODULO_INSTALADO enquanto a aplicação usa contadores compartilhados e existirem tentativas no período.

## Verificação

Testes de domínio: cubagem, entrega direta entre indústrias, menor preço lento, prazo desejado, médias, propostas vencidas/incompletas e validação de entradas.

Teste PostgreSQL sintético: schema de fornecedores confirmado por metadados de produção (consulta somente leitura), migration aditiva aplicada apenas no banco local 127.0.0.1:5548/vivenzza_fretes_test; testes HTTP de autorização, FK/reuso fornecedor, rollback de contato ocupado, duplo enqueue/claim, proposta humana, encerramento e privilégios/RLS.

Testes do worker/assistente e navegador sintético devem ser registrados ao concluir a revisão integrada. Revisão crítica Claude Code é gate obrigatório antes da entrega. Nenhuma evidência local equivale a implantação ou validação em produção.

## Evidências finais locais

- 32 testes de frete (domínio, HTTP/PostgreSQL, worker e assistente) passaram, com migration íntegra no banco novo vivenzza_fretes_test_v5.
- 4 testes de webhook com módulo habilitado passaram: sem cotação preserva histórico; classificação indisponível preserva histórico; cotação aberta entra no histórico próprio e não responde cobrança; falha de frete para não transportadora preserva a marcação normal da cobrança.
- Regressão financeira: 10 cenários de teto global, 32 de instâncias/failover e 15 de isolamento financeiro/comercial passaram. Banco exclusivo vivenzza_fretes_collection_test, porta 5548. A primeira tentativa expôs uma lacuna preexistente da fixture: leads.updated_at ausente; adicionado apenas no banco sintético conforme contrato da migration de retornos, sem alteração de produção.
- Testes de frontend: validação de cubagem/carga/operação triangular e fluxo Chromium sintético desktop/mobile passaram. APIs interceptadas; nenhum tráfego de negócio real. Build Vite passou; warning de bundle grande já presente no projeto.
- Metadados de produção consultados somente para schema/RLS: fornecedores usa UUID, coluna atualizado_em existente, RLS=true e sem políticas públicas. Novos campos usam mesmo cadastro e acesso backend.
- Revisões Claude Code de backend e frontend realizadas. Achados válidos tratados: histórico sem cotação, pausa/encerramento concorrente, próprio claim no contador, identidade de telefone, limite horário por instância, ordem de locks, eco normalizado, estados de erro, proteção de ações simultâneas e visibilidade de falhas da fila. Revisões finais pós-ajustes confirmaram as correções em 15/10/2026, sem novos bloqueadores apontados.
- Nenhuma migration, publicação, contato real, contratação, coleta ou alteração financeira de produção ocorreu. Não há commits/PRs deste módulo neste marco.

Comandos de teste disponíveis: npm run test:fretes (domínio/worker), npm run test:fretes:db (PostgreSQL sintético preparado em loopback), npm run test:fretes:webhook (baseline completo local via LOCAL_PG_PORT/DATABASE). Frontend: npm run test:fretes, npm run test:fretes:browser e npm run build. A preparação de banco sintético deve permanecer isolada; nunca substituir pelos DSNs de produção.

IA: usuário autorizou explicitamente em 14/10/2026 enviar somente o texto das perguntas das transportadoras à Anthropic para identificar campos. Cadastros completos, dados de outras cotações e ferramentas não são enviados. A autorização veio após bloqueio da revisão automática de permissões; nenhum egress de IA foi realizado nesta implementação. ANTHROPIC_API_KEY existente e FRETE_IA_MODEL opcional (default claude-sonnet-4-6, igual ao SDR). Limite 256 tokens, timeout 10s, sem retries; pergunta até 2000 caracteres. Testes usam classificador simulado; não validam comportamento de modelo real. Falha/ambiguidade transfere à revisão humana.
Fonte API consultada: https://platform.claude.com/docs/en/api/messages/create

## Fechamento 15/10/2026

- Revisão Claude Code concluída nos dois worktrees; achados concretos corrigidos e revistos novamente. Correções adicionais: opt-out de não transportadora, fallback da cobrança, pausa após interrupção, métricas de saúde da instância, preservação de envio confirmado quando só o histórico falha, seleção de fornecedor revogado, rascunhos independentes e confirmação de ação separada de refresh. Falha de histórico confirmado gera HISTORICO_PENDENTE; conferir histórico manualmente, sem reenviar.
- Peso cubado, líquido ou unitário e fator de cubagem não são respondidos como peso bruto. Exigem revisão. SDK usa destino Anthropic oficial explicitamente. Nenhuma chamada real ao modelo foi usada nos testes.
- Browser sintético passou incluindo revogação/reabilitação de participante, rascunho preservado e erro de refresh após mutação concluída. Build final e diff check conferidos; warning de tamanho de bundle preexistente.
- Limitações deliberadas do MVP: uma cotação aberta por telefone inclusive rascunho, até encerramento manual; fila fixa de baixa cadência na instância financeira (~2 minutos entre tentativas com cron de 1 minuto); sem calendário de horários comerciais; falha de leitura dos contadores bloqueia envio para preservar tetos. Limites por origem da cobrança continuam específicos, enquanto teto global e por instância incluem frete. Se a instância ou teto global estiver indisponível, a fila aguarda.
- Autenticação NotebookLM falhou nesta retomada (token_fetch=false; CSRF indisponível). Não houve nova consulta ou sincronização de memória nesta data. Resumo sanitizado pendente preservado em output/MEMORIA_FRETES_2026-10-15_PENDENTE.md no workspace pai.
- Status: implementado e testado localmente. Não publicado, não validado em produção, sem commits/PRs. Próximo gate: autorização de publicação, aplicação da migration aditiva, liberação gradual das flags e piloto real autorizado com transportadoras.
