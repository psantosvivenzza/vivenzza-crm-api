import {extrairPropostaTextualFrete} from './proposal.js'
const norm=t=>t.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim()
export function extrairProgressoFrete(texto){
 if(typeof texto!=='string'||texto.length>30000)return {}
 const campos={},values={}
 const restricao=/\b(?:exceto|estimad\w*|aproxim\w*|nao inclui|nao inclus\w*|a parte|adiciona\w*|acresci\w*)\b|por (?:kg|quilo|volume|unidade)|\/kg/.test(norm(texto))
 for(const raw of texto.split(/\r?\n/)){
  const t=norm(raw),price=extrairPropostaTextualFrete(raw)
  if(price&&!restricao){(values.valor_total??=[]).push(price.valor_total);if(price.protocolo)(values.protocolo??=[]).push(price.protocolo)}
  const prazo=t.match(/^(?:prazo(?: de entrega)?|previsao(?: de entrega)?)(?:\s*[:=-]| de)?\s*(\d{1,3})\s*dias?\s*uteis\.?$/)
  if(prazo&&Number(prazo[1])<=365)(values.prazo_dias??=[]).push(Number(prazo[1]))
  const dates=[...t.matchAll(/\b(\d{2})\/(\d{2})\/(\d{4}|\d{2})\b/g)]
  const dateUnique=new Set(dates.map(m=>m[0])).size===1
  const labeled=/\bvalidade\b|\b(?:cotacao|proposta|frete)\s+valid[ao]\b/.test(t)&&dateUnique&&dates.length===1&&!/nao|cancelad|vencid/.test(t)&&/(?:ate(?: o dia| dia)?|validade(?: da cotacao)?\s*[:=-]?)\s*\d{2}\/\d{2}\/(?:\d{4}|\d{2})[.!]?\s*$/.test(t)
  const strict=t.match(/^validade(?: da (?:cotacao|proposta))?\s*[:=-]?\s*(\d{2})\/(\d{2})\/(\d{4})(?:\s*(?:ate|as)?\s*(\d{2}):(\d{2}))?\.?$/)
  const validade=strict||(labeled?[null,dates[0][1],dates[0][2],dates[0][3].length===2?'20'+dates[0][3]:dates[0][3]]:null)
  if(validade){
   const [,d,m,y,h='23',min='59']=validade,iso=`${y}-${m}-${d}T${h}:${min}:00-03:00`,date=new Date(iso)
   if(+m>=1&&+m<=12&&+d>=1&&+d<=new Date(Date.UTC(+y,+m,0)).getUTCDate()&&+h<24&&+min<60&&Number.isFinite(+date))(values.validade??=[]).push(date.toISOString())
  }
  if(!restricao&&/^(?:todas as taxas (?:estao )?inclusas|valor total (?:ja )?inclui todas as taxas|total com todas as taxas inclusas)[.!]?$/.test(t))values.taxas_inclusas=[true]
 }
 for(const [k,vs] of Object.entries(values))if(new Set(vs).size===1)campos[k]=vs[0]
 return campos
}
export function solicitarPendenciasFrete(q){
 const campos=[]
 if(q.valor_total==null||q.proposta_evidencias?.anexo_valor_total)campos.push('valor TOTAL do frete em R$, incluindo todas as taxas')
 if(q.prazo_dias==null||q.proposta_evidencias?.anexo_prazo_dias)campos.push('prazo de entrega em dias úteis')
 if(!q.validade||Date.parse(q.validade)<=Date.now()||q.proposta_evidencias?.anexo_validade)campos.push('validade da cotação com data (dd/mm/aaaa)')
 if(!q.proposta_evidencias?.taxas_inclusas)campos.push('confirmação de que todas as taxas estão inclusas')
 if(campos.length===1&&campos[0]==='confirmação de que todas as taxas estão inclusas')return `Confirma que o total de ${Number(q.valor_total).toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}, prazo de ${q.prazo_dias} dias úteis e validade até ${new Date(q.validade).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'})} inclui TODAS as taxas? Apenas cotação, sem contratação ou agendamento de coleta.`
 return campos.length?`Obrigado! Para concluir a comparação, falta informar: ${campos.join('; ')}. É apenas cotação, sem contratação ou agendamento de coleta.`:null
}
export function confirmouTaxasFrete(texto,q,ultima){
 if(!/^(?:sim|sim,? todas as taxas inclusas|confirmo)[.!]?$/i.test(String(texto||'').trim()))return false
 if(q.valor_total==null||q.prazo_dias==null||!q.validade||Date.parse(q.validade)<=Date.now()||q.proposta_evidencias?.taxas_inclusas)return false
 if(['valor_total','prazo_dias','validade'].some(k=>q.proposta_evidencias?.['anexo_'+k]))return false
 return ultima?.status==='enviado'&&Boolean(ultima.provider_id)&&ultima.texto===solicitarPendenciasFrete(q)
}
