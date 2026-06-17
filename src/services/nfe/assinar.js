import forge from 'node-forge'
import { readFileSync } from 'fs'
import { EMITENTE } from './emitente.js'

// Carrega o certificado .pfx uma vez em memória
let _cert = null
let _key = null

function carregarCertificado() {
  if (_cert && _key) return { cert: _cert, key: _key }

  const pfxBuf = readFileSync(EMITENTE.CERT_PATH)
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

// Assina o XML da NFe conforme padrão XML-DSig
export function assinarNFe(xmlStr, chave) {
  const { cert, key } = carregarCertificado()
  const certB64 = getCertBase64()

  // Calcula o digest SHA-1 do elemento infNFe (canonicalizado C14N)
  const md = forge.md.sha1.create()
  // Extrai o conteúdo do infNFe para hash
  const infNFeContent = extrairElemento(xmlStr, 'infNFe')
  const canonico = canonicalize(infNFeContent)
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

  // Assina o SignedInfo com RSA-SHA1
  const signMd = forge.md.sha1.create()
  signMd.update(canonicalize(signedInfo), 'utf8')
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

// Extrai o conteúdo de um elemento XML pelo nome da tag
function extrairElemento(xml, tagName) {
  const regex = new RegExp(`<${tagName}[^>]*>[\\s\\S]*?<\\/${tagName}>`)
  const match = xml.match(regex)
  return match ? match[0] : xml
}

// Canonicalização C14N simples (para fins de digest)
// Para produção, usar uma biblioteca C14N completa
function canonicalize(xml) {
  return xml
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim()
}
