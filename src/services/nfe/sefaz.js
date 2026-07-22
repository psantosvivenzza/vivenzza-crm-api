import https from 'https'
import axios from 'axios'
import { parseStringPromise } from 'xml2js'
import { EMITENTE, SEFAZ } from './emitente.js'
import { getCertKeyPem } from './assinar.js'

// A SEFAZ rejeita XML com espaço em branco (quebra de linha, indentação) ENTRE tags —
// cStat 588, "Rejeicao: Nao eh permitida a presenca de caracteres de edicao no
// inicio/fim da mensagem ou entre as tags da mensagem". Os templates abaixo são
// escritos formatados por legibilidade; isso compacta o resultado final antes de
// mandar pra rede. Só mexe no que fica entre `>` e `<` — nunca no texto de dentro de
// um elemento (ex: o conteúdo de xJust).
function compactarXml(xml) {
  return xml.replace(/>\s+</g, '><').trim()
}

// Envelope SOAP para envio de lote de NFe. xmlNFe já é XML assinado (assinar.js) —
// entra via placeholder e é colado DEPOIS da compactação, pra nunca passar pela
// regex de compactação (o digest da assinatura foi calculado sobre esse conteúdo
// exato; não é seguro reprocessar o texto depois de assinado).
function montarEnvelopeAutorizacao(xmlNFe) {
  const envelope = compactarXml(`<?xml version="1.0" encoding="UTF-8"?>
<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
  <soap12:Body>
    <nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4">
      <enviNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
        <idLote>${Date.now()}</idLote>
        <indSinc>1</indSinc>
        __XML_NFE__
      </enviNFe>
    </nfeDadosMsg>
  </soap12:Body>
</soap12:Envelope>`)
  return envelope.replace('__XML_NFE__', xmlNFe)
}

function montarEnvelopeConsulta(chave) {
  return compactarXml(`<?xml version="1.0" encoding="UTF-8"?>
<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
  <soap12:Body>
    <nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NfeConsulta4">
      <consSitNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
        <tpAmb>${SEFAZ.tpAmb}</tpAmb>
        <xServ>CONSULTAR</xServ>
        <chNFe>${chave}</chNFe>
      </consSitNFe>
    </nfeDadosMsg>
  </soap12:Body>
</soap12:Envelope>`)
}

function montarEnvelopeCancelamento(chave, protocolo, justificativa) {
  const dhEvento = new Date().toISOString().replace(/\.\d{3}Z$/, '-03:00')
  const nSeqEvento = '1'
  const tpEvento = '110111'
  const idEvento = `ID${tpEvento}${chave}${nSeqEvento.padStart(2, '0')}`

  const xml = `<eventoCancNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00">
  <infEvento Id="${idEvento}">
    <cOrgao>${SEFAZ.cUF}</cOrgao>
    <tpAmb>${SEFAZ.tpAmb}</tpAmb>
    <CNPJ>${EMITENTE.CNPJ}</CNPJ>
    <chNFe>${chave}</chNFe>
    <dhEvento>${dhEvento}</dhEvento>
    <tpEvento>${tpEvento}</tpEvento>
    <nSeqEvento>${nSeqEvento}</nSeqEvento>
    <verEvento>1.00</verEvento>
    <detEvento versao="1.00">
      <descEvento>Cancelamento</descEvento>
      <nProt>${protocolo}</nProt>
      <xJust>${justificativa.slice(0, 255)}</xJust>
    </detEvento>
  </infEvento>
</eventoCancNFe>`

  return compactarXml(`<?xml version="1.0" encoding="UTF-8"?>
<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
  <soap12:Body>
    <nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NfeCancelamento4">
      <envEvento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00">
        <idLote>${Date.now()}</idLote>
        ${xml}
      </envEvento>
    </nfeDadosMsg>
  </soap12:Body>
</soap12:Envelope>`)
}

// Carrega o certificado para TLS mútuo
function carregarAgenteTLS() {
  try {
    // cert/key em PEM (via node-forge, ver assinar.js) em vez de { pfx, passphrase }
    // bruto — o parser PKCS12 nativo do Node/OpenSSL 3.x rejeita este .pfx com
    // "Unsupported PKCS12 PFX data" (algoritmo legado). O forge lê sem problema.
    const { certPem, keyPem } = getCertKeyPem()
    return new https.Agent({
      cert: certPem,
      key: keyPem,
      rejectUnauthorized: false, // SEFAZ usa cadeia própria
    })
  } catch (e) {
    console.warn('[sefaz] Certificado não carregado:', e.message)
    return undefined
  }
}

