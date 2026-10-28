import test from 'node:test'
import assert from 'node:assert/strict'
import {baixarAnexoFrete,transcreverAnexoFrete,preservarAnexoFrete} from '../../src/lib/fretes/attachments.js'
test('download usa somente Evolution financeiro e valida tipo/conteudo/tamanho',async()=>{
 const message={key:{id:'test',fromMe:false},message:{documentMessage:{mimetype:'application/pdf',url:'NAO_BUSCAR_URL',mediaKey:'NAO_PROPAGAR'}}},pdf=Buffer.from('%PDF-1.4\nSINTETICO').toString('base64')
 const out=await baixarAnexoFrete(message,{post:async(path,body)=>{assert.equal(path,'/chat/getBase64FromMediaMessage/vivenzza-financeiro');assert.deepEqual(body.message,{key:{id:'test',remoteJid:undefined,fromMe:false}});assert.doesNotMatch(JSON.stringify(body),/NAO_BUSCAR|NAO_PROPAGAR/);return {data:{mimetype:'application/pdf',base64:pdf}}}})
 assert.equal(out.conteudo_base64,pdf);assert.match(out.sha256,/^[a-f0-9]{64}$/)
 for(const data of [{mimetype:'text/html',base64:Buffer.from('<html>').toString('base64')},{mimetype:'application/pdf',base64:Buffer.from('FALSO').toString('base64')},{mimetype:'application/pdf',base64:'!!!!!'}])await assert.rejects(baixarAnexoFrete(message,{post:async()=>({data})}))
 await assert.rejects(baixarAnexoFrete({key:{id:'test',fromMe:true}}))
 for(const mimetype of ['audio/ogg','video/mp4','application/zip'])await assert.rejects(baixarAnexoFrete({key:{id:'test'},message:{file:{mimetype}}},{post:()=>{throw Error('NÃO DEVE BAIXAR')}}),/anexo_tipo_tamanho/)
})
test('preserva bytes privados mesmo se OCR falhar e reentrega nao repete processamento',async()=>{
 const rows=[],msg={cotacao_id:'c'}
 const db={from(table){let operation='select',value;const q={select(){return q},eq(){return q},limit(){return q},single(){return q},insert(v){operation='insert';value=v;return q},update(v){operation='update';value=v;return q},then(resolve){if(table==='frete_mensagens')return Promise.resolve({data:msg}).then(resolve);if(operation==='insert')rows.push(value);if(operation==='update')Object.assign(rows[0],value);return Promise.resolve({data:rows,error:null}).then(resolve)}};return q}}
 let downloaded=0
 const options={download:async()=>{downloaded++;return {conteudo_base64:'SYNTHETIC',mimetype:'application/pdf',sha256:'hash'}},transcribe:async()=>{throw Error('OCR falhou')}}
 assert.equal(await preservarAnexoFrete(db,'m',{},options),null)
 assert.equal(rows[0].conteudo_base64,'SYNTHETIC');assert.equal(rows[0].status,'revisao');assert.equal(rows[0].cotacao_id,'c')
 assert.equal(await preservarAnexoFrete(db,'m',{},options),null);assert.equal(downloaded,1)
})
test('transcricao nao tem ferramentas e rejeita truncamento',async()=>{
 const anexo={mimetype:'application/pdf',conteudo_base64:'SYNTHETIC'}
 const client={messages:{create:async args=>{assert.equal(args.tools,undefined);assert.match(args.system,/NÃO CONFIÁVEL/);assert.equal(args.messages[0].content[0].type,'document');return {stop_reason:'end_turn',content:[{type:'text',text:'Total frete: R$ 100,00'}]}}}}
 assert.equal(await transcreverAnexoFrete(anexo,{client}),'Total frete: R$ 100,00')
 await assert.rejects(transcreverAnexoFrete(anexo,{client:{messages:{create:async()=>({stop_reason:'max_tokens'})}}}))
})
