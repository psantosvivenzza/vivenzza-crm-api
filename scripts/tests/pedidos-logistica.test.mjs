import test from 'node:test'
import assert from 'node:assert/strict'
import {calcularLogisticaPedido,resumirLogistica} from '../../src/lib/fretes/logistica.js'
const fisico={origem:'netvision',UnidadeCadastro:'UNID',PesoBruto:2,UnidadePeso:0,QtdeVolumeCubico:0.003,StatusMedidasCubicas:0,unidades:{peso:'kg',cubagem:'m3'}}
const item=(q,log=fisico)=>({produto_id:'produto-teste',unidade:'UN',quantidade:q,produtos:{legacy_id:'produto-legado-teste',unidade:'UN',logistica_fisica:log}})
test('pedido usa cadastro físico do CRM e quantidade atual, inclusive sem NetVision ou snapshot',()=>{
 const d=calcularLogisticaPedido({peso_bruto:7,pedido_itens:[item(3)],sistema_origem:'manual'})
 assert.equal(d.fonte,'cadastro_produtos');assert.equal(d.peso_bruto_kg,6);assert.equal(d.cubagem_m3,0.009);assert.equal(d.peso_pedido_kg,7);assert.equal(d.itens_com_cubagem,1)
})
test('cadastro atual prevalece sobre snapshot antigo e não confunde unidade de manipulação vazia',()=>{
 const d=calcularLogisticaPedido({pedido_itens:[item(4,{...fisico,UnidadeManipulacao:'      '})],frete_logistica:{itens:[{Quantidade:99}]}})
 assert.equal(d.cubagem_m3,0.012);assert.equal(d.peso_bruto_kg,8)
 assert.equal(resumirLogistica({itens:[{...fisico,Quantidade:4,Unidade:'UND'}]}).cubagem,0.012)
})
test('faltante não vira zero nem total parcial; unidade desconhecida não vira m³',()=>{
 const d=calcularLogisticaPedido({pedido_itens:[item(3),item(1,{...fisico,QtdeVolumeCubico:0})]})
 assert.equal(d.cubagem_m3,null);assert.equal(d.itens_com_cubagem,1);assert.equal(d.total_itens,2)
 const sem=calcularLogisticaPedido({pedido_itens:[item(3,{...fisico,unidades:{peso:null,cubagem:null}})]})
 assert.equal(sem.cubagem_m3,null);assert.equal(sem.cubagem_origem,0.009)
 assert.equal(calcularLogisticaPedido({campos_com_override_local:['itens'],frete_logistica:{itens:[fisico]}}).fonte,'indisponivel')
})
test('conversões explícitas por produto e quantidades fracionárias preservam precisão',()=>{
 const d=calcularLogisticaPedido({pedido_itens:[item(2,{...fisico,PesoBruto:500,QtdeVolumeCubico:1000,unidades:{peso:'g',cubagem:'cm3'}}),item(0.5)]})
 assert.equal(d.peso_bruto_kg,2);assert.equal(d.cubagem_m3,0.0035)
})

test('snapshot malformado não derruba pedido e unidade nula preserva valor bruto para conferência',()=>{
 assert.doesNotThrow(()=>calcularLogisticaPedido({frete_logistica:{itens:[null]}}))
 const d=calcularLogisticaPedido({pedido_itens:[item(2,{...fisico,UnidadePeso:null,StatusMedidasCubicas:null,unidades:{peso:null,cubagem:null}})]},{peso:'kg',cubagem:'m3'})
 assert.equal(d.peso_bruto_kg,null);assert.equal(d.cubagem_m3,null);assert.equal(d.peso_origem,4);assert.equal(d.cubagem_origem,0.006)
 const misto=calcularLogisticaPedido({frete_logistica:{itens:[{...fisico,Unidade:'UN',Quantidade:1,unidades:null},{...fisico,Unidade:'UN',Quantidade:1,UnidadePeso:1,unidades:null}] }},{peso:'kg',cubagem:'m3'})
 assert.equal(misto.peso_bruto_kg,null)
})

 test('unidade vendida nao e inferida do cadastro e CX nao vira UN',()=>{
 const i=item(2);delete i.unidade
 assert.equal(calcularLogisticaPedido({pedido_itens:[i]}).cubagem_m3,null)
 const base={pedido_itens:[i],frete_logistica:{itens:[{CodigoItem:'produto-legado-teste',Unidade:'CX'}]}}
 assert.equal(calcularLogisticaPedido(base).cubagem_m3,null)
 base.frete_logistica.itens[0].Unidade='UNID'
 assert.equal(calcularLogisticaPedido(base).cubagem_m3,0.006)
 assert.equal(calcularLogisticaPedido({...base,campos_com_override_local:['itens']}).cubagem_m3,null)
 })
