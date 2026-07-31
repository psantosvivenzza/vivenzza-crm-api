import { parseStringPromise } from 'xml2js'
import { createHash } from 'crypto'

export function sha256(texto) {
  return createHash('sha256').update(texto, 'utf8').digest('hex')
}

function num(v) {
  if (v === undefined || v === null || v === '') return 0
  return Number(v)
}

function arr(v) {
  if (v === undefined || v === null) return []
  return Array.isArray(v) ? v : [v]
}

// Recebe o XML cru (string) de uma NF-e recebida de um fornecedor (entrada) —
// aceita tanto <nfeProc> (NFe + protocolo, o formato normal de um XML
// autorizado) quanto um <NFe> solto (sem protocolo, o que a validação
// abaixo vai reprovar por não ter <nProt>). Devolve um objeto normalizado
// com tudo que o fluxo de entrada precisa. Lança erro descritivo — quem usa
// isso precisa saber EXATAMENTE o que falta no XML antes de seguir.
export async function parseNFeXml(xmlString) {
  let doc
  try {
    doc = await parseStringPromise(xmlString, { explicitArray: false, mergeAttrs: true, trim: true })
  } catch (err) {
    throw new Error(`XML mal formado — não foi possível fazer o parse: ${err.message}`)
  }

  const nfeProc = doc.nfeProc
  const nfe = nfeProc ? nfeProc.NFe : doc.NFe
  if (!nfe || !nfe.infNFe) {
    throw new Error('XML não é uma NF-e válida (elemento <NFe><infNFe> não encontrado)')
  }

  const infNFe = nfe.infNFe
  const chave = String(infNFe.Id || '').replace(/^NFe/, '').trim()

  const protNFe = nfeProc ? nfeProc.protNFe : null
  const infProt = protNFe ? protNFe.infProt : null
  const protocolo = infProt ? infProt.nProt : null
  const cStatProtocolo = infProt ? infProt.cStat : null
  const xMotivoProtocolo = infProt ? infProt.xMotivo : null
  // tpAmb (1=produção, 2=homologação) não está codificado na chave de acesso
  // (os dígitos ali são cUF+AAMM+CNPJ+mod+serie+nNF+tpEmis+cNF+cDV) — vem do
  // protocolo (prioridade) ou do próprio <ide> como fallback.
  const tpAmb = infProt?.tpAmb || infNFe.ide?.tpAmb || null

  const ide = infNFe.ide || {}
  const emit = infNFe.emit || {}
  const dest = infNFe.dest || {}
  const total = (infNFe.total && infNFe.total.ICMSTot) || {}
  const cobr = infNFe.cobr || {}

  const detItens = arr(infNFe.det)
  if (detItens.length === 0) {
    throw new Error('XML não possui nenhum item (<det>)')
  }

  const itens = detItens.map((d) => {
    const prod = d.prod || {}
    const imposto = d.imposto || {}
    const icmsGrupo = imposto.ICMS ? Object.values(imposto.ICMS)[0] : {}
    const ipiGrupo = (imposto.IPI && imposto.IPI.IPITrib) || {}
    const pisGrupo = (imposto.PIS && (imposto.PIS.PISAliq || imposto.PIS.PISNT || imposto.PIS.PISOutr)) || {}
    const cofinsGrupo = (imposto.COFINS && (imposto.COFINS.COFINSAliq || imposto.COFINS.COFINSNT || imposto.COFINS.COFINSOutr)) || {}

    return {
      numero_item: Number(d.nItem),
      codigo_fornecedor: prod.cProd || null,
      descricao_fornecedor: prod.xProd || null,
      ncm: prod.NCM || null,
      cfop: prod.CFOP || null,
      gtin: prod.cEAN && prod.cEAN !== 'SEM GTIN' ? prod.cEAN : null,
      unidade_fornecedor: prod.uCom || null,
      quantidade_fornecedor: num(prod.qCom),
      valor_unitario_fornecedor: num(prod.vUnCom),
      valor_total_item: num(prod.vProd),
      valor_icms: num(icmsGrupo?.vICMS),
      valor_ipi: num(ipiGrupo?.vIPI),
      valor_pis: num(pisGrupo?.vPIS),
      valor_cofins: num(cofinsGrupo?.vCOFINS),
      valor_desconto_item: num(prod.vDesc),
    }
  })

  const duplicatas = arr(cobr.dup).map((d) => ({
    numero: d.nDup || null,
    vencimento: d.dVenc || null,
    valor: num(d.vDup),
  }))

  return {
    chave_acesso: chave,
    protocolo_autorizacao: protocolo,
    protocolo_cstat: cStatProtocolo,
    protocolo_motivo: xMotivoProtocolo,
    ambiente: tpAmb === '1' ? 'producao' : 'homologacao',
    numero: ide.nNF ? Number(ide.nNF) : null,
    serie: ide.serie ? Number(ide.serie) : null,
    natureza_operacao: ide.natOp || null,
    data_emissao: ide.dhEmi || ide.dEmi || null,
    tipo_operacao: ide.tpNF,
    fornecedor: {
      cnpj: (emit.CNPJ || emit.CPF || '').trim(),
      razao_social: emit.xNome || null,
      nome_fantasia: emit.xFant || emit.xNome || null,
      ie: emit.IE || null,
      endereco: emit.enderEmit || {},
    },
    destinatario_cnpj: (dest.CNPJ || dest.CPF || '').trim(),
    valores: {
      valor_produtos: num(total.vProd),
      valor_frete: num(total.vFrete),
      valor_seguro: num(total.vSeg),
      valor_desconto: num(total.vDesc),
      valor_outras_despesas: num(total.vOutro),
      valor_ipi: num(total.vIPI),
      valor_icms: num(total.vICMS),
      valor_total: num(total.vNF),
    },
    duplicatas,
    itens,
    xml_completo: xmlString,
  }
}
