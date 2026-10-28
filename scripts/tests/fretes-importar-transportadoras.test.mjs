import test from 'node:test'
import assert from 'node:assert/strict'
import { planejarTransportadoras } from '../../src/lib/fretes/importar-transportadoras.js'
const row = {CGC_CPF:'11.222.333/0001-81',Nome:'Transportadora teste',Inativo:0,Celular:'51999999999'}
test('compara documento sem máscara, preservando cadastro existente',()=>{
 const p=planejarTransportadoras([row],[{cnpj:'11222333000181'}]); assert.equal(p.novos.length,0); assert.equal(p.resumo.existentes,1)
})
test('repetição na origem gera um cadastro, sem consentimento/envio',()=>{
 const p=planejarTransportadoras([row,{...row}],[]); assert.equal(p.novos.length,1); assert.equal(p.resumo.repetidos,1)
 assert.equal(p.novos[0].cotacao_frete_consentimento,false); assert.equal(p.novos[0].participa_cotacao_frete,false); assert.equal(p.novos[0].telefone_cotacao_frete,null)
 assert.equal(p.novos[0].cnpj,'11222333000181')
})
test('documento inválido, ausente e nomes ambíguos não são importados',()=>{
 const p=planejarTransportadoras([row,{...row,Nome:'Outro cadastro'},{...row,CGC_CPF:''},{...row,CGC_CPF:'00000000000000'}],[])
 assert.equal(p.novos.length,0); assert.equal(p.resumo.ambiguos,2); assert.equal(p.resumo.invalidos,2)
})
test('inativo não se torna ativo e reexecução é idempotente',()=>{
 const p=planejarTransportadoras([{...row,Inativo:1}],[]); assert.equal(p.novos[0].ativo,false)
 assert.equal(planejarTransportadoras([row],p.novos).novos.length,0)
})
