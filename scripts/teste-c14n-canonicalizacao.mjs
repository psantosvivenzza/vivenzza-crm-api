// Teste unitário da canonicalização C14N real (xml-crypto) — sem precisar de
// certificado. Verifica a propriedade fundamental do C14N: dois XMLs
// semanticamente idênticos mas com atributos em ordem diferente / espaçamento
// diferente devem produzir o MESMO digest. A implementação anterior (trim +
// normalização de quebra de linha) falhava nisso — não reordenava atributos.
import crypto from 'crypto'
import { DOMParser } from '@xmldom/xmldom'
import { C14nCanonicalization } from 'xml-crypto'

const c14n = new C14nCanonicalization()
function canonSha1(xmlStr) {
  const doc = new DOMParser().parseFromString(xmlStr, 'text/xml')
  const canon = c14n.process(doc.documentElement, { defaultNsForPrefix: {}, signatureNode: null })
  return { canon, sha1: crypto.createHash('sha1').update(canon, 'utf8').digest('base64') }
}

let falhas = 0
function check(nome, cond, detalhe) {
  if (cond) console.log(`OK — ${nome}`)
  else { falhas++; console.log(`FALHOU — ${nome}${detalhe ? ' — ' + detalhe : ''}`) }
}

// Mesmo elemento, atributos em ordem diferente — C14N deve produzir o MESMO resultado.
const xmlA = `<infNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00" Id="NFe123"><ide><cUF>43</cUF></ide></infNFe>`
const xmlB = `<infNFe Id="NFe123" versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe"><ide><cUF>43</cUF></ide></infNFe>`
const rA = canonSha1(xmlA)
const rB = canonSha1(xmlB)
check('C14N produz o mesmo digest independente da ordem dos atributos', rA.sha1 === rB.sha1, `A=${rA.sha1} B=${rB.sha1}`)

// XML com infNFe SEM xmlns próprio, herdando do ancestral NFe — deve preservar
// o namespace herdado no elemento canonicalizado (é exatamente o caso real da
// NFe: infNFe não redeclara xmlns, herda de NFe/nfeProc).
const xmlCompleto = `<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><NFe xmlns="http://www.portalfiscal.inf.br/nfe"><infNFe versao="4.00" Id="NFe123"><ide><cUF>43</cUF></ide></infNFe></NFe></nfeProc>`
const doc = new DOMParser().parseFromString(xmlCompleto, 'text/xml')
const infNFeNode = doc.getElementsByTagName('infNFe')[0]
const canonHerdado = c14n.process(infNFeNode, { defaultNsForPrefix: {}, signatureNode: null })
check('infNFe extraído do documento completo preserva xmlns herdado do ancestral', canonHerdado.includes('xmlns="http://www.portalfiscal.inf.br/nfe"'), canonHerdado)

// Comparação com a implementação ANTIGA (trim simples) — prova que ela
// realmente não normalizava nada além de espaço em branco nas bordas.
function implementacaoAntiga(xml) {
  return xml.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
}
const antigaA = crypto.createHash('sha1').update(implementacaoAntiga(xmlA), 'utf8').digest('base64')
const antigaB = crypto.createHash('sha1').update(implementacaoAntiga(xmlB), 'utf8').digest('base64')
check('implementação ANTIGA (referência) falhava em diferenciar ordem de atributos — confirma o bug corrigido', antigaA !== antigaB, `antigaA=${antigaA} antigaB=${antigaB}`)

console.log(`\n${falhas === 0 ? 'TODOS OS TESTES PASSARAM' : `${falhas} TESTE(S) FALHARAM`}`)
process.exit(falhas === 0 ? 0 : 1)
