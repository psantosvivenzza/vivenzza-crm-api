// Funções puras: nenhum acesso ao legado, env ou credenciais.
export const normalizarUnidadeComercial=v=>{
 const u=String(v??'').trim().toUpperCase().replace(/\./g,'')
 return ['UN','UND','UNID','UNIDADE','UNIDADES'].includes(u)?'UN':u
}
const positivo=v=>['number','string'].includes(typeof v)&&String(v).trim()!==''&&Number.isFinite(Number(v))&&Number(v)>0
const arredondar=v=>{const n=Number.isFinite(v)?Number(v.toFixed(9)):null;return n>0?n:null}
const objeto=v=>v&&typeof v==='object'&&!Array.isArray(v)?v:null
const unidadeIgual=i=>normalizarUnidadeComercial(i.Unidade)&&normalizarUnidadeComercial(i.Unidade)===normalizarUnidadeComercial(i.UnidadeCadastro??i.UnidadeManipulacao)
const soma=(itens,campo)=>itens.length&&itens.every(i=>positivo(i.Quantidade)&&unidadeIgual(i)&&positivo(i[campo]))?arredondar(itens.reduce((s,i)=>s+Number(i.Quantidade)*Number(i[campo]),0)):null
export function resumirLogistica(snapshot) {
 const itens=Array.isArray(snapshot?.itens)?snapshot.itens.map(i=>objeto(i)??{}):[]
 if(!itens.length)return {peso:null,cubagem:null,avisos:['Logística dos produtos ainda não disponível. Preencha peso e cubagem manualmente.']}
 const pesos=new Set(itens.map(i=>i.unidades?.peso??i.UnidadePeso)),statusCubo=new Set(itens.map(i=>i.unidades?.cubagem??i.StatusMedidasCubicas))
 const peso=pesos.size===1?soma(itens,'PesoBruto'):null
 const cubagem=statusCubo.size===1?soma(itens,'QtdeVolumeCubico'):null
 const avisos=[]
 if(!itens.every(unidadeIgual))avisos.push('Unidades de venda e de cadastro dos produtos divergem ou estão ausentes. Totais não calculados.')
 if(peso===null)avisos.push('Peso dos produtos incompleto ou com códigos de unidade diferentes; não foi somado parcialmente.')
 if(cubagem===null)avisos.push('Cubagem dos produtos incompleta ou com status de cadastro divergente; informe a cubagem total.')
 avisos.push('Totais de produtos são sugestões de cadastro. Confira unidades e carga embalada. StatusMedidasCubicas não identifica unidade física.')
 return {peso,cubagem,avisos}
}
const fatoresPeso={kg:1,g:0.001},fatoresCubo={m3:1,cm3:0.000001,litro:0.001}
function unidadeDoItem(pedido,item) {
 if(item.unidade)return item.unidade
 if(Array.isArray(pedido.campos_com_override_local)&&pedido.campos_com_override_local.includes('itens'))return null
 const codigo=String(item.produtos?.legacy_id??'').trim()
 if(!codigo)return null
 const linhas=(Array.isArray(pedido.frete_logistica?.itens)?pedido.frete_logistica.itens:[]).filter(i=>i&&String(i.CodigoItem??'').trim()===codigo)
 const unidades=new Set(linhas.map(i=>normalizarUnidadeComercial(i.Unidade)))
 return unidades.size===1?[...unidades][0]:null
}
export function calcularLogisticaPedido(pedido) {
 const atuais=Array.isArray(pedido.pedido_itens)?pedido.pedido_itens.map(i=>objeto(i)??{}):[]
 const temCadastro=atuais.some(i=>objeto(i.produtos?.logistica_fisica))
 const override=Array.isArray(pedido.campos_com_override_local)&&pedido.campos_com_override_local.includes('itens')
 let itens=[],fonte='indisponivel'
 if(temCadastro){
  fonte='cadastro_produtos'
  itens=atuais.map(i=>({...objeto(i.produtos?.logistica_fisica),produto_id:i.produto_id,CodigoItem:i.produtos?.legacy_id,Quantidade:i.quantidade,Unidade:unidadeDoItem(pedido,i)}))
 }else if(!override&&Array.isArray(pedido.frete_logistica?.itens)){
  fonte='snapshot_pedido';itens=pedido.frete_logistica.itens.map(raw=>{const i=objeto(raw)??{};return {...i,unidades:i.unidades??pedido.frete_logistica.unidades}})
 }
 const base=resumirLogistica({itens})
 const quantidadeValida=i=>positivo(i.Quantidade)&&unidadeIgual(i)
 const unidade=(i,chave)=>String(i.unidades?.[chave]??'').trim().toLowerCase()
 const calcular=(campo,fatores,chave)=>{
  if(!itens.length||!itens.every(i=>quantidadeValida(i)&&positivo(i[campo])&&Object.hasOwn(fatores,unidade(i,chave))))return null
  return arredondar(itens.reduce((s,i)=>s+Number(i.Quantidade)*Number(i[campo])*fatores[unidade(i,chave)],0))
 }
 const peso=calcular('PesoBruto',fatoresPeso,'peso'),cubagem=calcular('QtdeVolumeCubico',fatoresCubo,'cubagem')
 const detalhes=itens.map(i=>{
  const up=unidade(i,'peso'),uc=unidade(i,'cubagem'),qp=quantidadeValida(i)
  const motivos=[]
  if(!qp)motivos.push('Quantidade ou unidade comercial divergente')
  if(!positivo(i.PesoBruto))motivos.push('Peso bruto unitário ausente')
  if(!positivo(i.QtdeVolumeCubico))motivos.push('Quantidade cúbica unitária ausente')
  if(!Object.hasOwn(fatoresPeso,up))motivos.push('Unidade física de peso pendente ou não suportada')
  if(!Object.hasOwn(fatoresCubo,uc))motivos.push('Unidade física de cubagem pendente ou não suportada')
  return {produto_id:i.produto_id??null,codigo:i.CodigoItem??null,quantidade:i.Quantidade,peso_unitario:positivo(i.PesoBruto)?Number(i.PesoBruto):null,cubagem_unitaria:positivo(i.QtdeVolumeCubico)?Number(i.QtdeVolumeCubico):null,unidade_peso:up||null,unidade_cubagem:uc||null,peso_subtotal_kg:qp&&positivo(i.PesoBruto)&&Object.hasOwn(fatoresPeso,up)?arredondar(Number(i.Quantidade)*Number(i.PesoBruto)*fatoresPeso[up]):null,cubagem_subtotal_m3:qp&&positivo(i.QtdeVolumeCubico)&&Object.hasOwn(fatoresCubo,uc)?arredondar(Number(i.Quantidade)*Number(i.QtdeVolumeCubico)*fatoresCubo[uc]):null,motivos}
 })
 return {fonte,peso_pedido_kg:positivo(pedido.peso_bruto)?Number(pedido.peso_bruto):null,peso_bruto_kg:peso,cubagem_m3:cubagem,peso_origem:base.peso,cubagem_origem:base.cubagem,unidades_peso_origem:[...new Set(itens.map(i=>unidade(i,'peso')).filter(Boolean))],unidades_cubagem_origem:[...new Set(itens.map(i=>unidade(i,'cubagem')).filter(Boolean))],codigos_peso_origem:[...new Set(itens.map(i=>i.UnidadePeso).filter(v=>v!=null))],total_itens:itens.length,itens_com_peso:itens.filter(i=>quantidadeValida(i)&&positivo(i.PesoBruto)).length,itens_com_cubagem:itens.filter(i=>quantidadeValida(i)&&positivo(i.QtdeVolumeCubico)).length,avisos:base.avisos,itens:detalhes}
}
export async function carregarCadastroFisicoDoPedido(db,pedido) {
 const itens=await db.from('pedido_itens').select('produto_id,quantidade').eq('pedido_id',pedido.id).limit(1001)
 if(itens.error)throw itens.error
 if(!itens.data?.length)return null
 if(itens.data.length>1000)throw Error('Pedido excessivo')
 const ids=[...new Set(itens.data.map(i=>i.produto_id).filter(Boolean))]
 if(!ids.length)return null
 const produtos=[]
 for(let offset=0;offset<ids.length;offset+=100){
  const result=await db.from('produtos').select('id,legacy_id,unidade,logistica_fisica').in('id',ids.slice(offset,offset+100))
  if(result.error)throw result.error
  produtos.push(...(result.data??[]))
 }
 const mapa=new Map(produtos.map(p=>[p.id,p]))
 if(!produtos.some(p=>p.logistica_fisica))return null
 return itens.data.map(i=>({...i,produtos:mapa.get(i.produto_id)??null}))
}
