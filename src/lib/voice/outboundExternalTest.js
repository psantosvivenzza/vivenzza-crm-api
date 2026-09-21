// 2026-08-16 — prontidão SIP trunk externo (Nvoip). Lógica PURA (sem
// rede/ARI/DB aqui), espelhando outboundInternalTest.js — mas pra
// "vivenzza-external-test", o primeiro teste de discagem PÚBLICA (fora do
// ramal interno PJSIP/7001).
//
// REGRA DE OURO: só chega a montar um payload de originate depois de
// avaliarAutorizacaoChamadaExterna() (externalPilotGuardrails.js) E os
// limites globais (avaliarLimiteGlobalPorHora/Dia) terem autorizado.
// ATUALIZADO 2026-09-16/21: TRUNK_EXTERNO_CONFIGURADO passou a true
// (adapter Nvoip implementado) — resolverDestino(EXTERNAL) NÃO lança mais
// por si só. A trava real de "sem trunk pronto" agora é a ausência de
// NVOIP_SIP_SERVER, checada AQUI (abaixo) e também dentro de
// avaliarAutorizacaoChamadaExterna via avaliarTrunkPronto — dupla trava
// continua existindo, só que por outro critério.
import { TIPO_DESTINO, resolverDestino } from './destinoResolver.js'
import { lerConfigNvoip } from './externalConfig.js'

export const CONTEXTO_MARCADOR = 'EXTERNAL_PILOT_TEST'
export const NO_ANSWER_TIMEOUT_S = 30

// Nunca inclui dado de cobrança (título/cliente/valor) — este é um teste de
// PIPELINE/trunk, não uma ligação de cobrança real (essa é uma decisão
// futura separada, ver collectionGuardsForVoice.js).
export function construirPayloadOriginateExterno({ numero, ariApp, callerId, clienteNome }) {
  if (!numero) throw new Error('construirPayloadOriginateExterno: número é obrigatório')
  // ATUALIZADO 2026-09-21: resolverDestino NÃO lança mais para EXTERNAL
  // (adapter Nvoip existe desde 2026-09-16) — mantido mesmo assim como
  // defesa em profundidade caso o adapter seja removido/quebre no futuro.
  // A trava real de "trunk pronto" hoje é o check de NVOIP_SIP_SERVER logo
  // abaixo (e, antes disso, avaliarTrunkPronto em avaliarAutorizacaoChamadaExterna).
  const endpointBase = resolverDestino(TIPO_DESTINO.EXTERNAL)
  // ACHADO REAL (2026-09-16, primeira tentativa de chamada real) —
  // `PJSIP/<endpoint>/<numero-cru>` NÃO é um dial-string válido pra um
  // trunk com destino explícito: o Asterisk tenta interpretar o terceiro
  // segmento como uma URI SIP completa e rejeita ("Could not create
  // dialog to invalid URI '+55...'"). Erro real visto em
  // /var/log/asterisk/messages.log:
  //   res_pjsip.c: Endpoint 'nvoip-endpoint': Could not create dialog to
  //   invalid URI '+55XXXXXXXXXXX'. Is endpoint registered and reachable?
  // Fix: montar a URI SIP completa (sip:<numero>@<host-da-nvoip>), lida de
  // NVOIP_SIP_SERVER/NVOIP_SIP_PORT (externalConfig.js) — nunca
  // hardcoded aqui, pra nunca dessincronizar do que está em pjsip_nvoip.conf.
  const { sipServer, sipPort } = lerConfigNvoip()
  if (!sipServer) throw new Error('construirPayloadOriginateExterno: NVOIP_SIP_SERVER não configurado — não sei montar a URI de destino')
  // ACHADO REAL (2026-09-16, segunda tentativa de chamada real) — com a URI
  // SIP correta mas o número mantendo o "+", a Nvoip respondeu
  // 404 Not Found / Reason: cause=3;text="NO_ROUTE_DESTINATION" (visto ao
  // vivo no console do Asterisk, depois da autenticação digest já ter
  // funcionado). O dial-plan da Nvoip não reconhece o "+" — usa dígitos
  // puros (E.164 sem o prefixo "+"). Nunca reformatar o número em nenhum
  // outro ponto do sistema (allowlist/DB continuam em formato E.164 com
  // "+"); a normalização é só aqui, na hora de montar a URI de destino.
  const numeroNvoip = formatarNumeroParaNvoip(numero)
  const uriDestino = `sip:${numeroNvoip}@${sipServer}:${sipPort || 5060}`
  const { callerId: callerIdConfigurado } = lerConfigNvoip()
  return {
    endpoint: `${endpointBase}/${uriDestino}`,
    app: ariApp,
    appArgs: CONTEXTO_MARCADOR,
    // A Nvoip precisa de um BINA NUMÉRICO válido (o DID contratado) — um
    // callerId puramente textual ("Vivenzza Voice AI") faz a operadora de
    // destino não completar a chamada. Ver ACHADO REAL de 2026-09-17 abaixo.
    callerId: callerId || callerIdConfigurado || 'Vivenzza Voice AI',
    timeout: NO_ANSWER_TIMEOUT_S,
    // O nome do contato viaja como variavel de canal para o servico de voz
    // montar a saudacao personalizada ("Falo com o Fulano?"). Pesquisa de
    // mercado (17/09/2026): TODO script de cobranca profissional pede a
    // PESSOA pelo nome antes de dizer qualquer coisa sobre o assunto -- e
    // isso tambem e o que protege o Art. 42 do CDC, porque impede que quem
    // atendeu o telefone (recepcionista, cabeleireiro) ouca falar de titulo.
    variables: {
      VIVENZZA_EXTERNAL_TEST: '1',
      ...(clienteNome ? { VIVENZZA_CLIENTE_NOME: String(clienteNome) } : {}),
    },
  }
}

