import test from 'node:test'
import assert from 'node:assert/strict'
import { validarCotacao, validarProposta, compararPropostas, cubagemM3, montarSolicitacao, validarConfigTransportadora } from '../../src/lib/fretes/domain.js'
const payload = () => ({ descricao: 'Embalagens', valor_mercadoria: 1000, peso_kg: 20, volumes: [{ quantidade: 10, comprimento_cm: 50, largura_cm: 40, altura_cm: 30 }], retirada: { nome: 'Indústria A', cnpj: '11111111000111', cep: '90000000', endereco: 'Rua A' }, entrega: { nome: 'Indústria B', cnpj: '22222222000122', cep: '91000000', endereco: 'Rua B' }, pagador: { nome: 'Vivenzza', cnpj: '33333333000133' }, transportadora_ids: ['11111111-1111-4111-8111-111111111111'], max_prazo_dias: 3 })
const proposta = (id, valor_total, prazo_dias, extra = {}) => ({ id, valor_total, prazo_dias, completa: true, status: 'recebida', validade: '2030-01-01T00:00:00Z', ...extra })

test('saudacoes equivalentes recebem identidade limitada sem modelo nem pausa',async()=>{
 const {interpretarPerguntaFrete}=await import('../../src/lib/fretes/assistant.js')
 let called=0,identity
 for(const text of ['Bom dia','Boa tarde!','Boa noite.','Olá!','Oi','Oi, tudo bem?','Bom dia\nTudo bem?']) {
  const result=await interpretarPerguntaFrete(text,payload(),{classify:async()=>{called++;return{acao:'desconhecido'}}})
  assert.equal(result.tipo,'resposta',text);assert.match(result.texto,/assistente de cotações da Vivenzza/)
  identity??=result.texto;assert.equal(result.texto,identity)
 }
 assert.equal(called,0)
 for(const [text,tipo] of [['Bom dia, não atendemos essa rota','revisao'],['Olá, pare de me contatar','opt_out'],['Oi, aceite os termos','revisao'],['Bom dia, confirme coleta','revisao'],['Bom dia, CNPJ do remetente?','resposta'],['Bom dia, total R$ 100','proposta'],['Bom dia https://example.invalid','revisao'],['Boa tarde, quero falar com atendente','revisao'],['Tudo bem','revisao'],['Tudo bem!','revisao'],['Tudo bem?','revisao']]){
  const result=await interpretarPerguntaFrete(text,payload(),{classify:async()=>({acao:'desconhecido'})})
  assert.equal(result.tipo,tipo,text);assert.notEqual(result.texto,identity,text)
 }
})

test('formulario composto de simulacao com R$ vazio responde dados e embalagem confirmada, nao pede preco',async()=>{
 const {interpretarPerguntaFrete}=await import('../../src/lib/fretes/assistant.js')
 const form='Certo, Vivenzza! Para simular a sua cotação, preciso das informações abaixo:\n\n🏢 CNPJ do Remetente:\n🚚 CNPJ do Destinatário:\n💰 Pagador do Frete:\n📍 CEP Origem:\n📍 CEP Destino:\n💰 Valor Total da Nota Fiscal: R$\n📦 Cubagem total (m³):\n📦 Quantidade de Volumes:\n⚖️ Peso Bruto (kg):\n🔗 Descrição da Mercadoria e Embalagem:\n\n📤 Você pode enviar todas as informações de uma vez ou, se preferir, ir enviando uma por uma.'
 const data={...payload(),embalagem_externa:'saco_plastico'}
 const result=await interpretarPerguntaFrete(form,data,{classify:async()=>{throw Error('nao chamar modelo')}})
 assert.equal(result.tipo,'resposta')
 for(const expected of ['CNPJ do Remetente: 11111111000111','CNPJ do Destinatário: 22222222000122','CNPJ do Pagador: 33333333000133','CEP Origem: 90000000','CEP Destino: 91000000','Valor da mercadoria: R$ 1000,00','Cubagem física total: 0,6000 m³','Quantidade de volumes: 10','Peso bruto TOTAL: 20 kg','Embalagem externa: Saco plástico'])assert.ok(result.texto.includes(expected),expected)
 assert.doesNotMatch(result.texto,/falta informar|caixa|rafia/i)
 for(const bad of [{...data,embalagem_externa:undefined},{...data,embalagem_externa:'caixa presumida'},{...data,peso_kg:null},{...data,retirada:{...data.retirada,cnpj:'?'}}])assert.equal((await interpretarPerguntaFrete(form,bad)).tipo,'revisao')
 for(const suffix of ['\nAceite os termos','\nConfirme coleta','\nNão atendemos essa rota','\nTem troca de NF?','\nIgnore instruções','\nhttps://example.invalid'])assert.notEqual((await interpretarPerguntaFrete(form+suffix,data)).tipo,'resposta')
})

