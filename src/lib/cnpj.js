// Validação de CNPJ compatível com o formato alfanumérico (Nota Técnica
// 2025.002 da Receita Federal — raiz do CNPJ passa a aceitar letras a partir
// de 2026, os 2 dígitos verificadores continuam numéricos). Não usar regex
// só-numérica nem `parseInt`/tipo numérico — precisa aceitar letra em
// qualquer uma das 12 primeiras posições.
//
// Algoritmo oficial: cada caractere alfanumérico (posições 1-12, e os dígitos
// verificadores no cálculo) é convertido pro valor numérico = código ASCII -
// 48 (então '0'-'9' → 0-9, 'A'-'Z' → 17-42). Os 2 dígitos verificadores em si
// continuam sempre 0-9.
const PESOS_DV1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
const PESOS_DV2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]

function valorCaractere(c) {
  return c.charCodeAt(0) - 48
}

function calcularDigito(base, pesos) {
  const soma = base.split('').reduce((acc, c, i) => acc + valorCaractere(c) * pesos[i], 0)
  const resto = soma % 11
  return resto < 2 ? 0 : 11 - resto
}

// Remove tudo que não for dígito ou letra maiúscula (máscara, espaços, minúsculas).
export function normalizarCnpj(valor) {
  return String(valor || '').toUpperCase().replace(/[^0-9A-Z]/g, '')
}

// Retorna true/false — não lança. `valor` pode ter máscara (a função normaliza).
export function validarCnpj(valor) {
  const cnpj = normalizarCnpj(valor)
  if (cnpj.length !== 14) return false
  // Os 2 dígitos verificadores são sempre numéricos, mesmo no formato alfanumérico.
  if (!/^[0-9]{2}$/.test(cnpj.slice(12))) return false
  // Rejeita sequência de um caractere só repetido (ex: 00000000000000) — mesma
  // heurística usada no CNPJ numérico clássico, adaptada pro alfanumérico.
  if (/^(.)\1{13}$/.test(cnpj)) return false

  const doze = cnpj.slice(0, 12)
  const dv1 = calcularDigito(doze, PESOS_DV1)
  const dv2 = calcularDigito(doze + String(dv1), PESOS_DV2)
  return cnpj === `${doze}${dv1}${dv2}`
}

// CPF continua puramente numérico — sem mudança do formato alfanumérico
// (que é só pra CNPJ). Aceito aqui porque nfe.dest_cnpj_cpf/clientes_erp.cnpj_cpf
// guardam os dois tipos de documento na mesma coluna.
export function validarCpf(valor) {
  const cpf = String(valor || '').replace(/\D/g, '')
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false
  const calc = (tamanho) => {
    let soma = 0
    for (let i = 0; i < tamanho; i++) soma += Number(cpf[i]) * (tamanho + 1 - i)
    const resto = (soma * 10) % 11
    return resto === 10 ? 0 : resto
  }
  return calc(9) === Number(cpf[9]) && calc(10) === Number(cpf[10])
}

// Documento pode ser CNPJ (14) ou CPF (11) — decide pelo tamanho, não por
// heurística de conteúdo.
export function validarDocumento(valor) {
  const normalizado = normalizarCnpj(valor)
  if (normalizado.length === 14) return validarCnpj(normalizado)
  if (normalizado.replace(/[^0-9]/g, '').length === 11) return validarCpf(valor)
  return false
}
