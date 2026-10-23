import test from 'node:test'
import assert from 'node:assert/strict'
import {carregarCadastroFisicoDoPedido, calcularLogisticaPedido} from '../../src/lib/fretes/logistica.js'

// Double apenas da fronteira de leitura. Não importa SDK, .env, legado ou worker.
function banco(itens, paginas = []) {
 const chamadas = []
 let pagina = 0
 return {chamadas, from(tabela) {
  assert.ok(['pedido_itens', 'produtos'].includes(tabela))
  const chamada = {tabela}; chamadas.push(chamada)
  return {
   select(campos) { chamada.campos = campos; return this },
   eq(campo, valor) { chamada.filtro = [campo, valor]; return this },
   limit(n) { chamada.limite = n; return Promise.resolve(itens) },
   in(campo, valores) { chamada.filtro = [campo, valores]; return Promise.resolve(paginas[pagina++]) },
  }
 }}
}
const linha = id => ({produto_id: id, quantidade: 2})
const pedidoComUnidades = itens => ({pedido_itens: itens, frete_logistica: {
 itens: itens.filter(i => i.produtos).map(i => ({CodigoItem: i.produtos.legacy_id, Unidade: 'UN'})),
}})
const fisico = id => ({id, legacy_id: id, unidade: 'UN', logistica_fisica: {
 UnidadeCadastro: 'UN', PesoBruto: 3, QtdeVolumeCubico: 0.004,
 unidades: {peso: 'kg', cubagem: 'm3'},
}})

test('sem itens retorna null sem consultar catálogo', async () => {
 const db = banco({data: []})
 assert.equal(await carregarCadastroFisicoDoPedido(db, {id: 'pedido-sintetico'}), null)
 assert.equal(db.chamadas.length, 1)
 assert.deepEqual(db.chamadas[0].filtro, ['pedido_id', 'pedido-sintetico'])
 assert.equal(db.chamadas[0].limite, 1001)
})

test('falha na leitura dos itens é propagada, não vira cadastro ausente', async () => {
 const erro = new Error('falha sintética de leitura')
 const db = banco({data: null, error: erro})
 await assert.rejects(carregarCadastroFisicoDoPedido(db, {id: 'pedido-sintetico'}), e => e === erro)
 assert.equal(db.chamadas.length, 1)
})

test('1001 itens são rejeitados antes de ler catálogo ou calcular total truncado', async () => {
 const db = banco({data: Array.from({length: 1001}, (_, n) => linha(`produto-${n}`))})
 await assert.rejects(carregarCadastroFisicoDoPedido(db, {id: 'pedido-sintetico'}), /Pedido excessivo/)
 assert.equal(db.chamadas.length, 1)
})

test('itens sem vínculo de produto não fazem busca ampla de catálogo', async () => {
 const db = banco({data: [linha(null)]})
 assert.equal(await carregarCadastroFisicoDoPedido(db, {id: 'pedido-sintetico'}), null)
 assert.equal(db.chamadas.length, 1)
})

test('catálogo sem dados físicos retorna null para o chamador decidir o fallback', async () => {
 const db = banco({data: [linha('a')]}, [{data: [{id: 'a', logistica_fisica: null}]}])
 assert.equal(await carregarCadastroFisicoDoPedido(db, {id: 'pedido-sintetico'}), null)
 assert.deepEqual(db.chamadas[1].filtro, ['id', ['a']])
})

test('deduplica IDs consultados sem perder linhas ou quantidades do pedido', async () => {
 const db = banco({data: [linha('a'), {...linha('a'), quantidade: 5}]}, [{data: [fisico('a')]}])
 const itens = await carregarCadastroFisicoDoPedido(db, {id: 'pedido-sintetico'})
 assert.deepEqual(db.chamadas[1].filtro, ['id', ['a']])
 assert.deepEqual(itens.map(i => i.quantidade), [2, 5])
 assert.equal(itens[0].produtos.id, 'a')
})

