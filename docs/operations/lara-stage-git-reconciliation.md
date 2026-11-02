# Lara: observador de etapa no Git — DRAFT

A preparação local de 01/11 continha o observador e os testes, ausentes da base Git `cd9f02fb`. Este recorte integra dois módulos e quatro grupos de inserção no webhook, totalizando sete linhas. Retirar somente essas inserções recupera os bytes do webhook pai; as provas registram o hash do blob original e do arquivo recuperado.

O consumidor financeiro `financialAiRuntime` existe na API produtiva, mas está ausente desta base Git. Ele não foi copiado para esta PR. A fronteira financeira dos testes reflete o comportamento do Git pai. Persistência, frete, mídia, reativação e demais fluxos existentes do Git permanecem no próprio webhook. Esta PR não substitui a API produtiva nem declara paridade completa com ela.

## Comportamento integrado

Uma mensagem comercial, de entrada ou de saída, com lead, ID do provedor e recibo de upsert sem erro pode solicitar análise. Financeiro e frete são excluídos. Como o upsert usa `ignoreDuplicates`, sucesso também pode representar uma reentrega: não é prova de inserção nova. O hook captura rejeição do observador com diagnóstico fixo e não faz nova tentativa por conta própria.

O núcleo exige os dois opt-ins literais já previstos: `lara_pipeline_automatico` e `alerta_sem_resposta_por_conversa`. Também exige etapa aberta, evidência literal, releitura e recibo RPC igual a `true`. O helper de configuração do Git preserva campos retornados por `select('*')`; seus defaults e o cache de cinco segundos não foram alterados. O estado real das flags não foi consultado nem modificado.

## Condições antes de merge, publicação ou ativação

- A RPC `apply_lead_stage_advice` não está definida nesta base Git. A fonte SQL preparada anteriormente fica fora desta PR e do pipeline. Validar assinatura, engine, grants/RLS, auditoria e retenção em ambiente isolado confiável; não aplicar SQL por causa desta PR.
- A releitura no cliente não fecha a janela entre mensagem nova e escrita. Resolver o contrato transacional de versão, evidência e flags, incluindo concorrência. O cache local não é um desligamento instantâneo.
- Os limites locais de uma chamada por minuto por lead e duas análises simultâneas não são orçamento global nem diário. Antes de ativar, fechar teto de custo e comportamento após falhas repetidas de aplicação. Não ativar duas flags com RPC ausente ou sem essa proteção.
- Validar classificação adversarial e confiança: evidência literal e confiança autodeclarada pelo modelo não provam qualidade. Não fecha/perde vendas, muda responsável ou autoriza valores reais.
- O incidente da credencial Anthropic continua separado. Não reativar a chave antiga, trocar credencial, fazer recarga ou inferência real por este recorte.

## Verificação e limites

`npm run test:lara:etapas:git` executa núcleo e wrapper reais com IA, DB, configuração e timers fictícios. O teste do bloco de persistência usa um observador injetado e cobre as duas direções comerciais. Um teste adicional carrega os módulos reais do webhook, wrapper e advisor em VM; todas as outras dependências são sintéticas. Ele verifica a existência dos arquivos relativos e os exports dos três módulos carregados. Confere também, por leitura estática, as declarações reais de `obterConfigCobranca` e `ehInstanciaFinanceira`; os demais produtores continuam sintéticos e sua semântica não é homologada. Não há trabalho externo ao avaliar os módulos, nem execução de um evento HTTP completo.

Os oito casos do hook no Git pai têm cinco resultados positivos e três negativos; somente três discriminam a ausência do hook. A suíte completa é reutilizada no novo alvo Git, não uma soma das execuções locais anteriores. Não é CI global, teste de banco/provedor/modelo real nem homologação produtiva. Nada neste documento autoriza SQL, flags, envio, merge ou deploy.
