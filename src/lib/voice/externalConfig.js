// 2026-08-16 — prontidão SIP trunk externo (Nvoip). SÓ leitura de config —
// nenhuma credencial é usada aqui pra abrir conexão nenhuma (isso seria
// trabalho do adapter de trunk, que não existe ainda — ver destinoResolver.js,
// TRUNK_EXTERNO_CONFIGURADO=false, hardcoded, não tocado por este arquivo).
//
// NUNCA logar/expor valor de NVOIP_SIP_PASSWORD nem qualquer credencial —
// só "configurado: true/false" (ver descreverConfigNvoipSemSegredo).
import { telefonesEquivalentes } from '../telefone.js'

// Nomes de env var seguem o MESMO padrão já usado por EVOLUTION_*/ASTERISK_*
// neste repo (prefixo do provedor). Nenhum valor real é lido/commitado aqui —
// só os NOMES, com placeholder vazio em .env.example. O adapter de trunk que
// vai efetivamente USAR essas credenciais ainda não existe.
export function lerConfigNvoip() {
  return {
    sipServer: process.env.NVOIP_SIP_SERVER || null,
    sipPort: process.env.NVOIP_SIP_PORT || null,
    sipUsername: process.env.NVOIP_SIP_USERNAME || null,
    sipPassword: process.env.NVOIP_SIP_PASSWORD || null,
    outboundProxy: process.env.NVOIP_SIP_OUTBOUND_PROXY || null,
    callerId: process.env.NVOIP_CALLER_ID || null,
    // Porta do TRANSPORT LOCAL do nosso Asterisk — nunca a mesma coisa que
    // sipPort (essa é remota, da Nvoip). Ver comentário grande em
    // config/asterisk/pjsip-nvoip.conf.example — porta 5060 local já está
    // ocupada pelo transport interno existente (verificado 2026-08-17).
    sipLocalBind: process.env.NVOIP_SIP_LOCAL_BIND || null,
  }
}

// Status seguro pra endpoint/log/relatório — nunca inclui a senha, nem
// mascarada. Só diz SE cada credencial foi configurada, não qual é.
export function descreverConfigNvoipSemSegredo() {
  const cfg = lerConfigNvoip()
  return {
    sip_server_configurado: Boolean(cfg.sipServer),
    sip_port_configurado: Boolean(cfg.sipPort),
    sip_username_configurado: Boolean(cfg.sipUsername),
    sip_password_configurado: Boolean(cfg.sipPassword),
    outbound_proxy_configurado: Boolean(cfg.outboundProxy),
    caller_id_configurado: Boolean(cfg.callerId),
    sip_local_bind_configurado: Boolean(cfg.sipLocalBind),
  }
}

// Guard puro (sem I/O): a porta do transport LOCAL nunca pode ser igual à
// porta REMOTA da Nvoip — evita repetir, numa config real futura, o erro de
// usar bind=0.0.0.0:${NVOIP_SIP_PORT} (a porta 5060 local já está ocupada
// pelo transport interno, confirmado em leitura real do Asterisk/WSL).
// Retorna true quando a combinação é segura (bind local ainda não escolhido,
// ou escolhido e diferente do remoto); false quando colidem.
export function avaliarLocalBindDiferenteDoRemoto(sipLocalBind, sipPortRemoto) {
  if (!sipLocalBind) return true // ainda não escolhido — nada pra conflitar ainda
  return String(sipLocalBind) !== String(sipPortRemoto)
}

// 2026-08-17 — Plano B: Twilio Elastic SIP Trunking (Nvoip ficou
// PROVIDER_AUTH_REJECTED — 401 fatal mesmo com senha SIP redigitada,
// confirmado também por teste independente com MicroSIP). Config Nvoip
// acima PRESERVADA, não removida — só deixou de ser o caminho ativo.
//
// Diferença arquitetural real (não é copy-paste do padrão Nvoip):
// documentação oficial da Twilio diz explicitamente "Configure your
// infrastructure not to register for this trunk" — Elastic SIP Trunking
// NÃO usa SIP REGISTER. Autenticação é via Credential List (usuário/senha,
// challenge digest no próprio INVITE) e/ou IP ACL (allowlist de IP
// configurada NO PAINEL da Twilio, nada a configurar aqui do nosso lado).
// Por isso não existe sipLocalBind/registration aqui — não se aplica.
export function lerConfigTwilio() {
  return {
    terminationUri: process.env.TWILIO_SIP_TERMINATION_URI || null,
    sipUsername: process.env.TWILIO_SIP_USERNAME || null,
    sipPassword: process.env.TWILIO_SIP_PASSWORD || null,
    callerId: process.env.TWILIO_CALLER_ID || null,
  }
}

// Status seguro pra endpoint/log/relatório — nunca inclui a senha.
export function descreverConfigTwilioSemSegredo() {
  const cfg = lerConfigTwilio()
  return {
    termination_uri_configurado: Boolean(cfg.terminationUri),
    sip_username_configurado: Boolean(cfg.sipUsername),
    sip_password_configurado: Boolean(cfg.sipPassword),
    caller_id_configurado: Boolean(cfg.callerId),
  }
}

// Allowlist da primeira homologação pública — formato canônico E.164/BR
// (mesmo padrão de COLLECTION_TEST_PHONE_ALLOWLIST em dispatchEngine.js):
// lista separada por vírgula, comparada via telefonesEquivalentes() (nunca
// substring/endsWith — mesmo motivo documentado em telefone.js:
// falso-positivo real de allowlist por sufixo). Vazio por padrão — nenhum
// número é permitido até isto ser preenchido explicitamente.
export function lerAllowlistExterna() {
  return (process.env.VOICE_EXTERNAL_ALLOWLIST || '').split(',').map((n) => n.trim()).filter(Boolean)
}

export function numeroNaAllowlistExterna(numero) {
  if (!numero) return false
  const allowlist = lerAllowlistExterna()
  return allowlist.some((permitido) => telefonesEquivalentes(numero, permitido))
}

// Limites conservadores/fail-closed por padrão — defaults pequenos de
// propósito (primeira homologação é 1 número, poucas chamadas). "0" nunca é
// tratado como "sem limite" em nenhum guard deste módulo (ver
// externalPilotGuardrails.js/avaliarLimiteDiarioPorTelefone: limite<=0 já
// bloqueia sempre).
export function lerLimitesVoz() {
  return {
    maxChamadasHora: Number(process.env.VOICE_MAX_CALLS_HOUR ?? 1),
    maxChamadasDia: Number(process.env.VOICE_MAX_CALLS_DAY ?? 3),
    maxChamadasPorTelefoneDia: Number(process.env.VOICE_MAX_CALLS_PER_PHONE_DAY ?? 1),
  }
}
