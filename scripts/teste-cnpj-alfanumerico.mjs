// Teste unitário do validador de CNPJ alfanumérico (src/lib/cnpj.js, Nota
// Técnica 2025.002) — puro, sem I/O. Persiste as verificações já feitas
// manualmente durante a implementação, pra virarem regressão automática.
import { validarCnpj, validarCpf, validarDocumento, normalizarCnpj } from '../src/lib/cnpj.js'

let falhas = 0
function check(nome, cond, detalhe) {
  if (cond) console.log(`OK — ${nome}`)
  else { falhas++; console.log(`FALHOU — ${nome}${detalhe ? ' — ' + detalhe : ''}`) }
}

// CNPJ real da Vivenzza — puramente numérico, precisa continuar validando
// depois da mudança pro algoritmo alfanumérico (retrocompatibilidade).
check('CNPJ real da Vivenzza (13602526000193) valida true', validarCnpj('13602526000193') === true)
check('mesmo CNPJ com máscara (13.602.526/0001-93) valida true', validarCnpj('13.602.526/0001-93') === true)
check('CNPJ com dígito verificador errado (13602526000194) valida false', validarCnpj('13602526000194') === false)
check('CNPJ com todos os caracteres iguais (11111111111111) valida false', validarCnpj('11111111111111') === false)
check('CNPJ com tamanho errado valida false', validarCnpj('1234') === false)

// Formato alfanumérico (Nota Técnica 2025.002) — raiz com letras, DVs continuam
// numéricos. Gera um CNPJ alfanumérico válido calculando os DVs de verdade,
// em vez de supor um valor de exemplo pronto (a instrução do usuário foi "não
// inventar" — aqui o dígito é derivado pelo mesmo algoritmo do módulo, não fixado).
function gerarCnpjAlfanumericoValido(raiz12) {
  const PESOS_DV1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
  const PESOS_DV2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
  const valor = c => c.charCodeAt(0) - 48
  const digito = (base, pesos) => {
    const soma = base.split('').reduce((acc, c, i) => acc + valor(c) * pesos[i], 0)
    const resto = soma % 11
    return resto < 2 ? 0 : 11 - resto
  }
  const dv1 = digito(raiz12, PESOS_DV1)
  const dv2 = digito(raiz12 + String(dv1), PESOS_DV2)
  return `${raiz12}${dv1}${dv2}`
}

const cnpjAlfaValido = gerarCnpjAlfanumericoValido('12ABC34501DE')
check(
  `CNPJ alfanumérico gerado (${cnpjAlfaValido}) valida true`,
  validarCnpj(cnpjAlfaValido) === true,
)
const cnpjAlfaInvalido = cnpjAlfaValido.slice(0, 12) + '00'
check(
  `mesmo CNPJ alfanumérico com DV zerado (${cnpjAlfaInvalido}) valida false`,
  cnpjAlfaInvalido !== cnpjAlfaValido && validarCnpj(cnpjAlfaInvalido) === false,
)
check(
  'CNPJ alfanumérico com letra minúscula normaliza e valida igual ao maiúsculo',
  validarCnpj(cnpjAlfaValido.toLowerCase()) === validarCnpj(cnpjAlfaValido),
)
check(
  'dígitos verificadores continuam OBRIGATORIAMENTE numéricos mesmo no formato alfanumérico',
  validarCnpj('12ABC34501DEAB') === false,
)

// CPF clássico — sem mudança de formato, continua puramente numérico.
check('CPF válido (111.444.777-35) valida true', validarCpf('111.444.777-35') === true)
check('CPF com dígito trocado (111.444.777-36) valida false', validarCpf('111.444.777-36') === false)
check('CPF com todos os dígitos iguais (00000000000) valida false', validarCpf('00000000000') === false)

// validarDocumento decide CNPJ (14) vs CPF (11) só pelo tamanho — nunca por
// conteúdo, porque o CNPJ agora pode ter letra.
check('validarDocumento aceita CNPJ alfanumérico válido', validarDocumento(cnpjAlfaValido) === true)
check('validarDocumento aceita CPF válido', validarDocumento('111.444.777-35') === true)
check('validarDocumento rejeita tamanho que não é 11 nem 14', validarDocumento('123') === false)

check('normalizarCnpj remove máscara e força maiúscula', normalizarCnpj('12.abc.345/01de-93') === '12ABC34501DE93')

console.log(`\n${falhas === 0 ? 'TODOS OS TESTES PASSARAM' : `${falhas} TESTE(S) FALHARAM`}`)
process.exit(falhas === 0 ? 0 : 1)
