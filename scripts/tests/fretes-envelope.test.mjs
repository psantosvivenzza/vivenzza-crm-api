import test from 'node:test'
import assert from 'node:assert/strict'
import {lerEnvelopeFrete} from '../../src/lib/fretes/envelope.js'
test('menus JSON malformados nao interrompem classificacao de dominio',()=>{
 for(const menu of [
  {listMessage:{description:'Menu',sections:{}}},
  {listMessage:{description:'Menu',sections:[null,{rows:{}},{rows:[null,{title:'Cotação'}]}]}},
  {buttonsMessage:{contentText:'Menu',buttons:{}}},
  {buttonsMessage:{contentText:'Menu',buttons:[null,{buttonText:{displayText:'Cotação'}}]}},
 ]) assert.doesNotThrow(()=>lerEnvelopeFrete({message:menu}))
})
test('lista e botoes preservam assunto visivel sem executar IDs',()=>{
 const m=lerEnvelopeFrete({message:{listMessage:{description:'Selecione',sections:[{rows:[{rowId:'secret-url',title:'Coleta'},{rowId:'outro',title:'Cotação'}]}]}}})
 assert.equal(m.texto,'Selecione\n1 - Coleta\n2 - Cotação');assert.equal(m.mediaTipo,null);assert.doesNotMatch(m.texto,/secret-url/)
 assert.match(lerEnvelopeFrete({message:{buttonsMessage:{contentText:'Escolha',buttons:[{buttonText:{displayText:'Cotação de Frete'}}]}}}).texto,/Cotação de Frete/)
})
test('documento com legenda e efemero preserva metadados reais, segredo nao vira texto',()=>{
 const key={id:'synthetic',remoteJid:'test@s.whatsapp.net',fromMe:false},doc={mimetype:'application/pdf',mediaKey:'NAO_EXIBIR',fileName:'proposta.pdf',caption:'Cotação'}
 const result=lerEnvelopeFrete({key,message:{ephemeralMessage:{message:{documentWithCaptionMessage:{message:{documentMessage:doc}}}}}})
 assert.equal(result.mediaTipo,'document');assert.equal(result.texto,'Cotação');assert.deepEqual(result.mediaMessage.message.documentMessage,doc)
 assert.equal(lerEnvelopeFrete({message:{secretEncryptedMessage:{}}}).texto,null)
})
