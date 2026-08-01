// Teste unitário do parser de XML de NF-e de entrada (src/services/nfe-entrada/xml.js) —
// puro, sem I/O, sem rede. Persiste os testes que já foram feitos manualmente
// durante a implementação da Fase A, pra virarem regressão automática.
//
// Roda com: node scripts/teste-nfe-entrada-xml.mjs
//
// A chave de acesso e o CNPJ do fornecedor usados abaixo são calculados de
// verdade (dígito verificador real via algoritmo módulo 11), não inventados —
// mesmo padrão já usado em scripts/teste-cnpj-alfanumerico.mjs.

import { parseNFeXml, sha256 } from '../src/services/nfe-entrada/xml.js'

let falhas = 0
function check(nome, cond, detalhe) {
  if (cond) console.log(`OK — ${nome}`)
  else { falhas++; console.log(`FALHOU — ${nome}${detalhe ? ' — ' + detalhe : ''}`) }
}

const CNPJ_FORNECEDOR_TESTE = '55666777000181' // raiz arbitrária, DV calculado de verdade
const CNPJ_VIVENZZA = '13602526000193' // CNPJ real da Vivenzza (destinatário)
const CHAVE_VALIDA = '43260755666777000181550010000001231123456788' // DV calculado, ambiente=2 (homologação) via protocolo

