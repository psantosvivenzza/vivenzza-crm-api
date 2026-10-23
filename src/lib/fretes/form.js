import {cubagemM3,rotuloEmbalagemFrete} from './domain.js'
// Formulario usa somente valores salvos. UF de atendimento = local de retirada.
const UFS=/^(?:AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)$/
const fold=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[.,\s]+/g,' ').trim()
export async function completarLocalFormularioFrete(db,dados){
 const docs=[dados.retirada?.cnpj,dados.entrega?.cnpj].filter(v=>/^\d{14}$/.test(v||''))
 if(!docs.length)return dados
 const masks=docs.map(v=>v.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/,'$1.$2.$3/$4-$5'))
 const result=await db.from('fornecedores').select('cnpj,endereco').in('cnpj',[...docs,...masks])
 if(result.error)throw result.error
 const copy={...dados}
 for(const role of ['retirada','entrega']){
  const part=dados[role];if(!part)continue
  const matches=(result.data||[]).filter(f=>String(f.cnpj||'').replace(/\D/g,'')===part.cnpj)
  if(matches.length!==1)continue
  const e=matches[0].endereco
  if(!e||typeof e!=='object'||Array.isArray(e)||String(e.cep||'').replace(/\D/g,'')!==part.cep||!/^\d{8}$/.test(part.cep||''))continue
  const cidade=String(e.cidade||'').trim(),uf=String(e.uf||'').trim().toUpperCase()
  if(!/^[\p{L}][\p{L} .'-]{1,99}$/u.test(cidade)||!UFS.test(uf)||!fold(part.endereco).endsWith(' '+fold(cidade)+' '+uf.toLowerCase()))continue
  copy[role]={...part,cidade}
 }
 return copy
}
function local(d){
 const parts=String(d?.endereco||'').split(',').map(s=>s.trim()).filter(Boolean)
 const uf=parts.at(-1)?.replace(/\.$/,'').toUpperCase()
 // Nao inferir municipio de bairro/numero: cidade exige cadastro estruturado.
 const cidade=typeof d?.cidade==='string'&&/^[\p{L}][\p{L} .'-]{1,99}$/u.test(d.cidade.trim())?d.cidade.trim():null
 return UFS.test(uf||'')&&parts.length>=3?{uf,cidade}:null
}
export function responderFormularioFrete(t,d){
 if(t.length>600)return null
 const compact=t.replace(/\s+/g,' ').trim()
 // Formulario fechado de simulacao, nao proposta. R$ vazio e um rotulo,
 // nao um preco recebido. Nenhuma prosa adicional/termo entra nesta regra.
 const clean=v=>fold(v).replace(/[\p{Extended_Pictographic}\uFE0F\u20E3]/gu,'').replace(/\s+/g,' ').trim()
 const formulario='Certo, Vivenzza! Para simular a sua cotação, preciso das informações abaixo: CNPJ do Remetente: CNPJ do Destinatário: Pagador do Frete: CEP Origem: CEP Destino: Valor Total da Nota Fiscal: R$ Cubagem total (m³): Quantidade de Volumes: Peso Bruto (kg): Descrição da Mercadoria e Embalagem: Você pode enviar todas as informações de uma vez ou, se preferir, ir enviando uma por uma.'
 if(clean(t)===clean(formulario)){
  const embalagem=rotuloEmbalagemFrete(d.embalagem_externa)
  const positive=n=>typeof n==='number'&&Number.isFinite(n)&&n>0
  const agregado=d.modo_volumes==='cubagem_total'
  const volumes=agregado?Number.isInteger(d.quantidade_volumes)&&d.quantidade_volumes>0&&positive(d.cubagem_m3):Array.isArray(d.volumes)&&d.volumes.length>0&&d.volumes.every(v=>Number.isInteger(v.quantidade)&&v.quantidade>0&&[v.comprimento_cm,v.largura_cm,v.altura_cm].every(positive))
  if(!embalagem||!volumes||!positive(d.peso_kg)||!positive(d.valor_mercadoria)||![d.retirada?.cnpj,d.entrega?.cnpj,d.pagador?.cnpj].every(v=>/^\d{14}$/.test(v||''))||![d.retirada?.cep,d.entrega?.cep].every(v=>/^\d{8}$/.test(v||''))||typeof d.descricao!=='string'||!d.descricao.trim()||d.descricao.length>300)return {tipo:'revisao'}
  const quantidade=agregado?d.quantidade_volumes:d.volumes.reduce((s,v)=>s+v.quantidade,0),cubagem=agregado?d.cubagem_m3:cubagemM3(d.volumes)
  if(!positive(cubagem)||!Number.isFinite(quantidade))return {tipo:'revisao'}
  return {tipo:'resposta',texto:[`CNPJ do Remetente: ${d.retirada.cnpj}`,`CNPJ do Destinatário: ${d.entrega.cnpj}`,`CNPJ do Pagador: ${d.pagador.cnpj}`,`CEP Origem: ${d.retirada.cep}`,`CEP Destino: ${d.entrega.cep}`,`Valor da mercadoria: R$ ${d.valor_mercadoria.toFixed(2).replace('.',',')}`,`Cubagem física total: ${cubagem.toFixed(4).replace('.',',')} m³`,`Quantidade de volumes: ${quantidade}`,`Peso bruto TOTAL: ${d.peso_kg} kg`,`Descrição da mercadoria: ${d.descricao.trim()}`,`Embalagem externa: ${embalagem}`,'Somente cotação, sem contratação nem agendamento de coleta.'].join('\n')}
 }
 // Escolha SOMENTE para simular coleta; nunca agendamento.
 if(compact==='coleta (essa opcao nao gera coleta automaticamente) 1 - a mercadoria sera coletada pela tw 2 - a mercadoria sera levada ate uma base da tw')return d.retirada?.endereco&&/^\d{8}$/.test(d.retirada?.cep||'')&&d.entrega?.endereco?{tipo:'resposta',texto:'1'}:{tipo:'revisao'}
 if(/^insira a sigla do estado brasileiro para o qual necessita atendimento \(exemplo: rs, sp, am\)\.\s*0: retornar$/.test(compact)){
  const value=local(d.retirada)?.uf
  return value?{tipo:'resposta',texto:value}:{tipo:'revisao'}
 }
 const k=compact.replace(/^(?:(?:por favor|por gentileza)[, ]*)?(?:informe|digite|insira|qual e)\s+/,'').replace(/\s*\((?:somente|apenas) numeros\)\s*$/,'').replace(/[():?]/g,' ').replace(/\s+/g,' ').replace(/^[oa] /,'').replace(/[.! ]+$/,'').trim()
 let value
 if(/^peso(?: bruto)? total(?: da carga)?(?:(?: em)? kg)?$/.test(k))value=d.peso_kg
 else if(/^(?:tipo de )?embalagem(?: externa)?$/.test(k))return rotuloEmbalagemFrete(d.embalagem_externa)?{tipo:'resposta',texto:rotuloEmbalagemFrete(d.embalagem_externa)}:{tipo:'revisao'}
 else if(/^valor (?:total )?(?:da )?(?:nota fiscal|mercadoria|nf)(?: em reais)?$/.test(k))value=d.valor_mercadoria
 else if(/^(?:quantidade|numero)(?: total)? de volumes$/.test(k))value=d.modo_volumes==='cubagem_total'?d.quantidade_volumes:d.volumes?.reduce((s,v)=>s+v.quantidade,0)
 else if(/^(?:comprimento|largura|altura)(?: dos? volumes?)?(?: em)? cm$/.test(k)){
  const field=k.startsWith('comprimento')?'comprimento_cm':k.startsWith('largura')?'largura_cm':'altura_cm'
  if(d.modo_volumes==='cubagem_total'||!d.volumes?.length)return {tipo:'revisao'}
  value=d.volumes[0][field]
  if(d.volumes.some(v=>v[field]!==value))return {tipo:'revisao'}
 }else if(/^(?:descricao|tipo|natureza) da (?:mercadoria|carga)$/.test(k))return typeof d.descricao==='string'&&d.descricao.trim()&&d.descricao.length<=300?{tipo:'resposta',texto:d.descricao.replace(/\s+/g,' ').trim()}:{tipo:'revisao'}
 else if(/^(?:uf|estado|cidade|municipio) (?:de |da |do )?(?:origem|retirada|remetente|destino|entrega|destinatario)$/.test(k)){
  const location=local(/destino|entrega|destinatario/.test(k)?d.entrega:d.retirada),field=/^(?:uf|estado) /.test(k)?'uf':'cidade'
  return location?.[field]?{tipo:'resposta',texto:location[field]}:{tipo:'revisao'}
 }else return null
 return typeof value==='number'&&Number.isFinite(value)&&value>0?{tipo:'resposta',texto:(k.startsWith('valor ')?value.toFixed(2):String(value)).replace('.',',')}:{tipo:'revisao'}
}
