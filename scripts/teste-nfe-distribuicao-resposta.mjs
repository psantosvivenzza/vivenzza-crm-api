// Teste unitário do parser de retDistDFeInt / resNFe / resEvento
// (src/services/nfe-distribuicao/resposta.js, Fase B) — puro, sem I/O, sem
// rede. Roda com: node scripts/teste-nfe-distribuicao-resposta.mjs
import { gzipSync } from 'zlib'
import {
  decodificarDocZip,
  parseResNFe,
  parseResEvento,
  parseRetDistDFeInt,
} from '../src/services/nfe-distribuicao/resposta.js'

let falhas = 0
function check(nome, cond, detalhe) {
  if (cond) console.log(`OK — ${nome}`)
  else { falhas++; console.log(`FALHOU — ${nome}${detalhe ? ' — ' + detalhe : ''}`) }
}

function compactarBase64Gzip(xml) {
  return gzipSync(Buffer.from(xml, 'utf8')).toString('base64')
}

const CHAVE_TESTE = '43260755666777000181550010000001231123456788'

const XML_RES_NFE = `<resNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01">
  <chNFe>${CHAVE_TESTE}</chNFe>
  <CNPJ>55666777000181</CNPJ>
  <xNome>FORNECEDOR TESTE HOMOLOGACAO LTDA</xNome>
  <IE>1234567890</IE>
  <dhEmi>2026-07-28T09:00:00-03:00</dhEmi>
  <tpNF>1</tpNF>
  <vNF>525.00</vNF>
  <digVal>abc123==</digVal>
  <dhRecbto>2026-07-28T10:15:00-03:00</dhRecbto>
  <nProt>143260000123456</nProt>
  <cSitNFe>1</cSitNFe>
</resNFe>`

const XML_RES_EVENTO_CIENCIA = `<resEvento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01">
  <cOrgao>43</cOrgao>
  <CNPJ>13602526000193</CNPJ>
  <chNFe>${CHAVE_TESTE}</chNFe>
  <dhEvento>2026-08-01T09:40:00-03:00</dhEvento>
  <tpEvento>210210</tpEvento>
  <nSeqEvento>1</nSeqEvento>
  <xEvento>Ciencia da Operacao</xEvento>
  <dhRecbto>2026-08-01T09:40:05-03:00</dhRecbto>
  <nProt>143260000654321</nProt>
</resEvento>`

// ===== decodificarDocZip =====
{
  const b64 = compactarBase64Gzip(XML_RES_NFE)
  const decodificado = decodificarDocZip(b64)
  check('decodificarDocZip devolve o XML original exato (base64+gzip roundtrip)', decodificado === XML_RES_NFE)
}

// ===== parseResNFe =====
{
  const r = await parseResNFe(XML_RES_NFE)
  check('parseResNFe: tipo = resNFe', r.tipo === 'resNFe')
  check('parseResNFe: chave de acesso correta', r.chave_acesso === CHAVE_TESTE)
  check('parseResNFe: CNPJ do emitente correto', r.emitente.cnpj === '55666777000181')
  check('parseResNFe: razão social correta', r.emitente.razao_social === 'FORNECEDOR TESTE HOMOLOGACAO LTDA')
  check('parseResNFe: valor da NF correto (525)', r.valor_nf === 525)
  check('parseResNFe: protocolo correto', r.protocolo === '143260000123456')
  check('parseResNFe: data de autorização preservada', r.data_autorizacao === '2026-07-28T10:15:00-03:00')
  check('parseResNFe: situacao_raw não é traduzida (fica bruta)', r.situacao_raw === '1')
}

// ===== parseResEvento =====
{
  const r = await parseResEvento(XML_RES_EVENTO_CIENCIA)
  check('parseResEvento: tipo = resEvento', r.tipo === 'resEvento')
  check('parseResEvento: chave de acesso correta', r.chave_acesso === CHAVE_TESTE)
  check('parseResEvento: tipo_evento numérico correto (210210)', r.tipo_evento === 210210)
  check('parseResEvento: mapeia 210210 pra "ciencia_operacao"', r.tipo_evento_manifestacao === 'ciencia_operacao')
  check('parseResEvento: autor CNPJ correto', r.autor.cnpj === '13602526000193')
  check('parseResEvento: sequência do evento correta', r.sequencia_evento === 1)
}

// ===== mapeamento de todos os 4 códigos de manifestação =====
{
  const casos = [
    ['210200', 'confirmacao_operacao'],
    ['210210', 'ciencia_operacao'],
    ['210220', 'desconhecimento_operacao'],
    ['210240', 'operacao_nao_realizada'],
  ]
  for (const [codigo, esperado] of casos) {
    const xml = XML_RES_EVENTO_CIENCIA.replace('210210', codigo)
    const r = await parseResEvento(xml)
    check(`tpEvento ${codigo} mapeia pra "${esperado}"`, r.tipo_evento_manifestacao === esperado)
  }
}

