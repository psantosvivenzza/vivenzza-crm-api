// Somente conteúdo visível. IDs de botões nunca viram comandos ou URLs.
export function lerEnvelopeFrete(msg) {
 let c=msg?.message||{}
 for(let i=0;i<4;i++){
  const next=c.ephemeralMessage?.message||c.viewOnceMessage?.message||c.viewOnceMessageV2?.message||c.documentWithCaptionMessage?.message
  if(!next)break
  c=next
 }
 const menu=c.listMessage||c.buttonsMessage
 if(menu){
  const rows=c.listMessage?(menu.sections||[]).flatMap(s=>s.rows||[]):menu.buttons||[]
  const labels=rows.slice(0,30).map((r,i)=>`${i+1} - ${String(r.title||r.buttonText?.displayText||'').replace(/[\r\n]/g,' ').slice(0,100)}`)
  return {texto:[menu.contentText||menu.description||'',...labels].join('\n').slice(0,5000),mediaTipo:null,mediaMessage:null,interativo:true}
 }
 for(const [key,tipo] of [['documentMessage','document'],['imageMessage','image'],['audioMessage','audio'],['videoMessage','video']])if(c[key]){
  return {texto:c[key].caption||`[arquivo: ${c[key].fileName||tipo}]`,mediaTipo:tipo,mediaMessage:{key:msg.key,message:{[key]:c[key]}},interativo:false}
 }
 return {texto:c.conversation??c.extendedTextMessage?.text??null,mediaTipo:null,mediaMessage:null,interativo:false}
}
