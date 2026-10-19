import test from 'node:test'
import assert from 'node:assert/strict'
import { validarCotacao, validarProposta, compararPropostas, cubagemM3, montarSolicitacao, validarConfigTransportadora } from '../../src/lib/fretes/domain.js'
const payload = () => ({ descricao: 'Embalagens', valor_mercadoria: 1000, peso_kg: 20, volumes: [{ quantidade: 10, comprimento_cm: 50, largura_cm: 40, altura_cm: 30 }], retirada: { nome: 'Indústria A', cnpj: '11111111000111', cep: '90000000', endereco: 'Rua A' }, entrega: { nome: 'Indústria B', cnpj: '22222222000122', cep: '91000000', endereco: 'Rua B' }, pagador: { nome: 'Vivenzza', cnpj: '33333333000133' }, transportadora_ids: ['11111111-1111-4111-8111-111111111111'], max_prazo_dias: 3 })
const proposta = (id, valor_total, prazo_dias, extra = {}) => ({ id, valor_total, prazo_dias, completa: true, status: 'recebida', validade: '2030-01-01T00:00:00Z', ...extra })

test('formulário de CNPJ/CEP recebe somente o campo cadastrado do papel solicitado',async()=>{
 const {interpretarPerguntaFrete}=await import('../../src/lib/fretes/assistant.js')
 const d=payload()
 for(const [text,value] of [
  ['CNPJ do Remetente (somente letras e números)',d.retirada.cnpj],
  ['Digite somente letras e números.\nVerifique se o CNPJ do Remetente possui 14 caracteres.',d.retirada.cnpj],
  ['Digite somente letras e números.\\nVerifique se o CNPJ do Remetente possui 14 caracteres.',d.retirada.cnpj],
  ['CNPJ do destinatário:',d.entrega.cnpj],['Informe CEP da entrega',d.entrega.cep],['CNPJ do pagador',d.pagador.cnpj],
 ])assert.deepEqual(await interpretarPerguntaFrete(text,d),{tipo:'resposta',texto:value})
 assert.deepEqual(await interpretarPerguntaFrete('CNPJ do remetente',{...d,retirada:{cnpj:'incorreto'}}),{tipo:'revisao'})
 const composite=await interpretarPerguntaFrete('CNPJ e endereço do remetente',d)
 assert.notEqual(composite.texto,d.retirada.cnpj)
 assert.notEqual((await interpretarPerguntaFrete('CNPJ do remetente e destinatário',d)).texto,d.retirada.cnpj)
 assert.equal((await interpretarPerguntaFrete('Pare de enviar mensagens. CNPJ do remetente',d)).tipo,'opt_out')
})

test('orientação de abertura não responde comprimento/entrega antes da pergunta seguinte',async()=>{
 const {interpretarPerguntaFrete}=await import('../../src/lib/fretes/assistant.js')
 const intro='Olá! Vamos iniciar sua cotação de frete! Orientações importantes: as mercadorias devem estar embaladas. Comprimento superior a 3 metros exige alternativas. Coletas e entregas não são realizadas em áreas rurais. Tudo certo? Vamos continuar! Por gentileza, informe os dados solicitados a seguir para calcularmos o valor do seu frete.'
 assert.deepEqual(await interpretarPerguntaFrete(intro,payload()),{tipo:'aguardar'})
 assert.deepEqual(await interpretarPerguntaFrete(intro.replace('Tudo certo? Vamos continuar!','Tudo certo?\\nVamos continuar!'),payload()),{tipo:'aguardar'})
 assert.equal((await interpretarPerguntaFrete('CEP do pagador',payload())).tipo,'revisao')
 assert.notEqual((await interpretarPerguntaFrete(intro.replace('Tudo certo?','Você aceita as condições?'),payload())).tipo,'aguardar')
})

