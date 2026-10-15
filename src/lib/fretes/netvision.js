import pg from 'pg'
import {configE01} from '../e01Host.js'

// Somente SELECTs, com tempo limitado e conexão encerrada em todos os caminhos.
export async function lerLogisticaNetvision(filial, numero, { client: injetado } = {}) {
 const emprestado=injetado&&typeof injetado.totalCount==='number'?await injetado.connect():null
 const client=emprestado || injetado || new pg.Client({...await configE01(),connectionTimeoutMillis:4000,statement_timeout:6000,query_timeout:6500})
 try {
  if(!injetado) await client.connect()
  if(!injetado||emprestado){await client.query('BEGIN READ ONLY');await client.query('SET LOCAL statement_timeout = 6000')}
  const {rows}=await client.query({text:`SELECT i."Sequencia",i."CodigoItem",i."Quantidade",i."Unidade",p."Un" AS "UnidadeCadastro",p."UnidadeManipulacao",p."PesoBruto",p."UnidadePeso",p."QtdeVolumeCubico",p."StatusMedidasCubicas"
   FROM "ES_ItemPedido" i LEFT JOIN "ES_ItensEstoque" p ON p."CodigoItem"=i."CodigoItem"
   WHERE i."CodigoFilial"=$1 AND i."NumeroPedido"=$2 AND i."TipoPedido"='V' ORDER BY i."Sequencia" LIMIT 1001`,values:[filial,numero],query_timeout:6500})
  if(!rows.length)throw Error('Logística sem itens disponíveis')
  if(rows.length>1000 || new Set(rows.map(r=>r.Sequencia)).size!==rows.length) throw Error('Itens ambíguos ou excessivos')
  return {itens:rows,unidades:{peso:null,cubagem:null},consultado_em:new Date().toISOString()}
 } finally {if(!injetado||emprestado)await client.query('ROLLBACK').catch(()=>{});if(emprestado)emprestado.release();else if(!injetado)await client.end().catch(()=>{})}
}