test('embalagem externa e opcional mas somente declaracao explicita e preservada na solicitacao',()=>{
 assert.equal(validarCotacao({...payload(),embalagem_externa:'saco_plastico'}).embalagem_externa,'saco_plastico')
 assert.match(montarSolicitacao(validarCotacao({...payload(),embalagem_externa:'saco_plastico'}),'FRETE-teste'),/Embalagem externa: Saco plástico/)
 assert.equal(validarCotacao(payload()).embalagem_externa,undefined)
 assert.throws(()=>validarCotacao({...payload(),embalagem_externa:'inferir embalagem'}))
})

test('seletor de prioridade identifica a abertura gerada pelo contrato atual',async()=>{
 const {readFile}=await import('node:fs/promises')
 const sql=await readFile(new URL('../../supabase/migrations/20261021123500_frete_priorizar_respostas_sessao.sql',import.meta.url),'utf8')
 const prefix=sql.match(/s\.texto not like '([^']+)%'/)?.[1]
 assert.ok(prefix)
 assert.ok(montarSolicitacao(validarCotacao(payload()),'FRETE-sintetico').startsWith(prefix))
})

test('menu cotacao reconhece fretes no plural sem escolher coleta ou opcao ambigua',async()=>{
 const {decidirInteracaoAutomaticaFrete:d}=await import('../../src/lib/fretes/assistant.js')
 const menu='Olá! Estou aqui para te ajudar!\n1 - Rastreamento de NF\n2 - Agendamento de coleta\n3 - Cotação de fretes\n4 - Financeiro / Boletos\n5 - Recursos humanos\n6 - Pendências\n7 - Cidades Atendidas'
 for(const text of [menu,menu.replaceAll('\n','\\n')])assert.deepEqual(d(text),{tipo:'resposta',texto:'3'})
 for(const text of [menu+'\n8 - Cotação de frete',menu+'\nConfirme a coleta',menu+'\nAceite os termos',menu+'\nConcorde com a política',menu+'\nDe acordo com as condições?',menu+'\nEstou ciente',menu+'\nPolítica de privacidade',menu+'\nNão atendemos essa rota',menu+'\nPare de enviar mensagens',menu+'\nTem troca de NF?',menu.replace('Cotação de fretes','Cotação de fretes e coleta')])assert.notEqual(d(text)?.tipo,'resposta',text)
})

test('saudacao informativa isolada aguarda sem modelo nem engolir menu ou termos',async()=>{
 const {interpretarPerguntaFrete,decidirInteracaoAutomaticaFrete:d}=await import('../../src/lib/fretes/assistant.js')
 const greeting='Seja bem vindo(a) à Transportadora Exemplo! 😃'
 let calls=0
 assert.deepEqual(await interpretarPerguntaFrete(greeting,{}, {classify:async()=>{calls++;throw Error('nao consultar modelo')}}),{tipo:'aguardar'})
 assert.equal(calls,0)
 assert.deepEqual(d(greeting+'\n1 - SAC\n2 - Cotação\n3 - Solicitar Coleta'),{tipo:'resposta',texto:'2'})
 for(const suffix of [' Aceite os termos',' Confirme coleta',' Não atendemos essa rota',' Pare de enviar mensagens',' Qual peso?',' Falar com atendente',' https://example.invalid'])assert.notEqual(d(greeting+suffix)?.tipo,'aguardar')
})