test('cotação aceita até 50 transportadoras distintas sem ampliar volumes ou permitir duplicatas', () => {
 const ids = Array.from({length:51}, (_, i) => `11111111-1111-4111-8111-${String(i+1).padStart(12,'0')}`)
 for(const n of [1,30,31,45,50])assert.deepEqual(validarCotacao({...payload(),transportadora_ids:ids.slice(0,n)}).transportadora_ids,ids.slice(0,n))
 for(const invalid of [[],ids,[ids[0],ids[0]],['invalido'],null])assert.throws(()=>validarCotacao({...payload(),transportadora_ids:invalid}),/1 a 50 transportadoras distintas/)
 assert.throws(()=>validarCotacao({...payload(),volumes:Array.from({length:31},()=>payload().volumes[0])}),/1 a 30 grupos de volumes/)
})
test('entrega entre indústrias preserva pagador terceiro, peso total e cubagem independente', () => {
 const d = validarCotacao(payload())
 assert.equal(cubagemM3(d.volumes), .6)
 const msg = montarSolicitacao(d, 'FRETE-TESTE')
 assert.match(msg, /Retirada: Indústria A/); assert.match(msg, /Entrega: Indústria B/)
 assert.match(msg, /Pagador do frete: Vivenzza/); assert.match(msg, /TOTAL: 20 kg/)
 assert.match(msg, /0.6000 m³/)
})
test('barato lento permanece destacado, custo benefício atende prazo e média não mistura incompletas', () => {
 const c = compararPropostas([proposta('a', 100, 10), proposta('b', 180, 2), proposta('c', 230, 1), proposta('d', 1, 1, { completa: false }), proposta('e', 1, 1, { validade: '2000-01-01T00:00:00Z' })], { max_prazo_dias: 3 })
 assert.equal(c.menor_valor.id, 'a'); assert.equal(c.menor_prazo.id, 'c')
 assert.equal(c.melhor_custo_beneficio.id, 'b'); assert.equal(c.media_valor, 170); assert.equal(c.quantidade_completas, 3)
})
test('prazo impossível não oculta o barato, zero dias é permitido e empate é estável', () => {
 const c = compararPropostas([proposta('b', 100, 5), proposta('a', 100, 5)], { max_prazo_dias: 0 })
 assert.equal(c.menor_valor.id, 'a'); assert.equal(c.melhor_custo_beneficio, null)
 assert.equal(compararPropostas([proposta('a', 100, 0)], { max_prazo_dias: 0 }).melhor_custo_beneficio.id, 'a')
})
test('proposta não confirmada, sem validade ou com preço/prazo ausente não entra no ranking', () => {
 const c = compararPropostas([proposta('a', 0, 1), proposta('b', 100, null), proposta('c', 100, 1, { validade: null }), proposta('d', 10, 1, { status: 'revisao' })])
 assert.equal(c.quantidade_completas, 0); assert.equal(c.media_valor, null)
 assert.throws(() => validarProposta({ valor_total: 100, prazo_dias: 1, completa: true }))
})
test('inputs malformados e telefones curtos são rejeitados', () => {
 for (const campo of ['valor_mercadoria', 'peso_kg']) for (const v of [null, '', NaN, -1, true, Infinity]) assert.throws(() => validarCotacao({ ...payload(), [campo]: v }))
 assert.throws(() => validarCotacao({ ...payload(), volumes: [{ quantidade: 0 }] }))
 assert.throws(() => validarCotacao({ ...payload(), transportadora_ids: ['../'] }))
 assert.throws(() => validarConfigTransportadora({ participa_cotacao_frete: true, cotacao_frete_consentimento: true, telefone_cotacao_frete: '123' }))
 assert.equal(validarConfigTransportadora({ participa_cotacao_frete: true, cotacao_frete_consentimento: false, telefone_cotacao_frete: '(51) 99999-1111' }).telefone_cotacao_frete, '5551999991111')
})

test('logística de produtos não soma faltantes nem unidades incompatíveis', async()=>{
 const {resumirLogistica,validarBuscaPedido,prepararPedidoFrete}=await import('../../src/lib/fretes/pedido.js')
 const i={Quantidade:3,Unidade:'UN',UnidadeManipulacao:'UN',PesoBruto:2,UnidadePeso:0,QtdeVolumeCubico:0.01,StatusMedidasCubicas:0}
 assert.equal(resumirLogistica({itens:[i]}).cubagem,0.03)
 assert.equal(resumirLogistica({itens:[i,{...i,QtdeVolumeCubico:null}]}).cubagem,null)
 assert.equal(resumirLogistica({itens:[{...i,Unidade:'CX'}]}).peso,null)
 assert.equal(resumirLogistica({itens:[i,{...i,UnidadePeso:1}]}).peso,null)
 assert.throws(()=>validarBuscaPedido('1%'));assert.deepEqual(validarBuscaPedido('00123','1'),{numero:'123',filial:'1'})
 const r=prepararPedidoFrete({id:'x',legacy_id:'001-1',status:'confirmado',total:10,peso_bruto:null,qtde_volumes:null},null,{itens:[]},{xNome:'Empresa teste',CNPJ:'11111111000111'})
 assert.equal(r.dados.peso_kg,'');assert.equal(r.dados.entrega.nome,'');assert.ok(r.avisos.length)
})
test('solicitação e assistente informam cubagem total sem inventar dimensões',async()=>{
 const {montarSolicitacao}=await import('../../src/lib/fretes/domain.js')
 const {interpretarPerguntaFrete}=await import('../../src/lib/fretes/assistant.js')
 const d={descricao:'Teste',valor_mercadoria:10,peso_kg:3,modo_volumes:'cubagem_total',quantidade_volumes:2,cubagem_m3:0.08,volumes:[],retirada:{nome:'A',cnpj:'11111111000111',cep:'90000000',endereco:'Rua A'},entrega:{nome:'B',cnpj:'12345678901',cep:'90000000',endereco:'Rua B'},pagador:{nome:'A',cnpj:'11111111000111'}}
 const text=montarSolicitacao(d,'TESTE');assert.match(text,/0.08 m³/);assert.match(text,/CPF 12345678901/);assert.match(text,/Medidas individuais não informadas/)
 assert.equal((await interpretarPerguntaFrete('Qual a altura?',d)).tipo,'revisao')
 assert.match((await interpretarPerguntaFrete('Qual a cubagem?',d)).texto,/0.08 m³/)
})
