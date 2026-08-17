# Homologação SIP Trunk Externo (Nvoip) — procedimento futuro

**Status: DOCUMENTAÇÃO APENAS. Nada abaixo foi executado.** Nenhuma chamada
externa foi realizada na preparação desta prontidão (2026-08-16). Este
documento existe pra a PRÓXIMA rodada, quando as credenciais Nvoip
existirem, seguir um roteiro conhecido em vez de improvisar.

## Arquitetura alvo

```text
Vivenzza → ARI → Asterisk → PJSIP → SIP Trunk Nvoip → PSTN Brasil → cliente
```

A IA (faster-whisper + Ollama + Piper, voz "Jeff" = `pt_BR-jeff-medium`)
continua sendo nossa — a Nvoip é **só transporte SIP/PSTN**, nunca o
Voicebot da Nvoip. Isso já é verdade hoje pro ramal interno homologado
(`PJSIP/7001`) e não muda com um trunk externo — só troca o destino final.

## Parâmetros oficiais Nvoip (CONFIRMADOS, 2026-08-17)

Confirmado pela documentação oficial da Nvoip — não são mais palpite:

| Parâmetro | Valor |
|---|---|
| Servidor SIP remoto | `app.nvoip.com.br` |
| Porta SIP remota | `5060` |
| Autenticação | usuário/senha + SIP registration ativo |
| Codecs | `ulaw`, `alaw` |

**Ainda não confirmado/decidido:** a porta do **transport LOCAL** do nosso
Asterisk pro trunk Nvoip. Verificado em leitura real do Asterisk/WSL
(2026-08-17, `ss -tulnp`, somente leitura): a porta UDP **5060 local já está
ocupada** pelo transport interno existente (usado por `PJSIP/7001`/ARI) — um
segundo transport também em `0.0.0.0:5060/udp` local **conflitaria**. A
porta remota da Nvoip (5060) e a porta do nosso bind local são conceitos
diferentes; ver `NVOIP_SIP_LOCAL_BIND` em `.env.example` e o comentário
grande em `config/asterisk/pjsip-nvoip.conf.example`. Esse valor só será
decidido na hora da homologação real (porta local livre no servidor
naquele momento).

## Pré-requisitos (o que precisa existir ANTES do passo 1)

- [ ] Usuário e senha Nvoip (servidor/porta/codec já confirmados acima).
- [ ] Escolher a porta do transport LOCAL (`NVOIP_SIP_LOCAL_BIND`) — uma
      porta UDP livre no servidor, diferente de 5060 (já ocupada
      localmente).
- [ ] `destinoResolver.js` (`TRUNK_EXTERNO_CONFIGURADO`) alterado pra `true`
      **e** um adapter de trunk real implementado — hoje o segundo `throw`
      documentado nesse arquivo garante que isso nunca é "só flipar uma
      flag".
- [ ] Migration `20260101000033_voice_calls_audit.sql` aplicada em produção
      (hoje só existe como arquivo, nunca aplicada).

## Procedimento (16 passos, NENHUM executado ainda)

1. Receber credenciais Nvoip (usuário, senha, caller ID homologado —
   servidor `app.nvoip.com.br`/porta `5060` já confirmados) e escolher a
   porta do transport local (`NVOIP_SIP_LOCAL_BIND`, livre, ≠ 5060).
2. Inserir os segredos **localmente/ambiente seguro** — nunca no Git, nunca
   em log, nunca em relatório (`.env` real, nunca `.env.example`).
3. Validar SIP registration (obrigatório — Nvoip exige usuário/senha + SIP
   registration ativo, confirmado) — confirmar que o Asterisk consegue se
   registrar no trunk Nvoip, sem originar nenhuma chamada.
4. Validar o trunk **sem chamada** — ex. `pjsip show endpoint nvoip-endpoint`
   no console do Asterisk, confirmar `Avail`/`Not in use`.
5. Colocar **UM** número de homologação em `VOICE_EXTERNAL_ALLOWLIST` —
   nunca um número de cliente real nesta fase.
6. Ativar `automacoes_config.voice_external_enabled=true` — só depois de 1-5
   confirmados, via SQL direto (sem PATCH route, de propósito).
7. Realizar **UMA** chamada controlada (`node scripts/voice/trigger-external-test.mjs --numero=+55... --confirm`).
8. Validar áudio de ENTRADA (o Asterisk recebe o que o interlocutor fala).
9. Validar áudio de SAÍDA (o interlocutor ouve a síntese TTS "Jeff").
10. Validar Whisper (transcrição correta do áudio de entrada).
11. Validar Ollama (resposta coerente gerada a partir da transcrição).
12. Validar Piper/"Jeff" (síntese de voz inteligível, mesma calibração já
    homologada internamente — `VOICE_TTS_LENGTH_SCALE`/`VOICE_TTS_PREROLL_MS`).
13. Validar hangup (encerramento limpo, sem canal órfão).
14. Validar duração da chamada (dentro do esperado, `VOICE_MAX_TURNOS`/timeouts).
15. Validar custo/log (nenhum segredo em log — `mascararTelefone()` aplicado,
    conferir `provider`/`call_id`/`hangup_cause`/latências gravados sem PII
    desnecessária).
16. Desligar `voice_external_enabled` novamente após o teste, se a decisão
    operacional for não deixar ligado entre homologações.

**Nenhum cliente real na primeira homologação** — só o número de teste da
allowlist.

## O que NÃO fazer, mesmo depois da primeira homologação bem-sucedida

- Não ligar a régua de cobrança real à voz automaticamente — isso é uma
  decisão separada, futura, explícita.
- Não permitir que o NBA escolha mensagem, canal, horário ou desconto/prazo
  sozinho.
- Não criar uma terceira instância de WhatsApp nem mexer em `whatsapp_failover`
  como parte deste trabalho — são sistemas independentes.