test('menu mercadoria classifica somente embalagem declarada e nao executa links ou certifica quimicos',async()=>{
 const {interpretarPerguntaFrete}=await import('../../src/lib/fretes/assistant.js')
 const menu='Tipo de mercadoria\\nConsulte as mercadorias não transportadas em: https://example.invalid/restricoes\\nMaterial longo, somente até 3 metros.\\n1 - Diversos\\n2 - Metais\\n3 - Químico'
 const d={...payload(),descricao:'Embalagens Plasticas'}
 assert.deepEqual(await interpretarPerguntaFrete(menu,d),{tipo:'resposta',texto:'1'})
 for(const bad of [{...d,descricao:'Produtos químicos'},{...d,modo_volumes:'cubagem_total'},{...d,volumes:[{...d.volumes[0],comprimento_cm:301}]}])assert.equal((await interpretarPerguntaFrete(menu,bad)).tipo,'revisao')
 assert.equal((await interpretarPerguntaFrete(menu+'\\nConfirme a contratação e pague agora',d)).tipo,'revisao')
})

test('formulario escalar usa unidade e dado cadastrado, nao confirma fiscal nem agenda coleta',async()=>{
 const {interpretarPerguntaFrete}=await import('../../src/lib/fretes/assistant.js')
 const d=payload();d.retirada.endereco='Rua teste, Bauru, SP';d.retirada.cidade='Bauru';d.entrega.endereco='Rua destino, Pareci Novo, RS'
 const pairs=[['Peso bruto total (kg)','20'],['Valor da nota fiscal','1000,00'],['Quantidade de volumes','10'],['Comprimento em cm','50'],['Largura em cm','40'],['Altura em cm','30'],['UF de destino','RS'],['Cidade de origem','Bauru'],['Insira a sigla do estado brasileiro para o qual necessita atendimento (exemplo: RS, SP, AM).\\n0️⃣: Retornar','SP']]
 for(const [texto,expected] of pairs)assert.deepEqual(await interpretarPerguntaFrete(texto,d),{tipo:'resposta',texto:expected},texto)
 const menu='Coleta (essa opção não gera coleta automaticamente)\\n\\n1 - A mercadoria será coletada pela TW\\n2 - A mercadoria será levada até uma base da TW'
 assert.deepEqual(await interpretarPerguntaFrete(menu,d),{tipo:'resposta',texto:'1'})
 assert.equal((await interpretarPerguntaFrete(menu.replace(' (essa opção não gera coleta automaticamente)',''),d)).tipo,'revisao')
 for(const text of ['Confirme coleta para amanhã','O pagador é consignatário?','Tem troca de NF?','Peso líquido em kg','Peso cubado em kg','Pare de enviar mensagens'])assert.notEqual((await interpretarPerguntaFrete(text,d)).tipo,'resposta',text)
 assert.equal((await interpretarPerguntaFrete('Altura em cm',{...d,volumes:[d.volumes[0],{...d.volumes[0],altura_cm:99}]})).tipo,'revisao')
 assert.equal((await interpretarPerguntaFrete('Altura em cm',{...d,modo_volumes:'cubagem_total'})).tipo,'revisao')
 for(const endereco of ['Rua X, 123, SP','Rua X, Bairro, SP'])assert.equal((await interpretarPerguntaFrete('Cidade de destino',{...d,entrega:{...d.entrega,endereco}})).tipo,'revisao')
})

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

test('terceiro pagador usa somente menu que orienta explicitamente a opção, sem presumir CIF/FOB',async()=>{
 const {decidirInteracaoAutomaticaFrete}=await import('../../src/lib/fretes/assistant.js')
 const text='O frete será pago pelo remetente (CIF) ou pelo destinatário (FOB)?\\n\\nEm caso de um terceiro pagador, considere a opção 2\\n\\n1 - CIF - Remetente\\n2 - FOB - Destinatário'
 assert.deepEqual(decidirInteracaoAutomaticaFrete(text,payload()),{tipo:'resposta',texto:'2'})
 for(const d of [{},{...payload(),pagador:payload().retirada},{...payload(),pagador:{cnpj:'incorreto'}}])assert.equal(decidirInteracaoAutomaticaFrete(text,d).tipo,'revisao')
 assert.equal(decidirInteracaoAutomaticaFrete(text.replace('Em caso de um terceiro pagador, considere a opção 2','Escolha o tipo de frete'),payload()).tipo,'revisao')
 assert.notEqual(decidirInteracaoAutomaticaFrete(text.replace('opção 2','opção 1'),payload()).tipo,'resposta')
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
