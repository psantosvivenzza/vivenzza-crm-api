import { create } from 'xmlbuilder2'
import { EMITENTE, SEFAZ } from './emitente.js'
import { gerarChaveNFe } from './chave.js'

// Gera o XML da NFe 4.00 (sem assinatura — será assinado depois)
export function gerarXmlNFe(nfe) {
  const chave = nfe.chave || gerarChaveNFe({
    numero: nfe.numero,
    serie: nfe.serie,
    dataEmissao: nfe.data_emissao,
  })

  const dt = new Date(nfe.data_emissao)
  const dhEmi = dt.toISOString().replace(/\.\d{3}Z$/, '-03:00')
  const cDV = chave.slice(-1)
  const nNF = String(nfe.numero).padStart(9, '0')

  const doc = create({ version: '1.0', encoding: 'UTF-8' })

  const nfeEl = doc.ele('nfeProc', {
    xmlns: 'http://www.portalfiscal.inf.br/nfe',
    versao: '4.00',
  })

  const nfeNode = nfeEl.ele('NFe', {
    xmlns: 'http://www.portalfiscal.inf.br/nfe',
  })

  const infNFe = nfeNode.ele('infNFe', {
    versao: '4.00',
    Id: `NFe${chave}`,
  })

  // ── ide ────────────────────────────────────────────────────────────────
  const ide = infNFe.ele('ide')
  ide.ele('cUF').txt(String(SEFAZ.cUF))
  ide.ele('cNF').txt(chave.slice(35, 43))
  ide.ele('natOp').txt(nfe.natureza_operacao || 'VENDA DE MERCADORIA')
  ide.ele('mod').txt('55')
  ide.ele('serie').txt(String(nfe.serie))
  ide.ele('nNF').txt(nNF)
  ide.ele('dhEmi').txt(dhEmi)
  ide.ele('tpNF').txt('1')        // 0=entrada, 1=saída
  ide.ele('idDest').txt('1')      // 1=operação interna, 2=interestadual, 3=exterior
  ide.ele('cMunFG').txt(EMITENTE.cMun)
  ide.ele('tpImp').txt('1')       // 1=DANFE retrato, 4=DANFE NFC-e
  ide.ele('tpEmis').txt('1')      // 1=emissão normal
  ide.ele('cDV').txt(cDV)
  ide.ele('tpAmb').txt(SEFAZ.tpAmb)
  ide.ele('finNFe').txt(String(nfe.finalidade || 1))
  ide.ele('indFinal').txt('1')    // 1=consumidor final
  ide.ele('indPres').txt('1')     // 1=operação presencial
  ide.ele('procEmi').txt('0')     // 0=emissão de NF-e com aplicativo próprio
  ide.ele('verProc').txt('1.0.0')

  // ── emit ───────────────────────────────────────────────────────────────
  const emit = infNFe.ele('emit')
  emit.ele('CNPJ').txt(EMITENTE.CNPJ)
  emit.ele('xNome').txt(EMITENTE.xNome)
  if (EMITENTE.xFant) emit.ele('xFant').txt(EMITENTE.xFant)
  const endEmit = emit.ele('enderEmit')
  endEmit.ele('xLgr').txt(EMITENTE.xLgr || 'RUA NAO INFORMADA')
  endEmit.ele('nro').txt(EMITENTE.nro || 'SN')
  endEmit.ele('xBairro').txt(EMITENTE.xBairro || 'CENTRO')
  endEmit.ele('cMun').txt(EMITENTE.cMun)
  endEmit.ele('xMun').txt(EMITENTE.xMun)
  endEmit.ele('UF').txt(EMITENTE.UF)
  endEmit.ele('CEP').txt((EMITENTE.CEP || '00000000').replace(/\D/g, ''))
  endEmit.ele('cPais').txt('1058')
  endEmit.ele('xPais').txt('BRASIL')
  if (EMITENTE.fone) endEmit.ele('fone').txt(EMITENTE.fone.replace(/\D/g, ''))
  emit.ele('IE').txt(EMITENTE.IE || 'ISENTO')
  emit.ele('CRT').txt(EMITENTE.CRT)

  // ── dest ───────────────────────────────────────────────────────────────
  const dest = infNFe.ele('dest')
  const docDest = (nfe.dest_cnpj_cpf || '').replace(/\D/g, '')
  if (docDest.length === 14) {
    dest.ele('CNPJ').txt(docDest)
  } else if (docDest.length === 11) {
    dest.ele('CPF').txt(docDest)
  } else {
    // Consumidor sem identificação (NFC-e)
    dest.ele('CPF').txt('00000000000')
  }
  dest.ele('xNome').txt(nfe.dest_nome || 'CONSUMIDOR NAO IDENTIFICADO')
  if (SEFAZ.tpAmb === '1' && (nfe.dest_logradouro || nfe.dest_municipio)) {
    // cMun é obrigatório e não tem valor "aproximado" seguro — se não foi resolvido
    // na criação da NFe (ver POST /api/nfe em routes/nfe.js), falha aqui em vez de
    // emitir com o município errado.
    if (!nfe.dest_cmun) {
      throw new Error(`cMun do destinatário não resolvido para "${nfe.dest_municipio}/${nfe.dest_uf}" — corrija o município da NFe antes de emitir`)
    }
    const endDest = dest.ele('enderDest')
    endDest.ele('xLgr').txt(nfe.dest_logradouro || 'NAO INFORMADO')
    endDest.ele('nro').txt(nfe.dest_numero || 'SN')
    endDest.ele('xBairro').txt(nfe.dest_bairro || 'NAO INFORMADO')
    endDest.ele('cMun').txt(nfe.dest_cmun)
    endDest.ele('xMun').txt(nfe.dest_municipio || 'NAO INFORMADO')
    endDest.ele('UF').txt(nfe.dest_uf || 'RS')
    endDest.ele('CEP').txt((nfe.dest_cep || '00000000').replace(/\D/g, ''))
    endDest.ele('cPais').txt('1058')
    endDest.ele('xPais').txt('BRASIL')
    if (nfe.dest_fone) endDest.ele('fone').txt(nfe.dest_fone.replace(/\D/g, ''))
  }
  dest.ele('indIEDest').txt('9') // 9=não contribuinte
  if (nfe.dest_email) dest.ele('email').txt(nfe.dest_email)

  // ── det (itens) ─────────────────────────────────────────────────────────
  const itens = nfe.nfe_itens || []
  itens.forEach((item, idx) => {
    const det = infNFe.ele('det', { nItem: String(idx + 1) })
    const prod = det.ele('prod')
    prod.ele('cProd').txt(item.codigo || String(idx + 1).padStart(6, '0'))
    prod.ele('cEAN').txt('SEM GTIN')
    prod.ele('xProd').txt(item.descricao.slice(0, 120))
    prod.ele('NCM').txt((item.ncm || '00000000').padStart(8, '0'))
    prod.ele('CFOP').txt(item.cfop || '5102')
    prod.ele('uCom').txt(item.unidade || 'UN')
    prod.ele('qCom').txt(Number(item.quantidade).toFixed(4))
    prod.ele('vUnCom').txt(Number(item.valor_unitario).toFixed(4))
    prod.ele('vProd').txt(Number(item.valor_total).toFixed(2))
    prod.ele('cEANTrib').txt('SEM GTIN')
    prod.ele('uTrib').txt(item.unidade || 'UN')
    prod.ele('qTrib').txt(Number(item.quantidade).toFixed(4))
    prod.ele('vUnTrib').txt(Number(item.valor_unitario).toFixed(4))
    prod.ele('indTot').txt('1')

    // ICMS
    const imposto = det.ele('imposto')
    const icms = imposto.ele('ICMS')
    const cst = item.cst_icms || '00'
    let icmsTag
    if (EMITENTE.CRT === '1') {
      // Simples Nacional
      icmsTag = icms.ele('ICMSSN102')
      icmsTag.ele('orig').txt('0')
      icmsTag.ele('CSOSN').txt('102')
    } else {
      icmsTag = icms.ele('ICMS00')
      icmsTag.ele('orig').txt('0')
      icmsTag.ele('CST').txt(cst)
      icmsTag.ele('modBC').txt('3')
      icmsTag.ele('vBC').txt(Number(item.valor_total).toFixed(2))
      icmsTag.ele('pICMS').txt(Number(item.aliq_icms || 0).toFixed(2))
      icmsTag.ele('vICMS').txt(Number(item.valor_icms || 0).toFixed(2))
    }

    // PIS
    const pis = imposto.ele('PIS')
    const cstPis = item.cst_pis || '07'
    if (cstPis === '07' || cstPis === '08' || cstPis === '09') {
      pis.ele('PISOutr').ele('CST').txt(cstPis).up()
        .ele('vBC').txt('0.00').up()
        .ele('pPIS').txt('0.00').up()
        .ele('vPIS').txt('0.00')
    } else {
      pis.ele('PISAliq').ele('CST').txt(cstPis).up()
        .ele('vBC').txt(Number(item.valor_total).toFixed(2)).up()
        .ele('pPIS').txt('0.00').up()
        .ele('vPIS').txt('0.00')
    }

    // COFINS
    const cofins = imposto.ele('COFINS')
    const cstCofins = item.cst_cofins || '07'
    if (cstCofins === '07' || cstCofins === '08' || cstCofins === '09') {
      cofins.ele('COFINSOutr').ele('CST').txt(cstCofins).up()
        .ele('vBC').txt('0.00').up()
        .ele('pCOFINS').txt('0.00').up()
        .ele('vCOFINS').txt('0.00')
    } else {
      cofins.ele('COFINSAliq').ele('CST').txt(cstCofins).up()
        .ele('vBC').txt(Number(item.valor_total).toFixed(2)).up()
        .ele('pCOFINS').txt('0.00').up()
        .ele('vCOFINS').txt('0.00')
    }
  })

  // ── total ──────────────────────────────────────────────────────────────
  const total = infNFe.ele('total')
  const icmsTot = total.ele('ICMSTot')
  icmsTot.ele('vBC').txt(Number(nfe.valor_produtos || 0).toFixed(2))
  icmsTot.ele('vICMS').txt(Number(nfe.valor_icms || 0).toFixed(2))
  icmsTot.ele('vICMSDeson').txt('0.00')
  icmsTot.ele('vFCPUFDest').txt('0.00')
  icmsTot.ele('vICMSUFDest').txt('0.00')
  icmsTot.ele('vICMSUFRemet').txt('0.00')
  icmsTot.ele('vFCP').txt('0.00')
  icmsTot.ele('vBCST').txt('0.00')
  icmsTot.ele('vST').txt('0.00')
  icmsTot.ele('vFCPST').txt('0.00')
  icmsTot.ele('vFCPSTRet').txt('0.00')
  icmsTot.ele('vProd').txt(Number(nfe.valor_produtos || 0).toFixed(2))
  icmsTot.ele('vFrete').txt(Number(nfe.valor_frete || 0).toFixed(2))
  icmsTot.ele('vSeg').txt('0.00')
  icmsTot.ele('vDesc').txt(Number(nfe.valor_desconto || 0).toFixed(2))
  icmsTot.ele('vII').txt('0.00')
  icmsTot.ele('vIPI').txt('0.00')
  icmsTot.ele('vIPIDevol').txt('0.00')
  icmsTot.ele('vPIS').txt(Number(nfe.valor_pis || 0).toFixed(2))
  icmsTot.ele('vCOFINS').txt(Number(nfe.valor_cofins || 0).toFixed(2))
  icmsTot.ele('vOutro').txt('0.00')
  icmsTot.ele('vNF').txt(Number(nfe.valor_total || 0).toFixed(2))

  // ── transp ─────────────────────────────────────────────────────────────
  const transp = infNFe.ele('transp')
  transp.ele('modFrete').txt(String(nfe.transp_modalidade || 9))

  // ── pag ───────────────────────────────────────────────────────────────
  const pag = infNFe.ele('pag')
  const detPag = pag.ele('detPag')
  detPag.ele('tPag').txt(nfe.forma_pagamento || '01')
  detPag.ele('vPag').txt(Number(nfe.valor_total || 0).toFixed(2))

  // ── infAdic ───────────────────────────────────────────────────────────
  if (nfe.observacoes) {
    const infAdic = infNFe.ele('infAdic')
    infAdic.ele('infCpl').txt(nfe.observacoes.slice(0, 5000))
  }

  // Retorna o XML sem a tag nfeProc (que é adicionada após autorização)
  // Para envio à SEFAZ, precisamos do XML do nfeNode sem o wrapper nfeProc
  const xmlCompleto = doc.end({ prettyPrint: false })

  // Extrai apenas a NFe (sem nfeProc)
  const nfeXml = nfeNode.end({ prettyPrint: false })

  return { chave, xml: nfeXml, xmlCompleto }
}
