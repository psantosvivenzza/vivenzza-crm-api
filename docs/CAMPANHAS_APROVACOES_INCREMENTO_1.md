# Campanhas: contrato de aprovação e execução sintética

Este incremento é uma biblioteca isolada. Não está montada no Express, não importa clientes Meta/Google, não cria cron, não altera flags e não oferece execução real. Não representa liberação do recurso em produção.

`src/lib/campaignApproval.js` exige proposta explícita, aprovação administrativa do hash e execução separada. O payload inclui plataforma, conta, campanha, ação, estado anterior/posterior, moeda, objetivo, motivo, evidência e validade em UTC ISO canônico (`YYYY-MM-DDTHH:mm:ss.sssZ`). Valores de orçamento usam unidades monetárias menores inteiras; cada adaptador futuro deverá demonstrar a conversão própria do provedor. Alterar moeda ou mais de um campo por ação é recusado. Campos adicionais são recusados.

Estados: `proposta`, `aprovada`, `em execução`, `confirmada`, `falhou`, `inconclusiva`. Cada transição guarda ator, instante UTC e código sanitizado. A confirmação indica apenas correspondência do estado lido com o pedido; não indica melhoria de desempenho. O módulo não combina métricas Meta/Google nem produz recomendações de IA nesta etapa.

## Portas confiáveis e limitações

- `actor` deverá vir da autenticação administrativa do servidor, nunca do corpo enviado pelo navegador. Neste incremento não há rota nem autenticação HTTP implementada.
- `policy` é configuração exclusiva do servidor: contas/campanhas/ações permitidas, moeda, teto e variação máxima de orçamento, frescor e duração máxima da aprovação. Nenhuma conta real está configurada neste código.
- `store.get/insert/compareAndSwap` devem devolver cópias independentes. O CAS deve comparar a revisão e salvar estado e histórico atomicamente. Apenas o store em memória dos testes foi implementado; persistência durável e segurança de banco ainda estão pendentes.
- `adapter` deve ser explicitamente `mode: synthetic`; não há adaptador padrão. Esse marcador não é sandbox de código arbitrário: as portas são dependências confiáveis. A suíte bloqueia sockets e fetch; qualquer integração futura requer análise e autorização próprias.
- `adapter.read(target)` devolve identidade completa e snapshot normalizado. `write` recebe alvo, ação, snapshot e chave estável proposta/hash. As leituras anterior e posterior conferem também a identidade, além dos valores.

O claim por CAS antecede qualquer leitura/escrita do provedor. Concorrência e replay não conseguem reutilizar uma proposta já reclamada. Antes da escrita, a política, a validade e as pré-condições são verificadas novamente. Falha antes da tentativa de escrita termina em `falhou`. Exceção durante escrita/readback ou resposta divergente termina em `inconclusiva`; ACK isolado não confirma. Não há retry automático. Falha de persistência final conserva `em execução` no contrato do store: a ação não é repetida. Recuperação por leitura, cancelamento e revisão de proposta ainda não foram implementados; um futuro mecanismo de reconciliação deverá preservar essa regra.

## Verificação local

Executar, sem iniciar o servidor:

```text
node --test scripts/tests/unit/campaign-approval.test.mjs
node --test scripts/tests/unit/campaigns-contract.test.mjs
```

Primeira suíte: 26 testes, incluindo ambos os contratos sintéticos Meta/Google, hash, acesso administrativo, limites, expiração, concorrência de aprovação/execução, pré-condições, falhas de leitura/escrita/persistência, readback de alvo errado, relógio inválido, listas de política malformadas e datas impossíveis. Segunda: 11 regressões existentes de semântica das métricas. Nenhum teste acessa provedores reais. Não alegar cobertura de PostgreSQL, HTTP/JWT, permissões reais de Ads, UI, produção ou retomada após queda de processo.

Revisão Codex: os testes exercitam as principais fronteiras deste incremento. A garantia de concorrência depende do CAS atômico da futura persistência; não é demonstrada para múltiplos processos por um Map. O mesmo administrador pode propor e aprovar, pois dupla custódia não foi requisito deste incremento. Uma falha do relógio impede escrita; se ocorrer depois do claim, pode conservar `em execução`, sem repetição. Não há liberação para produção implícita na aprovação deste contrato.

## Próximo incremento

Persistência transacional local com claim/versão/histórico e testes reais em PostgreSQL isolado; depois rotas autenticadas e interface portuguesa no painel existente. A IA poderá preparar avaliação/proposta, mas não representar o aprovador humano. Aplicar migration remota, vincular clientes reais, ativar execução, publicar ou agendar permanece fora deste incremento.
