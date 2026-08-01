// Teste unitário do validador de entrada de NF-e (src/services/nfe-entrada/validacao.js) —
// puro, sem I/O, sem rede. Persiste os 6 cenários negativos + o caso positivo
// que já foram validados manualmente durante a implementação da Fase A, pra
// virarem regressão automática.
//
// Roda com: node scripts/teste-nfe-entrada-validacao.mjs

import { validarChaveAcesso, validarEstruturaEntrada } from '../src/services/nfe-entrada/validacao.js'

let falhas = 0
function check(nome, cond, detalhe) {
  if (cond) console.log(`OK — ${nome}`)
  else { falhas++; console.log(`FALHOU — ${nome}${detalhe ? ' — ' + detalhe : ''}`) }
}

const CNPJ_VIVENZZA = '13602526000193'
const CNPJ_FORNECEDOR_TESTE = '55666777000181' // DV calculado de verdade, mesma raiz do teste do parser
const CHAVE_VALIDA = '43260755666777000181550010000001231123456788'
const CHAVE_DV_ADULTERADO = '43260755666777000181550010000001231123456789'

// --- validarChaveAcesso (algoritmo módulo 11) ---
check('chave de acesso válida (DV correto) valida true', validarChaveAcesso(CHAVE_VALIDA) === true)
check('chave com DV adulterado valida false', validarChaveAcesso(CHAVE_DV_ADULTERADO) === false)
check('chave com tamanho errado (43 dígitos) valida false', validarChaveAcesso(CHAVE_VALIDA.slice(0, 43)) === false)
check('chave com caractere não numérico valida false', validarChaveAcesso(CHAVE_VALIDA.slice(0, 43) + 'A') === false)
check('chave vazia/nula valida false', validarChaveAcesso('') === false && validarChaveAcesso(null) === false)

// --- validarEstruturaEntrada — builder de um NFeParsed base válido ---
function nfeParsedValido(overrides = {}) {
  return {
    chave_acesso: CHAVE_VALIDA,
    protocolo_autorizacao: '143260000123456',
    protocolo_cstat: '100',
    protocolo_motivo: 'Autorizado o uso da NF-e',
    destinatario_cnpj: CNPJ_VIVENZZA,
    fornecedor: { cnpj: CNPJ_FORNECEDOR_TESTE, razao_social: 'FORNECEDOR TESTE LTDA' },
    itens: [{ numero_item: 1, valor_total_item: 500 }],
    valores: { valor_total: 525 },
    ...overrides,
  }
}

// Caso positivo — nota estruturalmente correta deve passar sem erros
{
  const r = validarEstruturaEntrada(nfeParsedValido(), CNPJ_VIVENZZA)
  check('nota bem formada e destinada à Vivenzza é válida (sem erros)', r.valido === true && r.erros.length === 0)
}

// Cenário negativo 1 — chave de acesso adulterada
{
  const r = validarEstruturaEntrada(nfeParsedValido({ chave_acesso: CHAVE_DV_ADULTERADO }), CNPJ_VIVENZZA)
  check('chave adulterada bloqueia importação', r.valido === false && r.erros.some(e => /dígito verificador/i.test(e)))
}

// Cenário negativo 2 — sem protocolo de autorização (XML de distribuição/rascunho, não autorizado)
{
  const r = validarEstruturaEntrada(nfeParsedValido({ protocolo_autorizacao: null }), CNPJ_VIVENZZA)
  check('XML sem protocolo de autorização bloqueia importação', r.valido === false && r.erros.some(e => /protocolo de autorização/i.test(e)))
}

// Cenário negativo 3 — protocolo de nota cancelada/denegada (cStat != 100)
{
  const r = validarEstruturaEntrada(nfeParsedValido({ protocolo_cstat: '101', protocolo_motivo: 'Cancelamento de NF-e homologado' }), CNPJ_VIVENZZA)
  check('protocolo com cStat de cancelamento (101) bloqueia importação', r.valido === false && r.erros.some(e => /esperado 100/i.test(e)))
}

// Cenário negativo 4 — destinatário do XML não é a Vivenzza (nota de outra empresa)
{
  const r = validarEstruturaEntrada(nfeParsedValido({ destinatario_cnpj: '11222333000181' }), CNPJ_VIVENZZA)
  check('destinatário diferente da Vivenzza bloqueia importação', r.valido === false && r.erros.some(e => /não é a Vivenzza/i.test(e)))
}

// Cenário negativo 5 — CNPJ do fornecedor/emitente inválido (DV errado)
{
  const r = validarEstruturaEntrada(nfeParsedValido({ fornecedor: { cnpj: '55666777000180', razao_social: 'X' } }), CNPJ_VIVENZZA)
  check('CNPJ de fornecedor com DV inválido bloqueia importação', r.valido === false && r.erros.some(e => /CNPJ do fornecedor/i.test(e)))
}

// Cenário negativo 6 — XML sem nenhum item
{
  const r = validarEstruturaEntrada(nfeParsedValido({ itens: [] }), CNPJ_VIVENZZA)
  check('XML sem itens bloqueia importação', r.valido === false && r.erros.some(e => /nenhum item/i.test(e)))
}

// Cenário negativo 7 — valor total ausente ou zerado
{
  const r = validarEstruturaEntrada(nfeParsedValido({ valores: { valor_total: 0 } }), CNPJ_VIVENZZA)
  check('valor total zerado bloqueia importação', r.valido === false && r.erros.some(e => /valor total/i.test(e)))
}

// Cenário negativo 8 — múltiplos erros simultâneos acumulam todos, não só o primeiro
{
  const r = validarEstruturaEntrada(nfeParsedValido({ protocolo_autorizacao: null, itens: [], valores: { valor_total: 0 } }), CNPJ_VIVENZZA)
  check('múltiplos problemas acumulam todos os erros (não para no primeiro)', r.valido === false && r.erros.length >= 3)
}

console.log(`\n${falhas === 0 ? 'TODOS OS TESTES PASSARAM' : `${falhas} TESTE(S) FALHARAM`}`)
process.exit(falhas === 0 ? 0 : 1)
