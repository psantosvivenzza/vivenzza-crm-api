import test from 'node:test'
import assert from 'node:assert/strict'
import {applySiteCampaignReceipts} from '../../src/lib/siteCampaignReceipts.js'
function fixture(status='enviado',instance='site',direction='saida'){
 const row={status,evolution_id:'id',instance_name:instance,direcao:direction};let writes=0
 const db={from(table){assert.equal(table,'whatsapp_mensagens');let patch,filters=[];const q={update(p){patch=p;return q},eq(k,v){filters.push(r=>r[k]===v);return q},in(k,v){filters.push(r=>v.includes(r[k]));return q},then(resolve){if(filters.every(f=>f(row))){Object.assign(row,patch);writes++}return resolve({error:null})}};return q}}
 return {row,db,writes:()=>writes}
}
const event=status=>({instance:'site',event:'messages.update',data:{keyId:'id',status}})
test('late server and pending acknowledgements cannot downgrade delivery or read',async()=>{const f=fixture();for(const s of ['DELIVERY_ACK','SERVER_ACK','PENDING','READ','DELIVERY_ACK','SERVER_ACK'])await applySiteCampaignReceipts(f.db,event(s),'site');assert.equal(f.row.status,'lido')})
test('played remains the strongest status for numeric and nested updates',async()=>{const f=fixture('reproduzido');await applySiteCampaignReceipts(f.db,{...event(3),data:[{key:{id:'id'},update:{status:3}},{keyId:'id',status:4}]},'site');assert.equal(f.row.status,'reproduzido')})
test('same message id in another instance or inbound row is untouched',async()=>{for(const f of [fixture('enviado','commercial'),fixture('enviado','site','entrada')]){await applySiteCampaignReceipts(f.db,event('DELIVERY_ACK'),'site');assert.equal(f.writes(),0)}})
test('foreign context rejected and unknown statuses ignored',async()=>{const f=fixture();await assert.rejects(()=>applySiteCampaignReceipts(f.db,event('READ'),'other'));await applySiteCampaignReceipts(f.db,event('UNKNOWN'),'site');assert.equal(f.writes(),0)})
test('database failure is propagated rather than acknowledged',async()=>{const db={from(){const q={update:()=>q,eq:()=>q,in:()=>q,then:r=>r({error:{code:'db'}})};return q}};await assert.rejects(()=>applySiteCampaignReceipts(db,event('READ'),'site'),/receipt_persistence/)})