function montarXml({ tpAmb = '2', cStat = '100', xMotivo = 'Autorizado o uso da NF-e', comProtocolo = true } = {}) {
  const protNFe = comProtocolo ? `
  <protNFe versao="4.00">
    <infProt>
      <tpAmb>${tpAmb}</tpAmb>
      <verAplic>SVRS250101000000</verAplic>
      <chNFe>${CHAVE_VALIDA}</chNFe>
      <dhRecbto>2026-07-28T10:15:00-03:00</dhRecbto>
      <nProt>143260000123456</nProt>
      <digVal>abc123==</digVal>
      <cStat>${cStat}</cStat>
      <xMotivo>${xMotivo}</xMotivo>
    </infProt>
  </protNFe>` : ''

  return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">
  <NFe>
    <infNFe versao="4.00" Id="NFe${CHAVE_VALIDA}">
      <ide>
        <cUF>43</cUF>
        <natOp>Venda de mercadoria</natOp>
        <mod>55</mod>
        <serie>1</serie>
        <nNF>123</nNF>
        <dhEmi>2026-07-28T09:00:00-03:00</dhEmi>
        <tpNF>1</tpNF>
        <tpAmb>${tpAmb}</tpAmb>
      </ide>
      <emit>
        <CNPJ>${CNPJ_FORNECEDOR_TESTE}</CNPJ>
        <xNome>FORNECEDOR TESTE HOMOLOGACAO LTDA</xNome>
        <xFant>Fornecedor Teste</xFant>
        <IE>1234567890</IE>
        <enderEmit>
          <xLgr>Rua Teste</xLgr>
          <nro>100</nro>
          <xMun>Porto Alegre</xMun>
          <UF>RS</UF>
        </enderEmit>
      </emit>
      <dest>
        <CNPJ>${CNPJ_VIVENZZA}</CNPJ>
        <xNome>L&amp;L SANTOS COSMETICOS LTDA</xNome>
      </dest>
      <det nItem="1">
        <prod>
          <cProd>PROD-001</cProd>
          <cEAN>7891234567890</cEAN>
          <xProd>SHAMPOO PROFISSIONAL 1L</xProd>
          <NCM>33051000</NCM>
          <CFOP>5102</CFOP>
          <uCom>CX</uCom>
          <qCom>10.0000</qCom>
          <vUnCom>50.0000000000</vUnCom>
          <vProd>500.00</vProd>
          <vDesc>0.00</vDesc>
        </prod>
        <imposto>
          <ICMS>
            <ICMS00>
              <vICMS>90.00</vICMS>
            </ICMS00>
          </ICMS>
          <IPI>
            <IPITrib>
              <vIPI>10.00</vIPI>
            </IPITrib>
          </IPI>
          <PIS>
            <PISAliq>
              <vPIS>8.25</vPIS>
            </PISAliq>
          </PIS>
          <COFINS>
            <COFINSAliq>
              <vCOFINS>38.00</vCOFINS>
            </COFINSAliq>
          </COFINS>
        </imposto>
      </det>
      <total>
        <ICMSTot>
          <vProd>500.00</vProd>
          <vFrete>15.00</vFrete>
          <vSeg>0.00</vSeg>
          <vDesc>0.00</vDesc>
          <vOutro>0.00</vOutro>
          <vIPI>10.00</vIPI>
          <vICMS>90.00</vICMS>
          <vNF>525.00</vNF>
        </ICMSTot>
      </total>
      <cobr>
        <dup>
          <nDup>001</nDup>
          <dVenc>2026-08-27</dVenc>
          <vDup>525.00</vDup>
        </dup>
      </cobr>
    </infNFe>
  </NFe>${protNFe}
</nfeProc>`
}

const run = async () => {
  // 1. Parse feliz (XML completo, com protocolo, homologação)
  const xmlValido = montarXml()
  const parsed = await parseNFeXml(xmlValido)

  check('chave_acesso extraída corretamente', parsed.chave_acesso === CHAVE_VALIDA)
  check('protocolo_autorizacao extraído', parsed.protocolo_autorizacao === '143260000123456')
  check('protocolo_cstat === "100"', String(parsed.protocolo_cstat) === '100')
  check('ambiente = homologacao quando tpAmb=2 (via protocolo)', parsed.ambiente === 'homologacao')
  check('numero da nota extraído (123)', parsed.numero === 123)
  check('serie extraída (1)', parsed.serie === 1)
  check('CNPJ do fornecedor extraído', parsed.fornecedor.cnpj === CNPJ_FORNECEDOR_TESTE)
  check('razão social do fornecedor extraída', parsed.fornecedor.razao_social === 'FORNECEDOR TESTE HOMOLOGACAO LTDA')
  check('CNPJ do destinatário extraído (Vivenzza)', parsed.destinatario_cnpj === CNPJ_VIVENZZA)
  check('1 item extraído', parsed.itens.length === 1)
  check('quantidade do item (10)', parsed.itens[0].quantidade_fornecedor === 10)
  check('valor unitário do item (50)', parsed.itens[0].valor_unitario_fornecedor === 50)
  check('valor total do item (500)', parsed.itens[0].valor_total_item === 500)
  check('valor ICMS do item (90)', parsed.itens[0].valor_icms === 90)
  check('valor IPI do item (10)', parsed.itens[0].valor_ipi === 10)
  check('unidade do fornecedor (CX)', parsed.itens[0].unidade_fornecedor === 'CX')
  check('gtin extraído', parsed.itens[0].gtin === '7891234567890')
  check('valor total da nota (525)', parsed.valores.valor_total === 525)
  check('valor do frete (15)', parsed.valores.valor_frete === 15)
  check('1 duplicata extraída', parsed.duplicatas.length === 1)
  check('valor da duplicata (525)', parsed.duplicatas[0].valor === 525)
  check('xml_completo preservado (contém a chave)', parsed.xml_completo.includes(CHAVE_VALIDA))

  // 2. tpAmb=1 (produção) via protocolo
  const parsedProducao = await parseNFeXml(montarXml({ tpAmb: '1' }))
  check('ambiente = producao quando tpAmb=1', parsedProducao.ambiente === 'producao')

  // 3. sha256 é determinístico (usado pra detectar duplicata por conteúdo)
  const hash1 = sha256(xmlValido)
  const hash2 = sha256(xmlValido)
  const hash3 = sha256(xmlValido + ' ')
  check('sha256 é determinístico (mesmo XML → mesmo hash)', hash1 === hash2)
  check('sha256 muda com qualquer alteração no conteúdo', hash1 !== hash3)

  // 4. XML sem <NFe><infNFe> — deve lançar erro descritivo
  let lancouSemNFe = false
  try { await parseNFeXml('<algumaCoisa></algumaCoisa>') }
  catch (e) { lancouSemNFe = /não é uma NF-e válida/.test(e.message) }
  check('XML sem <NFe><infNFe> lança erro descritivo', lancouSemNFe)

  // 5. XML mal formado (tag não fechada) — deve lançar erro descritivo
  let lancouMalFormado = false
  try { await parseNFeXml('<nfeProc><NFe><infNFe>') }
  catch (e) { lancouMalFormado = /mal formado/.test(e.message) }
  check('XML mal formado lança erro descritivo', lancouMalFormado)

  // 6. XML sem nenhum item (<det>) — deve lançar erro descritivo
  const xmlSemItem = montarXml().replace(/<det nItem="1">[\s\S]*?<\/det>/, '')
  let lancouSemItem = false
  try { await parseNFeXml(xmlSemItem) }
  catch (e) { lancouSemItem = /nenhum item/.test(e.message) }
  check('XML sem nenhum item lança erro descritivo', lancouSemItem)

  console.log(`\n${falhas === 0 ? 'TODOS OS TESTES PASSARAM' : `${falhas} TESTE(S) FALHARAM`}`)
  process.exit(falhas === 0 ? 0 : 1)
}

run()
