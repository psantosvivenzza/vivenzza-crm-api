import {isDeepStrictEqual} from 'node:util'
import {supabase} from '../lib/supabase-admin.server.js'

// Suplemento limitado, depois do sync comercial. Nunca atualiza preço/estoque.
export async function sincronizarLogisticaProdutos({e01Client,db=supabase,peso=null,cubagem=null,maxAtualizacoes=500,maxTempoMs=30000}={}) {
 const deadline=Date.now()+maxTempoMs
 const bounded=q=>q.abortSignal(AbortSignal.timeout(Math.max(1,Math.min(5000,deadline-Date.now()))))
 const probe=await bounded(db.from('produtos').select('logistica_fisica').limit(1))
 if(probe.error)return {status:'schema_indisponivel',atualizados:0}
 const rows=[];let catalogoCompleto=false
 for(let offset=0;Date.now()<deadline;offset+=500){
  const page=await e01Client.query({text:`SELECT "CodigoItem","Un" AS "UnidadeCadastro","Peso","PesoBruto","UnidadePeso","QtdeVolumeCubico","StatusMedidasCubicas","ComprimentoItem","LarguraItem","AlturaItem" FROM "ES_ItensEstoque" ORDER BY "CodigoItem" LIMIT 500 OFFSET $1`,values:[offset],query_timeout:Math.max(1,Math.min(5000,deadline-Date.now()))})
  rows.push(...page.rows)
  if(page.rows.length<500){catalogoCompleto=true;break}
 }
 const existentes=[];let existentesCompleto=false
 for(let offset=0;Date.now()<deadline;offset+=500){
  const result=await bounded(db.from('produtos').select('id,legacy_id,logistica_fisica').not('legacy_id','is',null).order('id').range(offset,offset+499))
  if(result.error)throw result.error
  existentes.push(...(result.data??[]))
  if((result.data?.length??0)<500){existentesCompleto=true;break}
 }
 const grupos=new Map(),fontes=new Map()
 for(const p of existentes){const key=String(p.legacy_id).trim();grupos.set(key,[...(grupos.get(key)??[]),p])}
 for(const row of rows){const key=String(row.CodigoItem??'').trim();fontes.set(key,[...(fontes.get(key)??[]),row])}
 const codigosPeso=new Set(rows.map(r=>r.UnidadePeso)),statusCubo=new Set(rows.map(r=>r.StatusMedidasCubicas))
 const uniforme=set=>catalogoCompleto&&set.size===1&&!set.has(null)&&!set.has(undefined)
 const pesoNormal=String(peso??'').trim().toLowerCase(),cuboNormal=String(cubagem??'').trim().toLowerCase()
 const unidades={peso:uniforme(codigosPeso)&&['kg','g'].includes(pesoNormal)?pesoNormal:null,cubagem:uniforme(statusCubo)&&['m3','cm3','litro'].includes(cuboNormal)?cuboNormal:null}
 let atualizados=0,falhas=0,preservados=0,semAlteracao=0,pendentes=0
 for(const [codigo,registros] of fontes){
  if(Date.now()>=deadline||atualizados>=maxAtualizacoes){pendentes++;continue}
  const candidatos=grupos.get(codigo)??[]
  if(!codigo||!candidatos.length)continue
  if(candidatos.length!==1||registros.length!==1){falhas++;continue}
  const p=candidatos[0],row=registros[0]
  if(p.logistica_fisica&&p.logistica_fisica.origem!=='netvision'){preservados++;continue}
  const novo={...row,origem:'netvision',unidades}
  const {sincronizado_em,...anterior}=p.logistica_fisica??{}
  if(isDeepStrictEqual(anterior,novo)){semAlteracao++;continue}
  let query=db.from('produtos').update({logistica_fisica:{...novo,sincronizado_em:new Date().toISOString()}}).eq('id',p.id)
  query=p.logistica_fisica==null?query.is('logistica_fisica',null):query.eq('logistica_fisica',JSON.stringify(p.logistica_fisica))
  const result=await bounded(query.select('id'))
  if(result.error)falhas++;else if(result.data?.length)atualizados+=result.data.length;else preservados++
 }
 return {status:falhas||pendentes||!catalogoCompleto||!existentesCompleto?'parcial':'concluido',atualizados,falhas,preservados,sem_alteracao:semAlteracao,pendentes,unidades_pendentes:!unidades.peso||!unidades.cubagem}
}
