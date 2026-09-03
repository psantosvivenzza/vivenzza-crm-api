# Homologação SIP Trunk Externo (Twilio Elastic SIP Trunking) — procedimento futuro

**Status: DOCUMENTAÇÃO APENAS. Nada abaixo foi executado.** Nenhuma conta
Twilio foi criada, nenhuma chamada externa foi realizada na preparação
desta prontidão (2026-08-17).

## Por que Twilio (Plano B)

A Nvoip (Plano A) ficou classificada como `PROVIDER_AUTH_REJECTED`:
Asterisk recebe `401` no challenge digest inicial (normal), reenvia com
`Authorization`, e recebe um **segundo `401` fatal** — mesmo com a senha SIP
redefinida no painel Nvoip e redigitada localmente no Asterisk. Um teste
independente com MicroSIP, usando a mesma credencial, também falhou com
"senha incorreta". A config Nvoip foi **preservada, não removida** —
`config/asterisk/pjsip-nvoip.conf.example` continua válido pra quando o
suporte Nvoip confirmar a causa.

## Arquitetura alvo (idêntica em espírito à Nvoip — só troca o transporte)

```text
Vivenzza → ARI → Asterisk → PJSIP → Twilio Elastic SIP Trunk → PSTN Brasil → cliente
```

A IA (faster-whisper + Ollama + Piper, voz "Jeff") continua sendo nossa — a
Twilio é **só transporte SIP/PSTN**, exatamente como a Nvoip seria.

## Diferença arquitetural real vs Nvoip (não é o mesmo modelo)

| | Nvoip | Twilio |
|---|---|---|
| SIP REGISTER | Sim, obrigatório | **Não** — doc oficial: *"Configure your infrastructure not to register for this trunk"* |
| Autenticação | usuário/senha + registration | Credential List (usuário/senha, digest no INVITE) e/ou IP ACL |
| Termination URI | fixa, pública (`app.nvoip.com.br`) | só existe depois de criar o Trunk (`{nome}.pstn.twilio.com`) |
| Transport local | reaproveita `transport-vivenzza-udp` (confirmado no host real) | mesma coisa — reaproveita `transport-vivenzza-udp` |

Fonte oficial: [twilio.com/docs/sip-trunking](https://www.twilio.com/docs/sip-trunking) (consultado 2026-08-17)

## Parâmetros técnicos confirmados (documentação oficial Twilio)

| Parâmetro | Valor |
|---|---|
| Formato da Termination URI | `{nome-do-trunk}.pstn.twilio.com` (hífen recomendado, não ponto) |
| Autenticação | Credential List (usuário/senha) — Twilio recomenda **não** usar só IP ACL |
| Transporte | UDP (padrão); TCP (`transport=tcp`); TLS (`transport=tls`, porta 5061, TLSv1.2+) |
| Codecs | G711 (ulaw/alaw) confirmado como referência de banda |
| Formato de número | E.164 obrigatório, sempre com `+` (ex.: `+55XXXXXXXXXXX`) |
| Caller ID | número Twilio da conta OU Verified Caller ID (gratuito) |

**Não confirmado em fonte oficial nesta rodada:** código SIP exato do
challenge de auth em Termination (401 vs 407) — não bloqueia a
implementação (o `auth` do PJSIP responde a qualquer um dos dois
automaticamente), só não foi possível confirmar o texto oficial
(`support.twilio.com` bloqueou o fetch automatizado com 403 nesta consulta).

## Pré-requisitos (o que precisa existir ANTES do passo 1)

- [ ] Conta Twilio criada.
- [ ] Elastic SIP Trunk criado no Console (define a Termination URI).
- [ ] Credential List (usuário/senha) criada e associada ao Trunk.
- [ ] Upgrade de billing da conta (trial não suporta SIP Trunking — exige
      cartão; pode pedir verificação de identidade adicional, risk-based,
      até ~2 dias — não garantido).
- [ ] Geo Permissions do Console com Brasil habilitado (Voice → Settings →
      Geo Permissions) — toggle self-service, instantâneo.
- [ ] Verified Caller ID e Verified destination number cadastrados
      (Console → Phone Numbers → Verified Caller IDs) — gratuito, sem
      comprar DID.
- [ ] `destinoResolver.js` (`TRUNK_EXTERNO_CONFIGURADO`) alterado pra `true`
      **e** um adapter de trunk real implementado — mesmo gate que já
      protege a via Nvoip, não é "só flipar uma flag".
- [ ] Migration `20260101000033_voice_calls_audit.sql` aplicada em produção
      (ainda não aplicada, mesma pendência de antes).

## Procedimento (NENHUM passo executado ainda)

1. Criar conta Twilio, fazer upgrade de billing (cartão).
2. Console → Phone Numbers → Verified Caller IDs → verificar o número que
   vai ser o Caller ID E o número de destino do teste (SMS ou chamada com
   código) — gratuito, minutos.
3. Console → Voice → Settings → Geo Permissions → habilitar Brasil.
4. Console → Elastic SIP Trunking → criar o Trunk, escolher o nome (define
   a Termination URI), criar a Credential List (usuário/senha).
5. Inserir os segredos **localmente/ambiente seguro** — nunca no Git, nunca
   em log, nunca em relatório.
6. Configurar `pjsip-twilio.conf.example` no host real (substituir
   placeholders), sem tocar no ramal interno nem na config Nvoip.
7. `pjsip reload` e validar o endpoint/aor carregados — **sem originar
   chamada**.
8. Colocar **UM** número de homologação (o mesmo verificado no passo 2) em
   `VOICE_EXTERNAL_ALLOWLIST` — nunca um número de cliente real.
9. Ativar `automacoes_config.voice_external_enabled=true` — só depois de
   1-8 confirmados, via SQL direto (sem PATCH route, de propósito).
10. Realizar **UMA** chamada controlada.
11. Validar áudio de entrada/saída, Whisper, Ollama, Piper/"Jeff", hangup,
    duração, custo/log (sem segredo).
12. Desligar `voice_external_enabled` novamente após o teste, se a decisão
    operacional for não deixar ligado entre homologações.

**Nenhum cliente real na primeira homologação** — só o número verificado da
allowlist.

## O que NÃO fazer, mesmo depois da primeira homologação bem-sucedida

- Não ligar a régua de cobrança real à voz automaticamente.
- Não permitir que o NBA escolha mensagem, canal, horário ou desconto/prazo
  sozinho.
- Não mexer em WhatsApp, score/NBA, financeiro, fiscal, NetVision, terceira
  instância WhatsApp, `whatsapp_failover`.
- Não apagar a config Nvoip — ela continua preservada pra uma eventual
  retomada, se o suporte deles confirmar e corrigir a causa do
  `PROVIDER_AUTH_REJECTED`.
