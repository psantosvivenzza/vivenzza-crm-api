# Incidente — cobrança WhatsApp consolidada (mensagem de 18/08/2026)

## Sintoma
Cliente recebeu cobrança de R$ 2.442,58 com a frase "Esse valor corresponde a
2 títulos com o mesmo vencimento." e assinatura "Jeffeson".

## Investigação (origem dos valores)
- **Cron (`jobs/cobranca-whatsapp.js`)**: agrupa por `codigo_cliente + vencimento`
  (`agruparParaConsolidacao`), deduplica por `legacy_id` e bloqueia grupos
  ambíguos. O valor de R$ 2.442,58 = 2 × R$ 1.221,29 (dois títulos distintos, mesmo
  vencimento) — **a soma do cron estava aritmeticamente correta**; o defeito era
  o texto (nota de quantidade) e a assinatura.
- **Disparo manual (`POST /api/cobrancas/disparar-individual`)**: causa real de
  valores potencialmente incorretos. Somava **todos** os títulos em aberto do
  cliente (vencimentos diferentes misturados), sem deduplicar `legacy_id` e sem
  bloquear ambiguidade — divergente do cron. Não foi possível reconstruir com
  certeza qual dos dois caminhos gerou o envio de 18/08 (o registro em
  `cobrancas_whatsapp` guarda `origem`, mas nenhum dado financeiro foi
  consultado/alterado nesta correção); ambos os caminhos ficam corrigidos.
- Soma em ponto flutuante: passou a ser feita em centavos inteiros no disparo manual.

## Correção
1. `reguaCobranca.js`: mensagem idêntica à de título único (sem menção a
   quantidade/soma); assinatura "Andrieli".
2. `cobrancas.js`: soma somente do grupo do vencimento mais atrasado, dedup por
   `legacy_id` (`analisarIdentificadores`), 409 se ambíguo, soma em centavos.
3. Testes: `disparar-individual-dedup-ambiguidade.test.mjs` (7 casos, incl.
   vencimentos distintos) e ajustes em consolidação.

## Contenção / segurança
`automacoes_config.cobranca_whatsapp_ativa` foi desligado em produção até o deploy.
Nenhum WhatsApp real enviado e nenhum dado financeiro alterado nesta correção
(testes usam Postgres local + Evolution simulada). Religar a flag é decisão humana.