// ===== parseRetDistDFeInt (lote completo) =====
{
  const docZipResNFe = compactarBase64Gzip(XML_RES_NFE)
  const docZipResEvento = compactarBase64Gzip(XML_RES_EVENTO_CIENCIA)

  const xmlCompleto = `<retDistDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01">
  <tpAmb>2</tpAmb>
  <verAplic>SVRS250101000000</verAplic>
  <cStat>138</cStat>
  <xMotivo>Documento localizado</xMotivo>
  <dhResp>2026-08-01T09:41:00-03:00</dhResp>
  <ultNSU>000000000000002</ultNSU>
  <maxNSU>000000000000002</maxNSU>
  <loteDistDFeInt>
    <docZip NSU="000000000000001" schema="resNFe_v1.01.xsd">${docZipResNFe}</docZip>
    <docZip NSU="000000000000002" schema="resEvento_v1.01.xsd">${docZipResEvento}</docZip>
  </loteDistDFeInt>
</retDistDFeInt>`

  const resultado = await parseRetDistDFeInt(xmlCompleto)
  check('parseRetDistDFeInt: ambiente = homologacao (tpAmb=2)', resultado.ambiente === 'homologacao')
  check('parseRetDistDFeInt: cstat correto', resultado.cstat === '138')
  check('parseRetDistDFeInt: ultNSU correto', resultado.ultNSU === '000000000000002')
  check('parseRetDistDFeInt: maxNSU correto', resultado.maxNSU === '000000000000002')
  check('parseRetDistDFeInt: 2 documentos no lote', resultado.docs.length === 2)
  check('parseRetDistDFeInt: doc 1 é resNFe com NSU correto', resultado.docs[0].tipo === 'resNFe' && resultado.docs[0].nsu === '000000000000001')
  check('parseRetDistDFeInt: doc 2 é resEvento com NSU correto', resultado.docs[1].tipo === 'resEvento' && resultado.docs[1].nsu === '000000000000002')
  check('parseRetDistDFeInt: doc 1 preserva chave de acesso', resultado.docs[0].chave_acesso === CHAVE_TESTE)
}

// ===== cStat=137 (nenhum documento) — lote vazio, não deve quebrar =====
{
  const xmlVazio = `<retDistDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01">
  <tpAmb>2</tpAmb>
  <verAplic>SVRS250101000000</verAplic>
  <cStat>137</cStat>
  <xMotivo>Nenhum documento localizado</xMotivo>
  <dhResp>2026-08-01T09:41:00-03:00</dhResp>
  <ultNSU>000000000000002</ultNSU>
  <maxNSU>000000000000002</maxNSU>
</retDistDFeInt>`
  const resultado = await parseRetDistDFeInt(xmlVazio)
  check('parseRetDistDFeInt: cStat=137 sem loteDistDFeInt não quebra', resultado.docs.length === 0)
  check('parseRetDistDFeInt: cstat=137 preservado', resultado.cstat === '137')
}

// ===== schema não suportado (procNFe) não interrompe o lote =====
{
  const docZipProcNFe = compactarBase64Gzip('<nfeProc>xml completo fake so pra testar</nfeProc>')
  const xmlComProcNFe = `<retDistDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01">
  <tpAmb>2</tpAmb>
  <verAplic>SVRS250101000000</verAplic>
  <cStat>138</cStat>
  <xMotivo>Documento localizado</xMotivo>
  <dhResp>2026-08-01T09:41:00-03:00</dhResp>
  <ultNSU>000000000000003</ultNSU>
  <maxNSU>000000000000003</maxNSU>
  <loteDistDFeInt>
    <docZip NSU="000000000000003" schema="procNFe_v1.00.xsd">${docZipProcNFe}</docZip>
  </loteDistDFeInt>
</retDistDFeInt>`
  const resultado = await parseRetDistDFeInt(xmlComProcNFe)
  check('parseRetDistDFeInt: schema procNFe não suportado vira "nao_processado" (não quebra o lote)', resultado.docs[0].tipo === 'nao_processado')
  check('parseRetDistDFeInt: doc não_processado preserva o XML completo decodificado', resultado.docs[0].xml_completo.includes('xml completo fake'))
}

console.log(`\n${falhas === 0 ? 'TODOS OS TESTES PASSARAM' : `${falhas} TESTE(S) FALHARAM`}`)
process.exit(falhas === 0 ? 0 : 1)