// ACHADO REAL (2026-09-17, depois de ~15 tentativas reais de chamada) — a
// causa de o telefone NUNCA tocar, mesmo com registro SIP OK, saldo OK,
// autenticação digest OK e a Nvoip respondendo "183 Session Progress":
// estávamos discando com o código de país ("55") na frente.
//
// O dial-plan da Nvoip espera DDD + número, SEM "+" e SEM "55" — é
// exatamente o formato que o webphone do painel deles usa (comprovado:
// discando "51991567661" pelo painel o telefone toca; nosso INVITE mandava
// "5551991567661" e a chamada morria em 183 sem nunca completar, ou
// 404 Not Found depois que o From passou a usar o domínio deles).
//
// Mantemos E.164 com "+" em TODO o resto do sistema (allowlist, DB,
// guardrails) — a conversão acontece só aqui, na fronteira com a Nvoip.
// DDDs válidos no Brasil (Plano Geral de Códigos Nacionais da Anatel).
// Discar um número malformado numa cobrança não é "ligação perdida": é
// ligar para um TERCEIRO aleatório falando de conta em atraso — exatamente
// a exposição que o Art. 42 do CDC pune.
const DDDS_VALIDOS = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19,
  21, 22, 24, 27, 28,
  31, 32, 33, 34, 35, 37, 38,
  41, 42, 43, 44, 45, 46, 47, 48, 49,
  51, 53, 54, 55,
  61, 62, 63, 64, 65, 66, 67, 68, 69,
  71, 73, 74, 75, 77, 79,
  81, 82, 83, 84, 85, 86, 87, 88, 89,
  91, 92, 93, 94, 95, 96, 97, 98, 99,
])

/**
 * Valida um telefone brasileiro ANTES de discar. Fail-closed: qualquer
 * dúvida reprova.
 * Aceita apenas: DDD válido + celular de 9 dígitos começando com 9.
 * Recusa fixo de propósito — a régua e o roteiro são desenhados para celular.
 */
export function validarTelefoneBrasileiro(numero) {
  const d = String(numero ?? '').replace(/\D/g, '')
  const semDdi = d.startsWith('55') && (d.length === 12 || d.length === 13) ? d.slice(2) : d
  if (semDdi.length !== 11) {
    return { valido: false, motivo: `telefone_invalido: ${semDdi.length} dígitos (esperado 11 = DDD + 9 dígitos)` }
  }
  const ddd = Number(semDdi.slice(0, 2))
  if (!DDDS_VALIDOS.has(ddd)) return { valido: false, motivo: `ddd_invalido: ${ddd}` }
  if (semDdi[2] !== '9') return { valido: false, motivo: 'nao_e_celular: 9o digito ausente' }
  if (/^(\d)\1+$/.test(semDdi.slice(2))) return { valido: false, motivo: 'numero_repetitivo' }
  return { valido: true, motivo: null }
}

export function formatarNumeroParaNvoip(numero) {
  const digitos = String(numero).replace(/\D/g, '')
  // 55 + DDD(2) + número(8 ou 9) => 12 ou 13 dígitos. Só então removemos o 55.
  if (digitos.startsWith('55') && (digitos.length === 12 || digitos.length === 13)) {
    return digitos.slice(2)
  }
  return digitos
}

export function avaliarChamadaJaAtiva(listaCanaisAtual) {
  const canais = Array.isArray(listaCanaisAtual) ? listaCanaisAtual : []
  return canais.length > 0
}

export function avaliarEndpointOnline(endpointInfo) {
  return endpointInfo?.state === 'online'
}

// Mesma classificação já usada pelo MVP interno (outboundInternalTest.js) —
// não duplica a regra, só reexporta pra quem só importar deste arquivo não
// precisar saber que a implementação é compartilhada.
export { classificarCausaSemAtendimento } from './outboundInternalTest.js'
