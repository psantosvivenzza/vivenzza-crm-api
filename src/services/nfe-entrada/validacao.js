import { validarCnpj, normalizarCnpj } from '../../lib/cnpj.js'

// Valida o dígito verificador (44ª posição) da chave de acesso da NF-e —
// algoritmo módulo 11, pesos 2..9 repetindo da direita pra esquerda sobre os
// 43 primeiros dígitos. Independe do formato alfanumérico do CNPJ (a chave de
// acesso em si é sempre 44 dígitos numéricos).
export function validarChaveAcesso(chave) {
  if (!/^\d{44}$/.test(String(chave || ''))) return false
  const base = chave.slice(0, 43)
  const dvInformado = Number(chave[43])

  let peso = 2
  let soma = 0
  for (let i = base.length - 1; i >= 0; i--) {
    soma += Number(base[i]) * peso
    peso = peso === 9 ? 2 : peso + 1
  }
  const resto = soma % 11
  const dvCalculado = resto < 2 ? 0 : 11 - resto
  return dvCalculado === dvInformado
}

// Validação estrutural do XML pro fluxo de ENTRADA. Isto NÃO é uma validação
// XSD oficial completa (não temos os schemas .xsd da SEFAZ embarcados no
// projeto) — é uma verificação rigorosa dos campos que o fluxo de entrada
// realmente precisa pra não deixar confirmar uma nota com dado faltando,
// destinatário errado, ou protocolo ausente/cancelado.
//
// PENDÊNCIA PARA O CONTADOR: antes de considerar o processo 100% blindado
// fiscalmente, rodar o XML por um validador XSD oficial (ex: o validador do
// próprio portal da NF-e ou uma lib como node-nfe-validator) — isso aqui
// cobre a lógica de negócio, não a conformidade XSD byte a byte.
export function validarEstruturaEntrada(nfeParsed, cnpjEmitentePropio) {
  const erros = []

  if (!nfeParsed.chave_acesso) {
    erros.push('XML sem chave de acesso (atributo Id do <infNFe>)')
  } else if (!validarChaveAcesso(nfeParsed.chave_acesso)) {
    erros.push('Dígito verificador da chave de acesso é inválido — XML pode estar corrompido ou adulterado')
  }

  if (!nfeParsed.protocolo_autorizacao) {
    erros.push('XML sem protocolo de autorização (<protNFe><infProt><nProt>) — isto não é uma nota autorizada pela SEFAZ, é só o XML de distribuição/rascunho')
  }

  if (nfeParsed.protocolo_cstat && String(nfeParsed.protocolo_cstat) !== '100') {
    erros.push(`Protocolo com status ${nfeParsed.protocolo_cstat} (${nfeParsed.protocolo_motivo || 'sem motivo informado'}) — esperado 100/Autorizado. Confira se a nota não foi cancelada, denegada ou inutilizada antes de importar.`)
  }

  const destCnpj = normalizarCnpj(nfeParsed.destinatario_cnpj)
  const nossoCnpj = normalizarCnpj(cnpjEmitentePropio)
  if (!destCnpj) {
    erros.push('XML sem CNPJ/CPF de destinatário')
  } else if (destCnpj !== nossoCnpj) {
    erros.push(`O destinatário do XML (CNPJ/CPF ${nfeParsed.destinatario_cnpj}) não é a Vivenzza (CNPJ ${cnpjEmitentePropio}) — essa nota não é uma entrada nossa e não deve ser importada aqui`)
  }

  if (!nfeParsed.fornecedor.cnpj) {
    erros.push('XML sem CNPJ do emitente/fornecedor')
  } else if (!validarCnpj(nfeParsed.fornecedor.cnpj)) {
    erros.push(`CNPJ do fornecedor/emitente é inválido: ${nfeParsed.fornecedor.cnpj}`)
  }

  if (!nfeParsed.itens || nfeParsed.itens.length === 0) {
    erros.push('XML sem nenhum item de produto (<det>)')
  }

  if (!nfeParsed.valores.valor_total || nfeParsed.valores.valor_total <= 0) {
    erros.push('XML sem valor total da nota (<vNF>) ou valor zerado')
  }

  return { valido: erros.length === 0, erros }
}
