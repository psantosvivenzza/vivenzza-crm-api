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
 // Escolha SOMENTE para simular coleta; nunca agendamento.
 if(compact==='coleta (essa opcao nao gera coleta automaticamente) 1 - a mercadoria sera coletada pela tw 2 - a mercadoria sera levada ate uma base da tw')return d.retirada?.endereco&&/^\d{8}$/.test(d.retirada?.cep||'')&&d.entrega?.endereco?{tipo:'resposta',texto:'1'}:{tipo:'revisao'}
 if(/^insira a sigla do estado brasileiro para o qual necessita atendimento \(exemplo: rs, sp, am\)\.\s*0: retornar$/.test(compact)){
  const value=local(d.retirada)?.uf
  return value?{tipo:'resposta',texto:value}:{tipo:'revisao'}
 }
 const k=compact.replace(/^(?:(?:por favor|por gentileza)[, ]*)?(?:informe|digite|insira|qual e)\s+/,'').replace(/\s*\((?:somente|apenas) numeros\)\s*$/,'').replace(/[():?]/g,' ').replace(/\s+/g,' ').replace(/^[oa] /,'').replace(/[.! ]+$/,'').trim()
 let value
 if(/^peso(?: bruto)? total(?: da carga)?(?:(?: em)? kg)?$/.test(k))value=d.peso_kg
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
