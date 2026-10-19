// Captura conservadora de preço explícito de FRETE em texto, nunca valor da carga.
// Não confirma taxas, prazo, validade ou contratação, e não interpreta anexos.
export function extrairPropostaTextualFrete(texto){
 if(typeof texto!=='string'||texto.length>2000)return null
 const t=texto.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()
 if(!/\bcotacao de frete gravada|\bvalor total (?:do )?frete|\btotal (?:do )?frete/.test(t))return null
 if(/mercadoria|valor transportado|\bcarga\b|declarad|nota fiscal|estimativ|estimad|aproxim|a partir|desconto|\bnao\b|\bsomente\b|\bacrescent|\bmais\b|\+|por\s*(?:kg|quilo|volume|unidade|tonelada|palete|pallet|caixa)|\/\s*kg|\b(?:seguro|pedagio|icms|taxas?)\b/.test(t))return null
 if((texto.match(/r\$/gi)||[]).length!==1)return null
 const raw=texto.normalize('NFD').replace(/[\u0300-\u036f]/g,'')
 const match=raw.match(/\b(?:cotacao de frete gravada:\s*([a-z0-9-]{1,100})\s*|(?:valor )?total (?:do )?frete\s*[:=-]?\s*)r\$\s*((?:\d{1,3}(?:\.\d{3})+|\d+),\d{2})(?!\d|[.,]\d)/i)
 if(!match)return null
 const cents=Number(match[2].replace(/[.,]/g,''))
 if(!Number.isSafeInteger(cents)||cents<=0||cents>100000000000)return null
 const protocol=match[1]||raw.match(/protocolo\s*[:#-]\s*([a-z0-9-]{1,100})/i)?.[1]
 return {valor_total:cents/100,protocolo:protocol||null}
}
