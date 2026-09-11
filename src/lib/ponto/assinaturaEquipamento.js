// Primitivas de assinatura do componente de equipamento — SEM criptografia
// própria. Só node:crypto (OpenSSL): ECDSA P-256/SHA-256 (chave do
// equipamento, gerada via CNG no serviço local, nunca aqui) e HMAC-SHA256
// (autenticidade do desafio emitido pelo backend). Ver
// docs/meu-ponto/PROTOCOLO_COMPONENTE_WINDOWS.md para os testes reais que
// validaram o formato de assinatura (raw IEEE P1363, 64 bytes) e o formato
// de chave pública (JWK EC P-256) contra chaves geradas de verdade pelo CNG
// nesta máquina (TPM e KSP de software).
import crypto from 'node:crypto'

// O CNG (.NET Framework, usado pelo serviço local em PowerShell 5.1) produz
// assinaturas ECDSA em formato raw IEEE P1363 (r‖s), não DER — por isso
// node:crypto precisa ser instruído a interpretar/produzir nesse formato.
const DSA_ENCODING = 'ieee-p1363'

export function calcularHashConteudo(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

// Reconstrói uma chave pública EC P-256 a partir do JWK que o serviço local
// envia (ele mesmo derivado de um BCRYPT_ECCKEY_BLOB — ver protocolo §0).
// Lança se o JWK não tiver o formato esperado — nunca aceita silenciosamente
// um objeto malformado.
export function importarChavePublicaEquipamento(jwk) {
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) {
    throw new Error('chave_publica_jwk_invalida')
  }
  return crypto.createPublicKey({ key: jwk, format: 'jwk' })
}

// Payload assinado pelo EQUIPAMENTO (chave privada no CNG, nunca sai dali).
// Ordem de campos fixa — qualquer mudança aqui invalida assinaturas
// existentes, o que é o comportamento correto (não deve haver compat com
// formato antigo silenciosa).
export function payloadAssinaturaEquipamento({ nonce, equipamentoId, usuarioId, operacaoId, tipo, hashConteudo }) {
  return Buffer.from(`${nonce}|${equipamentoId}|${usuarioId}|${operacaoId}|${tipo}|${hashConteudo}`, 'utf8')
}

// Verifica a assinatura do EQUIPAMENTO. assinaturaBase64 é o valor cru de
// 64 bytes (P-256/SHA-256/IEEE P1363) que o serviço local produziu com
// ECDsaCng.SignData.
export function verificarAssinaturaEquipamento({ chavePublicaJwk, nonce, equipamentoId, usuarioId, operacaoId, tipo, hashConteudo, assinaturaBase64 }) {
  let publicKey
  try {
    publicKey = importarChavePublicaEquipamento(chavePublicaJwk)
  } catch {
    return false
  }
  let sig
  try {
    sig = Buffer.from(assinaturaBase64, 'base64')
  } catch {
    return false
  }
  if (sig.length !== 64) return false // P-256 IEEE P1363 é sempre 64 bytes — qualquer outro tamanho é inválido/adulterado.

  const payload = payloadAssinaturaEquipamento({ nonce, equipamentoId, usuarioId, operacaoId, tipo, hashConteudo })
  try {
    return crypto.verify('sha256', payload, { key: publicKey, dsaEncoding: DSA_ENCODING }, sig)
  } catch {
    return false
  }
}

// Payload assinado pelo BACKEND (HMAC) para provar ao serviço local que um
// desafio recebido é genuíno — não inclui operacao_id (decidido só depois,
// quando o frontend repassa o desafio ao serviço local; ver protocolo §1).
export function payloadDesafio({ nonce, equipamentoId, usuarioId, tipo, hashConteudo, expiraEmISO }) {
  return `${nonce}|${equipamentoId}|${usuarioId}|${tipo}|${hashConteudo}|${expiraEmISO}`
}

export function assinarDesafio({ segredoHmacBase64, nonce, equipamentoId, usuarioId, tipo, hashConteudo, expiraEmISO }) {
  const segredo = Buffer.from(segredoHmacBase64, 'base64')
  const payload = payloadDesafio({ nonce, equipamentoId, usuarioId, tipo, hashConteudo, expiraEmISO })
  return crypto.createHmac('sha256', segredo).update(payload).digest('hex')
}

export function verificarAssinaturaDesafio({ segredoHmacBase64, nonce, equipamentoId, usuarioId, tipo, hashConteudo, expiraEmISO, assinaturaHex }) {
  let esperada
  try {
    esperada = Buffer.from(assinarDesafio({ segredoHmacBase64, nonce, equipamentoId, usuarioId, tipo, hashConteudo, expiraEmISO }), 'hex')
  } catch {
    return false
  }
  let recebida
  try {
    recebida = Buffer.from(assinaturaHex, 'hex')
  } catch {
    return false
  }
  if (esperada.length !== recebida.length) return false
  return crypto.timingSafeEqual(esperada, recebida)
}

export function gerarSegredoHmacBase64() {
  return crypto.randomBytes(32).toString('base64')
}

export function gerarNonce() {
  return crypto.randomBytes(32).toString('base64url')
}

// Código de vínculo: alta entropia (~120 bits, 20 caracteres base32) apesar
// de "digitável" — não é um PIN curto. Resistente a força bruta online
// mesmo sem o rate limit da rota (que existe como camada adicional, não
// como única defesa).
const BASE32_ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // sem I/O/0/1, evita ambiguidade visual
export function gerarCodigoVinculo() {
  const bytes = crypto.randomBytes(15)
  let codigo = ''
  for (let i = 0; i < bytes.length; i++) {
    codigo += BASE32_ALFABETO[bytes[i] % BASE32_ALFABETO.length]
  }
  return codigo
}
