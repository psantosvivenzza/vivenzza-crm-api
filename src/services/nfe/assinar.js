import forge from 'node-forge'
import { DOMParser } from '@xmldom/xmldom'
import { C14nCanonicalization } from 'xml-crypto'
import { EMITENTE, getCertBuffer } from './emitente.js'

// Carrega o certificado .pfx uma vez em memória
let _cert = null
let _key = null

function carregarCertificado() {
  if (_cert && _key) return { cert: _cert, key: _key }

  const pfxBuf = getCertBuffer()
  const pfxDer = forge.util.createBuffer(pfxBuf.toString('binary'))
  const pfxAsn1 = forge.asn1.fromDer(pfxDer)
  const pfx = forge.pkcs12.pkcs12FromAsn1(pfxAsn1, false, EMITENTE.CERT_SENHA)

  const bags = pfx.getBags({ bagType: forge.pki.oids.certBag })
  const certBags = bags[forge.pki.oids.certBag]
  _cert = certBags[0].cert

  const keyBags = pfx.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })
  _key = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag][0].key

  return { cert: _cert, key: _key }
}

// Retorna o certificado em Base64 (para incluir no XML)
export function getCertBase64() {
  const { cert } = carregarCertificado()
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes()
  return forge.util.encode64(der)
}

// Cert + chave em PEM, pro https.Agent (mTLS com a SEFAZ, ver services/nfe/sefaz.js).
// Não usar https.Agent({ pfx, passphrase }) direto com o .pfx bruto — o Node usa o
// parser nativo de PKCS12 (via OpenSSL) pra isso, e o OpenSSL 3.x rejeita PKCS12
// exportado com algoritmos legados (comum em certificados brasileiros mais antigos)
// com "Unsupported PKCS12 PFX data". O node-forge (usado aqui) é um parser PKCS12 em
// JS puro que não tem essa restrição — por isso extraímos cert/key aqui, uma vez, e
// passamos como PEM em vez do .pfx bruto.
export function getCertKeyPem() {
  const { cert, key } = carregarCertificado()
  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(key),
  }
}

// Assina o XML da NFe conforme padrão XML-DSig
export function assinarNFe(xmlStr, chave) {
  const { cert, key } = carregarCertificado()
  const certB64 = getCertBase64()

  // Calcula o digest SHA-1 do elemento infNFe, canonicalizado com C14N de
  // verdade (xml-crypto), não mais a normalização simplificada de antes
  // (só trim + fim de linha — não reordenava atributos/namespaces conforme
  // o algoritmo real, risco de rejeição da SEFAZ por divergência de digest).
  // Canonicaliza a partir do XML COMPLETO (não um substring isolado do
  // infNFe): o C14N inclusivo precisa do contexto de namespace herdado dos
  // ancestrais (infNFe não redeclara xmlns próprio, herda de NFe/nfeProc) —
  // extrair só o fragmento perderia esse contexto.
  const md = forge.md.sha1.create()
  const canonico = canonicalizarInfNFe(xmlStr)
  md.update(canonico, 'utf8')
  const digestValue = forge.util.encode64(md.digest().bytes())

  // Monta o SignedInfo
  const signedInfo = `<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#">` +
    `<CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>` +
    `<SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"/>` +
    `<Reference URI="#NFe${chave}">` +
    `<Transforms>` +
    `<Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/>` +
    `<Transform Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>` +
    `</Transforms>` +
    `<DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/>` +
    `<DigestValue>${digestValue}</DigestValue>` +
    `</Reference>` +
    `</SignedInfo>`

  // Assina o SignedInfo com RSA-SHA1. Diferente do infNFe acima, o SignedInfo
  // já é um fragmento autocontido (declara seu próprio xmlns do xmldsig), não
  // depende de contexto de ancestral — canonicaliza direto como documento
  // isolado.
  const signMd = forge.md.sha1.create()
  signMd.update(canonicalizarFragmentoAutocontido(signedInfo), 'utf8')
  const signature = key.sign(signMd)
  const signatureValue = forge.util.encode64(signature)

  // Monta o bloco Signature
  const signatureBlock = `<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">` +
    signedInfo +
    `<SignatureValue>${signatureValue}</SignatureValue>` +
    `<KeyInfo>` +
    `<X509Data>` +
    `<X509Certificate>${certB64}</X509Certificate>` +
    `</X509Data>` +
    `</KeyInfo>` +
    `</Signature>`

  // Insere a assinatura antes de </infNFe>... na verdade antes de </NFe>
  const xmlAssinado = xmlStr.replace('</NFe>', signatureBlock + '</NFe>')

  return xmlAssinado
}

const c14n = new C14nCanonicalization()

// Canonicaliza o elemento <infNFe> DENTRO do documento completo (não um
// substring isolado) — precisa manter a árvore de ancestrais porque infNFe
// não redeclara xmlns próprio (herda de <NFe>/<nfeProc>, ver xml.js). Extrair
// só o fragmento e canonicalizar isolado perderia esse namespace herdado,
// gerando um digest que não bate com o que a SEFAZ calcula do lado dela.
function canonicalizarInfNFe(xmlCompletoStr) {
  const doc = new DOMParser().parseFromString(xmlCompletoStr, 'text/xml')
  const nos = doc.getElementsByTagName('infNFe')
  if (!nos.length) throw new Error('Elemento infNFe não encontrado no XML para assinatura')
  return c14n.process(nos[0], { defaultNsForPrefix: {}, signatureNode: null })
}

// Canonicaliza um fragmento que já é autocontido (declara o próprio xmlns na
// raiz, ex: <SignedInfo xmlns="...">) — não depende de contexto de ancestral,
// pode ser parseado como documento isolado.
function canonicalizarFragmentoAutocontido(xmlFragmentoStr) {
  const doc = new DOMParser().parseFromString(xmlFragmentoStr, 'text/xml')
  return c14n.process(doc.documentElement, { defaultNsForPrefix: {}, signatureNode: null })
}
