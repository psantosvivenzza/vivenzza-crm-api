const STATES=['pendente','enviado','entregue','lido','reproduzido']
const MAP={1:'pendente',2:'enviado',3:'entregue',4:'lido',5:'reproduzido',PENDING:'pendente',SERVER_ACK:'enviado',DELIVERY_ACK:'entregue',READ:'lido',PLAYED:'reproduzido'}
// Dedicated campaign receipts only. Atomic lower-or-equal filter prevents late
// SERVER_ACK from erasing a prior delivery/read confirmation under concurrency.
export async function applySiteCampaignReceipts(db,event,instance){
 if(!instance || (event?.instance??event?.instanceName)!==instance || event.event!=='messages.update')throw Error('invalid_campaign_receipt_context')
 const updates=Array.isArray(event.data)?event.data:[event.data]
 for(const update of updates){
  const id=update?.keyId??update?.key?.id
  const status=MAP[update?.status??update?.update?.status]
  if(typeof id!=='string'||!id||!status)continue
  const {error}=await db.from('whatsapp_mensagens').update({status}).eq('evolution_id',id).eq('instance_name',instance).eq('direcao','saida').in('status',STATES.slice(0,STATES.indexOf(status)+1))
  if(error)throw Error('campaign_receipt_persistence_failed')
 }
}
