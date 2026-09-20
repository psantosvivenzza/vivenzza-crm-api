// ValorPago + ValorParcialmentePago sao COMPLEMENTARES nesta instalacao do
// NetVision. Enquanto ValorParcialmentePago era so um fallback na lista de
// candidatos, ele nunca era lido - e o CRM cobrava R$ 3.533,88 a mais, em
// titulos abertos, de gente que ja tinha pago parte.
//
// Estes testes travam as duas metades: somar de verdade, e nao confundir
// "pagou zero" com "o ERP nao informou valor".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  detectarColunas, normalizarLinhaLegado, calcularValorPagoLegado, somaValoresPagos,
} from '../../src/lib/financeiroLegado.js'

// Colunas reais desta instalacao, na ordem em que o information_schema devolve.
const COLUNAS_VIVENZZA = [
  'NumeroTitulo', 'Sequencia', 'CodigoCliente', 'ValorDuplicata', 'ValorPago',
  'ValorParcialmentePago', 'DataVencimento', 'DataPagamento', 'DuplicataAberta',
  'DataCancelamento', 'DataAtualizacao',
]

test('as duas colunas de valor pago sao detectadas, cada uma no seu papel', () => {
  const mapa = detectarColunas(COLUNAS_VIVENZZA)
  assert.equal(mapa.valorPago, 'ValorPago')
  assert.equal(mapa.valorPagoParcial, 'ValorParcialmentePago')
})

test('o valor pago do ERP e a SOMA das duas colunas', () => {
  const mapa = detectarColunas(COLUNAS_VIVENZZA)
  // 1000757/3 real: duplicata 3.278,80 = pago 2.572,80 + parcial 706,00
  const linha = normalizarLinhaLegado({
    NumeroTitulo: '1000757', Sequencia: '3', ValorDuplicata: 3278.80,
    ValorPago: 2572.80, ValorParcialmentePago: 706.00,
  }, mapa)
  assert.equal(Number(linha.valorPagoBruto.toFixed(2)), 3278.80)
  assert.equal(calcularValorPagoLegado(linha, 3278.80), 3278.80)
})

test('o caso que estava sendo cobrado a mais: so parcial preenchido', () => {
  const mapa = detectarColunas(COLUNAS_VIVENZZA)
  // cr-1008797-4 real: Francisco Freitas, duplicata 1.273,44, pagou 636,71.
  // Antes da correcao o CRM lia ValorPago=0 e cobrava o valor cheio.
  const linha = normalizarLinhaLegado({
    NumeroTitulo: '1008797', Sequencia: '4', ValorDuplicata: 1273.44,
    ValorPago: 0, ValorParcialmentePago: 636.71, DuplicataAberta: 'S',
  }, mapa)
  assert.equal(calcularValorPagoLegado(linha, 1273.44), 636.71)
})

test('juros/multa nao viram credito: o pago nunca passa do valor do titulo', () => {
  const mapa = detectarColunas(COLUNAS_VIVENZZA)
  const linha = normalizarLinhaLegado({
    NumeroTitulo: '1', Sequencia: '1', ValorDuplicata: 100,
    ValorPago: 115.50, ValorParcialmentePago: 0,
  }, mapa)
  assert.equal(calcularValorPagoLegado(linha, 100), 100)
})

test('instalacao SEM a coluna parcial continua funcionando como antes', () => {
  const mapa = detectarColunas(['NumeroTitulo', 'Sequencia', 'ValorTitulo', 'ValorPago', 'DataPagamento'])
  assert.ok(!mapa.valorPagoParcial, 'a coluna nao existe nesta instalacao')
  const linha = normalizarLinhaLegado({
    NumeroTitulo: '1', Sequencia: '1', ValorTitulo: 200, ValorPago: 50,
  }, mapa)
  assert.equal(calcularValorPagoLegado(linha, 200), 50)
})

// --- a distincao que nao pode ser perdida ---
test('somaValoresPagos devolve null quando NENHUMA coluna informou valor', () => {
  assert.equal(somaValoresPagos(null, null), null)
  assert.equal(somaValoresPagos(undefined, ''), null)
})

test('somaValoresPagos devolve 0 quando o ERP informou zero de verdade', () => {
  assert.equal(somaValoresPagos(0, null), 0)
  assert.equal(somaValoresPagos(0, 0), 0)
})

test('titulo quitado SEM valor informado continua sendo lido como pago integral', () => {
  const mapa = detectarColunas(COLUNAS_VIVENZZA)
  // Sem ValorPago e sem parcial, mas o ERP encerrou (DuplicataAberta nula).
  const linha = normalizarLinhaLegado({
    NumeroTitulo: '1', Sequencia: '1', ValorDuplicata: 300,
    ValorPago: null, ValorParcialmentePago: null, DuplicataAberta: null,
    DataPagamento: '2026-03-10',
  }, mapa)
  assert.equal(linha.valorPagoBruto, null, 'ausencia nao pode virar zero')
  assert.equal(calcularValorPagoLegado(linha, 300), 300)
})

test('parcial zerado e pago zerado nao inventam pagamento', () => {
  const mapa = detectarColunas(COLUNAS_VIVENZZA)
  const linha = normalizarLinhaLegado({
    NumeroTitulo: '1', Sequencia: '1', ValorDuplicata: 300,
    ValorPago: 0, ValorParcialmentePago: 0, DuplicataAberta: 'S',
  }, mapa)
  assert.equal(linha.valorPagoBruto, 0)
  assert.equal(calcularValorPagoLegado(linha, 300), 0)
})
