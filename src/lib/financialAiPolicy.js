const intents=new Set(['QUERO_PAGAR','PRECISO_BOLETO_PIX','PEDIDO_NOVA_DATA','SEM_CONDICAO_AGORA','JA_PAGUEI','CONTESTA_VALOR','QUERO_ATENDENTE','DUVIDA_GERAL','UNKNOWN'])
export function financialReply({classification,text,pix}) {
  if(/parcel|desconto|acordo|negoci|segunda\s+via|2[ªaºo]?\s*via|nota\s*fiscal|\bnf\b/i.test(text)) return {human:true,reply:'Vou encaminhar sua solicitação à equipe financeira para conferir os documentos e as condições corretas.'}
  if(!classification || !intents.has(classification.intent) || classification.confidence!=='alta' || classification.cliente_irritado!==false) return {human:true,reply:'Vou encaminhar sua mensagem à equipe financeira para conferir com segurança.'}
  switch(classification.intent) {
    case 'QUERO_PAGAR': case 'PRECISO_BOLETO_PIX':
      if(/boleto|segunda\s+via/i.test(text) || !/^\d{14}$/.test(pix||'')) return {human:true,reply:'A equipe financeira vai conferir e informar o documento de pagamento correto por aqui.'}
      return {human:false,reply:`O PIX da Vivenzza Professional é o CNPJ ${pix}. Confira o favorecido no seu banco antes de confirmar. Se já pagou, pode avisar por aqui para a equipe conferir a baixa.`}
    case 'PEDIDO_NOVA_DATA': return {human:true,reply:'Recebi sua proposta de data. A equipe financeira precisa confirmar a possibilidade; esta mensagem não altera o vencimento nem confirma um acordo.'}
    case 'JA_PAGUEI': return {human:true,reply:'Obrigado pelo aviso. A equipe financeira vai conferir o pagamento. Se possível, envie o comprovante por aqui; o recebimento ainda precisa ser confirmado no sistema.'}
    case 'CONTESTA_VALOR': return {human:true,reply:'Vou encaminhar sua dúvida sobre o valor à equipe financeira para conferir antes de continuar.'}
    case 'QUERO_ATENDENTE': case 'SEM_CONDICAO_AGORA': case 'UNKNOWN': return {human:true,reply:'Vou encaminhar sua mensagem à equipe financeira para dar continuidade ao atendimento.'}
    default: return {human:false,reply:'Posso ajudar com as informações de pagamento. Você precisa do PIX, de um boleto ou de falar com a equipe financeira?'}
  }
}

// One durable reservation per received message; never resend an uncertain result.
export function createFinancialInboundProcessor({load,claim,guard,classify,prepare,send,finish,handoff}) {
 return async messageId=>{
  let input,run,attempted=false
  try {
   input=await load(messageId)
   if(!input)return {status:'not_eligible'}
   run=await claim(input)
   if(!run)return {status:'already_processed'}
   if(input.media){await handoff(input,'attachment_received');await finish(run,'blocked','attachment_received');return {status:'human_pending'}}
   const blocked=async()=>{await handoff(input,'guard_blocked');await finish(run,'blocked','guard_blocked');return {status:'human_pending'}}
   if(!await guard(input))return await blocked()
   const classification=await classify(input)
   const result=financialReply({classification,text:input.text,pix:input.pix})
   if(!await guard(input))return await blocked()
   await prepare(run,input)
   if(!await guard(input))return await blocked()
   // Takeover is durable even if the acknowledgement fails or its result is uncertain.
   if(result.human) await handoff(input,'human_review')
   attempted=true
   const receipt=await send(input,result.reply)
   if(!receipt?.providerId) throw Error('OUTCOME_UNCERTAIN')
   await finish(run,'sent',null,receipt.providerId)
   return {status:'sent',human:result.human}
  } catch {
   try{if(input)await handoff(input,attempted?'provider_outcome_uncertain':'pre_send_failed')}catch{console.error('[financial-ai] human_queue_unavailable')}
   try{if(run)await finish(run,attempted?'uncertain':'blocked',attempted?'provider_outcome_uncertain':'pre_send_failed')}catch{console.error('[financial-ai] journal_unavailable')}
   return {status:attempted?'uncertain':'blocked'}
  }
 }
}
