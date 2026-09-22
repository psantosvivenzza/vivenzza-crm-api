# Twilio Elastic SIP Trunking — pesquisa histórica (Plano B nunca implementado)

**Este documento é pesquisa histórica, não um roteiro ativo.** Preserva o
conteúdo técnico levantado em 2026-08-17 durante a PR #43
(`feat/voice-twilio-external-readiness`), fechada como obsoleta em
2026-09-22 sem merge. Nenhuma conta Twilio foi criada, nenhuma credencial
foi gerada, nenhuma chamada externa via Twilio foi realizada em nenhum
momento.

## Status atual (2026-09-22) — leia isto antes de qualquer coisa abaixo

- O pipeline de voz externa em produção é **Nvoip**, ativo desde
  2026-09-22 (ver `docs/cobranca-ai/NVOIP_HOMOLOGACAO.md` e
  `docs/claude-context/voice.md`). O problema que motivou este Plano B
  (Nvoip classificada `PROVIDER_AUTH_REJECTED`, 401 fatal) foi resolvido
  pelo adapter Nvoip real — não existe mais.
- O código atual (`src/lib/voice/destinoResolver.js`,
  `src/lib/voice/externalPilotGuardrails.js`) resolve o destino da
  chamada e a autorização de forma **específica da Nvoip**, não mais
  genérica por provider como era em 2026-08-17. Nada no pipeline de
  autorização lê configuração Twilio.
- Não existe nenhuma variável de ambiente, flag, tabela ou credencial
  Twilio configurada em nenhum ambiente (local, Railway, produção).
- Uma redundância real de transporte SIP (um "Plano B" de verdade, com
  failover automático ou manual entre provedores) **exigiria um projeto
  novo**: reescrever a camada de resolução de destino para ser
  provider-agnostic de novo, decidir e implementar a lógica de failover,
  e revalidar tudo isso contra o pipeline Nvoip que passou a existir
  depois de agosto/2026. Este documento não é esse projeto — é só a
  pesquisa de mercado que ficaria reaproveitável se esse projeto for
  aberto no futuro.

## Por que esta pesquisa foi feita

Em 2026-08-17, a Nvoip (Plano A da época) estava classificada como
`PROVIDER_AUTH_REJECTED`: o Asterisk recebia `401` no challenge digest
inicial, reenviava com `Authorization` e recebia um **segundo `401`
fatal** — reproduzido mesmo com a senha SIP redefinida no painel Nvoip e
redigitada localmente, e também com um cliente SIP independente
(MicroSIP) usando a mesma credencial. Twilio Elastic SIP Trunking foi
pesquisado como transporte SIP/PSTN alternativo, caso a causa do erro na
Nvoip não fosse resolvida.

## Diferença arquitetural real vs Nvoip (achado de pesquisa, ainda válido como referência)

| | Nvoip | Twilio |
|---|---|---|
| SIP REGISTER | Sim, obrigatório | **Não** — doc oficial da Twilio: *"Configure your infrastructure not to register for this trunk"* |
| Autenticação | usuário/senha + registration | Credential List (usuário/senha, digest no INVITE) e/ou IP ACL |
| Termination URI | fixa, pública (`app.nvoip.com.br`) | só existe depois de criar o Trunk (`{nome}.pstn.twilio.com`) |

Fonte oficial consultada em 2026-08-17:
[twilio.com/docs/sip-trunking](https://www.twilio.com/docs/sip-trunking).
Reconfirme antes de reaproveitar — pode ter mudado desde então.

## Parâmetros técnicos levantados (documentação oficial Twilio, 2026-08-17)

| Parâmetro | Valor |
|---|---|
| Formato da Termination URI | `{nome-do-trunk}.pstn.twilio.com` (hífen recomendado, não ponto) |
| Autenticação | Credential List (usuário/senha) — Twilio recomenda **não** usar só IP ACL |
| Transporte | UDP (padrão); TCP (`transport=tcp`); TLS (`transport=tls`, porta 5061, TLSv1.2+) |
| Codecs | G711 (ulaw/alaw) confirmado como referência de banda |
| Formato de número | E.164 obrigatório, sempre com `+` (ex.: `+55XXXXXXXXXXX`) |
| Caller ID | número Twilio da conta OU Verified Caller ID (gratuito) |

Não confirmado em fonte oficial na pesquisa original: código SIP exato do
challenge de auth em Termination (401 vs 407) — `support.twilio.com`
bloqueou o fetch automatizado com 403 na consulta de 2026-08-17.

## Pré-requisitos que existiriam, se este plano fosse retomado

Lista como levantada em 2026-08-17 — não confirmar como atual sem
reler o código e a documentação Twilio de novo:

- Conta Twilio criada e upgrade de billing (trial não suporta SIP
  Trunking — exige cartão e pode exigir verificação de identidade
  adicional).
- Elastic SIP Trunk criado no Console (define a Termination URI) e
  Credential List associada.
- Geo Permissions do Console com Brasil habilitado.
- Verified Caller ID e Verified destination number cadastrados.
- Uma camada de resolução de destino reescrita para ser
  provider-agnostic outra vez (hoje não é — ver "Status atual" acima), e
  um adapter de trunk Twilio real implementado — não é "só configurar
  variáveis de ambiente".

## O que continuaria valendo, mesmo se este Plano B for retomado algum dia

- Nunca ligar a régua de cobrança automática à voz sem autorização
  explícita e específica (`voice_external_enabled`, guard de trunk
  pronto, allowlist).
- Nunca deixar o NBA escolher mensagem, canal, horário ou
  desconto/prazo sozinho.
- Não mexer em WhatsApp, score/NBA, financeiro, fiscal, NetVision,
  terceira instância WhatsApp, `whatsapp_failover` como parte desse
  trabalho.
- Não apagar nem substituir a config Nvoip — ela é o pipeline ativo.

## Onde ver a auditoria que motivou o fechamento da PR #43

A PR #43 (`feat/voice-twilio-external-readiness`) foi auditada em
2026-09-22: o teste próprio da PR quebrava contra o `main` atual, o
código adicionado (`lerConfigTwilio()`/`descreverConfigTwilioSemSegredo()`
em `src/lib/voice/externalConfig.js`) não tinha nenhum chamador fora do
próprio teste, e a motivação original já não existia mais. Este
documento é o que restou de valor dessa PR — o código foi descartado
junto com o fechamento dela.