test('101 produtos usam dois lotes e mantêm a ordem dos itens', async () => {
 const ids = Array.from({length: 101}, (_, n) => `produto-${n}`)
 const db = banco({data: ids.map(linha)}, [
  {data: ids.slice(0, 100).reverse().map(fisico)}, {data: [fisico(ids[100])]},
 ])
 const itens = await carregarCadastroFisicoDoPedido(db, {id: 'pedido-sintetico'})
 assert.equal(db.chamadas.length, 3)
 assert.deepEqual(db.chamadas.slice(1).map(c => c.filtro[1].length), [100, 1])
 assert.deepEqual(db.chamadas[1].filtro, ['id', ids.slice(0, 100)])
 assert.deepEqual(db.chamadas[2].filtro, ['id', ids.slice(100)])
 assert.deepEqual(itens.map(i => i.produtos.id), ids)
})

test('falha no segundo lote não devolve catálogo parcial como completo', async () => {
 const ids = Array.from({length: 101}, (_, n) => `produto-${n}`)
 const erro = new Error('segundo lote sintético indisponível')
 const db = banco({data: ids.map(linha)}, [{data: ids.slice(0, 100).map(fisico)}, {data: null, error: erro}])
 await assert.rejects(carregarCadastroFisicoDoPedido(db, {id: 'pedido-sintetico'}), e => e === erro)
})

test('produto não retornado permanece explícito e impede total físico parcial', async () => {
 const db = banco({data: [linha('a'), linha('ausente')]}, [{data: [fisico('a')]}])
 const itens = await carregarCadastroFisicoDoPedido(db, {id: 'pedido-sintetico'})
 assert.equal(itens.length, 2)
 assert.equal(itens[1].produtos, null)
 const resultado = calcularLogisticaPedido(pedidoComUnidades(itens))
 assert.equal(resultado.peso_bruto_kg, null)
 assert.equal(resultado.cubagem_m3, null)
 assert.equal(resultado.total_itens, 2)
})

test('1000 itens são aceitos sem truncar ou perder quantidades', async () => {
 const db = banco({data: Array.from({length: 1000}, () => linha('a'))}, [{data: [fisico('a')]}])
 const itens = await carregarCadastroFisicoDoPedido(db, {id: 'pedido-sintetico'})
 assert.equal(itens.length, 1000)
 assert.equal(itens.every(i => i.quantidade === 2 && i.produtos.id === 'a'), true)
 assert.deepEqual(db.chamadas[1].filtro, ['id', ['a']])
 const resultado = calcularLogisticaPedido(pedidoComUnidades(itens))
 assert.equal(resultado.peso_bruto_kg, 6000)
 assert.equal(resultado.cubagem_m3, 8)
})

test('vínculo nulo junto de válido não some nem entra no filtro de IDs', async () => {
 const db = banco({data: [linha('a'), linha(null)]}, [{data: [fisico('a')]}])
 const itens = await carregarCadastroFisicoDoPedido(db, {id: 'pedido-sintetico'})
 assert.deepEqual(db.chamadas[1].filtro, ['id', ['a']])
 assert.equal(itens.length, 2)
 assert.equal(itens[1].produtos, null)
 assert.equal(calcularLogisticaPedido(pedidoComUnidades(itens)).peso_bruto_kg, null)
})

test('produto existente sem logística não autoriza somar só o produto completo', async () => {
 const db = banco({data: [linha('a'), linha('b')]}, [{data: [fisico('a'), {...fisico('b'), logistica_fisica: null}]}])
 const itens = await carregarCadastroFisicoDoPedido(db, {id: 'pedido-sintetico'})
 assert.equal(itens[1].produtos.id, 'b')
 const resultado = calcularLogisticaPedido(pedidoComUnidades(itens))
 assert.equal(resultado.peso_bruto_kg, null)
 assert.equal(resultado.cubagem_m3, null)
})

test('controle positivo: cadastro carregado com unidade comprovada produz totais numéricos', async () => {
 const db = banco({data: [linha('a')]}, [{data: [fisico('a')]}])
 const itens = await carregarCadastroFisicoDoPedido(db, {id: 'pedido-sintetico'})
 const resultado = calcularLogisticaPedido(pedidoComUnidades(itens))
 assert.equal(resultado.peso_bruto_kg, 6)
 assert.equal(resultado.cubagem_m3, 0.008)
})
