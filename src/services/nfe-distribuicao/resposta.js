// Parser puro (sem I/O, sem rede) da resposta do webservice nacional
// NFeDistribuicaoDFe (retDistDFeInt) — Fase B. Recebe o XML cru de resposta
// já obtido pela chamada SOAP (essa chamada em si ainda não está
// implementada — depende da renovação do certificado, ver
// Fase_B_Scoping.md) e devolve os documentos normalizados prontos pro job
// de sincronização decidir o que fazer com cada um.
//
// Estrutura confirmada via pesquisa (01/08/2026), NÃO assumida de memória:
// - retDistDFeInt: cStat, xMotivo, dhResp, ultNSU, maxNSU (fonte:
//   nfephp-org/sped-nfe, docs/metodos/DistDFe.md)
// - loteDistDFeInt/docZip: atributos NSU e schema (ex.: "resNFe_v1.01.xsd",
//   "resEvento_v1.01.xsd", "procNFe_v1.00.xsd", "procEventoNFe_v1.00.xsd") —
//   conteúdo em base64 + gzip do XML original (mesma fonte).
// - resNFe (resNFe_v1.00.xsd, nfephp-org/nfephp): chNFe, CNPJ|CPF, xNome,
//   IE, dhEmi, tpNF, vNF, digVal (opcional), dhRecbto, nProt, cSitNFe — nessa
//   ordem.
// - resEvento (resEvento_v1.01.xsd, frones/ACBr): cOrgao, CNPJ|CPF, chNFe,
//   dhEvento, tpEvento, nSeqEvento, xEvento, dhRecbto, nProt.
// - Códigos tpEvento de manifestação do destinatário (espiaonfe.com.br,
//   consistente com a NT 2020.001): 210200=Confirmação da Operação,
//   210210=Ciência da Operação, 210220=Desconhecimento da Operação,
//   210240=Operação não Realizada.
//
// cSitNFe (situação resumida da NF-e dentro do resNFe) NÃO teve seus valores
// numéricos confirmados por nenhuma fonte consultada — por isso este parser
// devolve o valor bruto sem tentar traduzir/rotular. Não decida nada
// (ex.: "está cancelada") só com base nisso sem confirmar o significado.

import { gunzipSync } from 'zlib'
import { parseStringPromise } from 'xml2js'

export const TIPOS_EVENTO_MANIFESTACAO = {
  210200: 'confirmacao_operacao',
  210210: 'ciencia_operacao',
  210220: 'desconhecimento_operacao',
  210240: 'operacao_nao_realizada',
}

function num(v) {
  if (v === undefined || v === null || v === '') return null
  return Number(v)
}

// Descompacta o conteúdo de um <docZip> — base64 do texto do elemento vem
// primeiro, depois gzip. Síncrono e puro: dado o mesmo base64, sempre
// devolve o mesmo XML.
export function decodificarDocZip(base64Gzip) {
  const comprimido = Buffer.from(String(base64Gzip || '').trim(), 'base64')
  return gunzipSync(comprimido).toString('utf8')
}

// resNFe — resumo de uma NF-e destinada à Vivenzza, ainda não teve o XML
// completo baixado. É o que aparece por padrão via distribuição; o
// download do XML completo (procNFe) é uma consulta separada por chave.
export async function parseResNFe(xmlString) {
  const doc = await parseStringPromise(xmlString, { explicitArray: false, mergeAttrs: true, trim: true })
  const r = doc.resNFe
  if (!r) throw new Error('XML não é um <resNFe> válido')

  return {
    tipo: 'resNFe',
    chave_acesso: r.chNFe || null,
    emitente: {
      cnpj: r.CNPJ || null,
      cpf: r.CPF || null,
      razao_social: r.xNome || null,
      ie: r.IE || null,
    },
    data_emissao: r.dhEmi || null,
    tipo_operacao: r.tpNF !== undefined ? Number(r.tpNF) : null,
    valor_nf: num(r.vNF),
    digest_valor: r.digVal || null,
    data_autorizacao: r.dhRecbto || null,
    protocolo: r.nProt || null,
    // Bruto — ver aviso no topo do arquivo sobre cSitNFe não ter valores confirmados.
    situacao_raw: r.cSitNFe ?? null,
  }
}

