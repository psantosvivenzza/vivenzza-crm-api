import test from 'node:test'
import assert from 'node:assert/strict'
import { criarObservadorFinanceiro } from '../lib/financeiro-phase.mjs'

test('preserva resultado e execução única; log contém só metadados permitidos', async () => {
  const eventos = []; let chamadas = 0; let tempo = 10
  const observar = criarObservadorFinanceiro({ log: x => eventos.push(JSON.parse(x)), agora: () => tempo })
  const resultado = { segredo: 'dado-sintetico-privado' }
  const recebido = await observar('conferencia', () => { chamadas++; tempo = 35; return resultado })
  assert.equal(recebido, resultado); assert.equal(chamadas, 1)
  assert.deepEqual(eventos.map(e => e.evento), ['inicio', 'fim'])
  assert.equal(eventos[1].duracao_ms, 25)
  assert.deepEqual(Object.keys(eventos[1]).sort(), ['tipo', 'etapa', 'evento', 'em', 'duracao_ms'].sort())
  assert.doesNotMatch(JSON.stringify(eventos), /dado-sintetico-privado|segredo/)
})

test('falha preserva a mesma exceção sem vazar mensagem, stack ou causa', async () => {
  const linhas = []; const erro = new Error('token-sintetico-privado', {cause: 'conta-sintetica'})
  const observar = criarObservadorFinanceiro({ log: x => linhas.push(x) })
  await assert.rejects(observar('alerta', () => { throw erro }), e => e === erro)
  assert.deepEqual(linhas.map(x => JSON.parse(x).evento), ['inicio', 'erro'])
  assert.doesNotMatch(linhas.join(''), /token-sintetico|conta-sintetica|stack|cause/)
})

test('operação pendente emite início e não inventa conclusão nem inicia outra', async () => {
  const eventos = []; let liberar; let chamadas = 0
  const pendente = new Promise(resolve => { liberar = resolve })
  const observar = criarObservadorFinanceiro({ log: x => eventos.push(JSON.parse(x)) })
  const execucao = observar('sincronizacao_completa', () => { chamadas++; return pendente })
  await Promise.resolve()
  assert.equal(chamadas, 1); assert.deepEqual(eventos.map(e => e.evento), ['inicio'])
  liberar('ok'); assert.equal(await execucao, 'ok')
  assert.deepEqual(eventos.map(e => e.evento), ['inicio', 'fim'])
})

test('logger e relógio com falha não impedem a operação nem substituem sua falha', async () => {
  const observar = criarObservadorFinanceiro({ log: () => { throw Error('log') }, agora: () => { throw Error('clock') } })
  assert.equal(await observar('conferencia', () => 42), 42)
  const erro = Error('original')
  await assert.rejects(observar('conferencia', () => Promise.reject(erro)), e => e === erro)
})

test('etapa não permitida é sanitizada e relógio regressivo não gera duração negativa', async () => {
  const eventos = []; let tempo = 10
  const observar = criarObservadorFinanceiro({ log: x => eventos.push(JSON.parse(x)), agora: () => tempo })
  await observar('cliente-sintetico-privado', () => { tempo = 5 })
  assert.ok(eventos.every(e => e.etapa === 'desconhecida'))
  assert.equal(eventos[1].duracao_ms, 0)
  assert.doesNotMatch(JSON.stringify(eventos), /cliente-sintetico/)
})