let _agenteTLS = null

async function getAgenteTLS() {
  if (!_agenteTLS) _agenteTLS = await carregarAgenteTLS()
  return _agenteTLS
}

async function soapPost(url, envelope, soapAction) {
  const httpsAgent = await getAgenteTLS()
  const response = await axios.post(url, envelope, {
    httpsAgent,
    headers: {
      'Content-Type': 'application/soap+xml; charset=utf-8',
      ...(soapAction ? { SOAPAction: soapAction } : {}),
    },
    timeout: 30000,
  })
  return response.data
}

// Envia NFe para autorização na SEFAZ
export async function enviarNFe(xmlAssinado) {
  const envelope = montarEnvelopeAutorizacao(xmlAssinado)
  const respXml = await soapPost(SEFAZ.urls.autorizacao, envelope)
  const parsed = await parseStringPromise(respXml, { explicitArray: false, ignoreAttrs: false })

  // Navega até o retEnviNFe dentro do Body SOAP
  const body = parsed?.['soap:Envelope']?.['soap:Body'] ||
               parsed?.['env:Envelope']?.['env:Body']
  const ret = body?.nfeResultMsg?.retEnviNFe || body?.nfeResultMsg

  if (!ret) throw new Error('Resposta SEFAZ inválida')

  const cStat = ret.cStat || ret?.retEnviNFe?.cStat
  const xMotivo = ret.xMotivo || ret?.retEnviNFe?.xMotivo
  const protocolo = ret.protNFe?.infProt?.nProt || ret?.retEnviNFe?.protNFe?.infProt?.nProt

  return { cStat, xMotivo, protocolo, respXml }
}

// Consulta situação de uma NFe pelo número da chave
export async function consultarNFe(chave) {
  const envelope = montarEnvelopeConsulta(chave)
  const respXml = await soapPost(SEFAZ.urls.consultaProtocolo, envelope)
  const parsed = await parseStringPromise(respXml, { explicitArray: false })

  const body = parsed?.['soap:Envelope']?.['soap:Body'] ||
               parsed?.['env:Envelope']?.['env:Body']
  const ret = body?.nfeResultMsg?.retConsSitNFe

  return {
    cStat: ret?.cStat,
    xMotivo: ret?.xMotivo,
    protocolo: ret?.protNFe?.infProt?.nProt,
    respXml,
  }
}

// Cancelar NFe já autorizada
export async function cancelarNFe(chave, protocolo, justificativa) {
  const envelope = montarEnvelopeCancelamento(chave, protocolo, justificativa)
  const respXml = await soapPost(SEFAZ.urls.cancelamento, envelope)
  const parsed = await parseStringPromise(respXml, { explicitArray: false })

  const body = parsed?.['soap:Envelope']?.['soap:Body'] ||
               parsed?.['env:Envelope']?.['env:Body']
  const ret = body?.nfeResultMsg?.retEnvEvento

  return {
    cStat: ret?.cStat,
    xMotivo: ret?.xMotivo,
    respXml,
  }
}

// Verifica status do serviço SEFAZ
export async function statusSefaz() {
  const envelope = compactarXml(`<?xml version="1.0" encoding="UTF-8"?>
<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
  <soap12:Body>
    <nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeStatusServico4">
      <consStatServ xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
        <tpAmb>${SEFAZ.tpAmb}</tpAmb>
        <cUF>${SEFAZ.cUF}</cUF>
        <xServ>STATUS</xServ>
      </consStatServ>
    </nfeDadosMsg>
  </soap12:Body>
</soap12:Envelope>`)

  try {
    const respXml = await soapPost(SEFAZ.urls.statusServico, envelope)
    const parsed = await parseStringPromise(respXml, { explicitArray: false })
    const body = parsed?.['soap:Envelope']?.['soap:Body']
    const ret = body?.nfeResultMsg?.retConsStatServ
    return { online: ret?.cStat === '107', cStat: ret?.cStat, xMotivo: ret?.xMotivo }
  } catch {
    return { online: false }
  }
}
