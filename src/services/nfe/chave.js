import { EMITENTE, SEFAZ } from './emitente.js'

// Gera a chave de acesso da NFe (44 dígitos)
export function gerarChaveNFe({ numero, serie, dataEmissao, tpEmis = 1 }) {
  const cUF = String(SEFAZ.cUF).padStart(2, '0')
  const dt = new Date(dataEmissao)
  const aamm = String(dt.getFullYear()).slice(2) + String(dt.getMonth() + 1).padStart(2, '0')
  const cnpj = EMITENTE.CNPJ.padStart(14, '0')
  const mod = '55' // NFe
  const ser = String(serie).padStart(3, '0')
  const nNF = String(numero).padStart(9, '0')
  const tpEmisStr = String(tpEmis)
  const cNF = String(Math.floor(Math.random() * 99999999)).padStart(8, '0')

  const chaveSemDV = cUF + aamm + cnpj + mod + ser + nNF + tpEmisStr + cNF
  const cDV = calcDV(chaveSemDV)

  return chaveSemDV + cDV
}

function calcDV(chave) {
  const pesos = [2, 3, 4, 5, 6, 7, 8, 9]
  let soma = 0
  let j = 0
  for (let i = chave.length - 1; i >= 0; i--) {
    soma += parseInt(chave[i]) * pesos[j % 8]
    j++
  }
  const resto = soma % 11
  return resto < 2 ? '0' : String(11 - resto)
}
