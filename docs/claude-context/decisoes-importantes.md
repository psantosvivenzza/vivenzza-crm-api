# Decisões importantes — não refazer nem reverter sem entender o motivo

Cada item aqui já foi investigado/decidido com evidência real. Se uma
tarefa futura parecer contradizer algum destes pontos, pare e confirme
antes de agir — é mais provável que a tarefa esteja com premissa errada do
que esta lista estar desatualizada (e se estiver desatualizada, atualize
o documento, não ignore silenciosamente).

## Vendas / fiscal

- Série 99 entra em vendas **gerenciais** — é venda real.
- Série 99 **não** deve ser tratada como NF-e/documento fiscal SEFAZ.
- `EN_NotasRepres` é a fonte real de "Vendas por Representante" — validada
  por reconciliação exata contra o relatório oficial.
- **Não usar `ES_Pedidos`** para "Vendas do Mês" — é outro domínio
  (comercial/pedidos), não vendas fechadas.
- Não misturar o read-model de vendas gerenciais com o read-model fiscal —
  fontes NetVision diferentes, propósitos diferentes.

## Certificado digital

- Não reintroduzir fallback de caminho de certificado com senha embutida
  no caminho/nome do arquivo (padrão já removido por ser inseguro).
- Não reexportar o PFX de forma que perca a cadeia de certificados — usar
  sempre cópia byte a byte do PFX original completo quando for necessário
  atualizar/trocar o certificado.

## Cobrança / WhatsApp

- `PERMANENT_RECIPIENT` não é falha da instância — é problema do
  destinatário/dado. Nunca deve voltar a afetar o circuit breaker por
  instância.
- Número confirmado como inválido pelo provider entra em quarentena de
  **30 dias** — não é bloqueio de "só hoje" (regra antiga, substituída) nem
  permanente.
- Não transformar a quarentena em opt-out permanente automaticamente —
  reincidência não escala sozinha para bloqueio definitivo.
- Celular tem prioridade sobre fixo/contato genérico na seleção do
  telefone de cobrança.
- O terceiro WhatsApp financeiro (`vivenzza-financeiro-reserva-02`) será
  reserva pura, `priority=3`, só cadastrado como ativo depois de
  `connected` confirmado.
- `whatsapp_failover` continua `false` em produção — reativar exige
  autorização explícita, não é o padrão a restaurar "de volta ao normal".

## Voz

- `voice_external_enabled` continua `false` — não ativar automaticamente.
- Nunca expor ARI diretamente à internet, sob nenhuma circunstância.

## Código / arquitetura

- **Não existe** uma flag `collection_engine_v2` no código real — não
  assumir/reintroduzir essa ideia. As flags reais de feature do motor de
  cobrança são as documentadas em `cobranca-whatsapp.md` e no código
  (`src/lib/collection/featureFlags.js`).
- Antes de afirmar que algo "já existe" ou "não existe" no sistema,
  confirmar no `origin/main` atual — checkouts locais deste projeto têm
  histórico de ficar muito desatualizados (dezenas a mais de cem commits
  atrás em alguns casos), e conteúdo desatualizado não é o mesmo que
  conteúdo inexistente.
