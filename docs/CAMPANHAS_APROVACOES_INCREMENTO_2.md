# Campanhas — revisão persistida e preview integrado

Incremento local sobre 0975e4b. Sem push, merge, deploy, flags, agendamento ou alterações reais em Ads. Não incorpora pacotes financeiros. Atualiza as limitações do incremento 1 somente nos pontos descritos abaixo.

## Fluxo implementado

Propostas sintéticas Meta e Google são criadas pelo servidor local a partir de fixtures. O painel existente mostra objetivo, motivo, conta/alvo, antes/depois, moeda, variação e validade. A confirmação de aprovação vincula o hash do conteúdo exibido, sem executar. Rejeição exige motivo e é terminal. A execução permanece um botão separado, exclusivamente sintético. Histórico e JSON ficam recolhidos. Resultado operacional não comprova desempenho.

O contrato agora permite `rejeitada`, listagem das 100 propostas mais recentes e carregamento por ID. A fonte de autorização é o middleware JWT existente: apenas admin identificado; chave estática de integração não pode aprovar. Body não pode injetar ator, papel ou payload. A composição normal do `index.js` monta o router SEM workflow/store/policy, respondendo 503 após autenticação. Não existe ativação por flag nem cliente Ads real vinculado.

## Persistência

Migration candidata local `supabase/migrations/20261015190408_campaign_review_proposals.sql`, nome manual com timestamp UTC observado, conforme autorização para escrita local e CLI ausente. Não aplicada ao Supabase real. Documentação oficial consultada: [migrations](https://supabase.com/docs/guides/deployment/database-migrations) e [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security); changelog markdown não pôde ser obtido pela ferramenta web.

Schema privado `campaign_review`, RLS, sem acesso anon/authenticated e sem DELETE/TRUNCATE para service_role. Nos testes service_role é NOBYPASSRLS; isso não afirma a configuração de Supabase hospedado. GRANTs e trigger protegem as operações mesmo que o papel hospedado tenha bypass. Trigger invoker/search_path vazio valida transições, imutabilidade de payload/hash, aprovação e histórico append-only, sempre na mesma atualização CAS. Índice único impede duas propostas em execução para o mesmo alvo. Hash canônico, limites e tempo são verificados pela aplicação; o banco não recalcula o hash.

Após tentativa de escrita, qualquer falha de confirmação vira inconclusiva; não há retry automático. Tanto em execução quanto inconclusiva mantêm o alvo bloqueado por índice, inclusive contra outra proposta aprovada. Não foi implementada reconciliação de stuck/inconclusivas: ela deverá ser somente leitura antes de qualquer novo mecanismo de execução. O mesmo admin pode propor e aprovar; dupla custódia não foi requerida. O middleware existente passou a identificar o método autenticador, sem mudar suas permissões; estas rotas exigem o marcador JWT.

## Homologação e reprodução

Somente PostgreSQL nativo já disponível em `tools/vivenzza-postgresql-17.11-5/pgsql/bin`. Cada run exige diretório novo; nenhum cluster é apagado/reutilizado cegamente. Porta PG 15581, loopback exclusivo, database campaign_review_synthetic, sem .env ou bootstrap operacional. Não executar outra rodada enquanto o preview usar essa porta.

```text
node scripts/tests/unit/campaign-review-http.mjs IDENTIFICADOR-NOVO
node --test scripts/tests/unit/campaign-approval.test.mjs scripts/tests/unit/campaigns-contract.test.mjs
```

HTTP/PG: 12 critérios passaram na rodada integrated-v4; inclui JWT ausente/inválido/expirado, vendedor/chave estática, padrão503, Meta/Google, rejeição/hash, grants/RLS, adulteração/histórico, CAS em conexões distintas, concorrência entre propostas do mesmo alvo, timeout depois da escrita, falha do commit final, validação de entrada e restart real do PostgreSQL com histórico preservado. Cluster de testes encerrado. Sockets limitados às duas portas loopback, fetch proibido. Fixtures não usam integrações reais.

Frontend: 12 critérios SSR novos, 8 SSR existentes e 8 testes do modelo, além de builds do preview e da aplicação normal. SSR/build/HTTP não equivalem a teste de cliques em navegador. Nenhuma sessão ou perfil real do usuário foi lido. Avisos de tamanho de bundle e API CJS do Vite permanecem; builds concluíram.

Para construir no frontend isolado, defina VIVENZZA_FRONTEND_PACKAGE_JSON apontando para o package.json do checkout frontend com dependências instaladas e execute:

```text
node scripts/build-campanhas.mjs --reviews
node scripts/test-campaign-review-render.mjs
```

O build desativa envDir; não lê arquivos .env. Depois, no candidato API:

```text
node scripts/campaign-review-preview.mjs IDENTIFICADOR-NOVO
```

URL http://127.0.0.1:5198. Sessão admin exclusivamente sintética, token efêmero em memória, sem perfil/localStorage real. Header dedicado, Origin/Host verificados, sem CORS externo, CSP connect-src self. Para encerrar este próprio preview, enviar `stop-preview` à entrada padrão ou SIGINT; encerra HTTP/pool/cluster. Não encerrar recursos de outras tarefas. Reiniciar esse script cria novo ambiente sintético; os diretórios anteriores ficam preservados.

## Limites restantes

Não foi encontrada avaliação IA reaproveitável nas rotas/jobs de Campanhas inspecionados e busca textual correlacionada em src. Isso não prova inexistência universal. A avaliação aqui é fixture explícita; IA real, credenciais, contas, limites e execução de Ads estão ausentes. Contratos sintéticos normalizados não homologam APIs reais Meta/Google. Não há migration remota, validação em produção, parecer sobre performance de campanhas reais ou agendamento de monitoramento. Antes de eventual publicação/executor real são necessários autorização aplicável, políticas reais aprovadas, adaptação por provedor, conversão de unidades monetárias, readback e reconciliação operacional.