// resEvento — resumo de um evento de terceiros relacionado a uma NF-e da
// Vivenzza (ex.: cancelamento pelo emitente, carta de correção). Não é a
// manifestação da PRÓPRIA Vivenzza — é o que outros registraram.
export async function parseResEvento(xmlString) {
  const doc = await parseStringPromise(xmlString, { explicitArray: false, mergeAttrs: true, trim: true })
  const r = doc.resEvento
  if (!r) throw new Error('XML não é um <resEvento> válido')

  const tpEvento = r.tpEvento !== undefined ? Number(r.tpEvento) : null

  return {
    tipo: 'resEvento',
    chave_acesso: r.chNFe || null,
    autor: {
      cnpj: r.CNPJ || null,
      cpf: r.CPF || null,
    },
    orgao: r.cOrgao || null,
    tipo_evento: tpEvento,
    tipo_evento_manifestacao: tpEvento !== null ? (TIPOS_EVENTO_MANIFESTACAO[tpEvento] || null) : null,
    descricao_evento: r.xEvento || null,
    sequencia_evento: r.nSeqEvento !== undefined ? Number(r.nSeqEvento) : null,
    data_evento: r.dhEvento || null,
    data_registro: r.dhRecbto || null,
    protocolo: r.nProt || null,
  }
}

// Ponto de entrada principal: recebe o XML cru de <retDistDFeInt> (a
// resposta inteira da consulta) e devolve tudo já decodificado e
// classificado. Documentos com schema procNFe/procEventoNFe (XML completo,
// não resumo) são passados adiante como `nao_processado` — o job de
// sincronização decide se quer tratá-los ou ignorá-los; este parser não
// assume que Fase B já sabe lidar com eles.
export async function parseRetDistDFeInt(xmlString) {
  const doc = await parseStringPromise(xmlString, { explicitArray: false, mergeAttrs: true, trim: true })
  const r = doc.retDistDFeInt
  if (!r) throw new Error('XML não é um <retDistDFeInt> válido (resposta inesperada da SEFAZ)')

  const loteBruto = r.loteDistDFeInt?.docZip
  const docsZip = loteBruto === undefined ? [] : (Array.isArray(loteBruto) ? loteBruto : [loteBruto])

  const docs = []
  for (const docZip of docsZip) {
    const nsu = docZip.NSU || null
    const schema = docZip.schema || ''
    // xml2js com explicitArray:false coloca o texto do elemento em `_`
    // quando o elemento tem atributos (NSU, schema) além de conteúdo de texto.
    const conteudoBase64 = typeof docZip === 'string' ? docZip : docZip._
    const xmlDescompactado = decodificarDocZip(conteudoBase64)

    if (schema.startsWith('resNFe')) {
      docs.push({ nsu, schema, ...(await parseResNFe(xmlDescompactado)) })
    } else if (schema.startsWith('resEvento')) {
      docs.push({ nsu, schema, ...(await parseResEvento(xmlDescompactado)) })
    } else {
      // procNFe, procEventoNFe, ou schema desconhecido/futuro — não
      // interrompe o lote inteiro por um tipo ainda não suportado.
      docs.push({ nsu, schema, tipo: 'nao_processado', xml_completo: xmlDescompactado })
    }
  }

  return {
    ambiente: r.tpAmb === '1' ? 'producao' : 'homologacao',
    cstat: r.cStat || null,
    xmotivo: r.xMotivo || null,
    data_resposta: r.dhResp || null,
    ultNSU: r.ultNSU || null,
    maxNSU: r.maxNSU || null,
    docs,
  }
}
