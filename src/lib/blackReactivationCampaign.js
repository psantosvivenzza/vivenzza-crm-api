import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
export const BLACK_CAMPAIGN_ID = 'black-vivenzza-20261106'
const TEXT = "Oi! Tudo bem? \ud83d\udda4 Aqui \u00e9 da Vivenzza Professional.\n\nA *Black Vivenzza* \u00e9 para *sal\u00f5es de beleza e distribuidores*! Abaste\u00e7a seu sal\u00e3o ou sua opera\u00e7\u00e3o de revenda com produtos profissionais.\n\n*Quer receber nosso cat\u00e1logo e consultar as condi\u00e7\u00f5es comerciais para o seu neg\u00f3cio?*\n\nSe preferir n\u00e3o receber novidades, responda *SAIR*."
const HASH = 'e1b577bcbdbfdbf9b386ee4d0bd9ecd2ae5737e82bca0fe7041700a5c7cab630'
let pending
export async function loadReactivationCampaign(id) {
  if (id === undefined) return null
  if (id !== BLACK_CAMPAIGN_ID) throw Object.assign(Error('Campanha de reativação inválida.'),{code:'INVALID_REACTIVATION_CAMPAIGN'})
  pending ??= readFile(new URL('../assets/black-vivenzza-20261106.png',import.meta.url)).then(image=>{
    if(image.length>5*1024*1024 || createHash('sha256').update(image).digest('hex')!==HASH) throw Error('CAMPAIGN_ASSET_UNCONFIRMED')
    return Object.freeze({id:BLACK_CAMPAIGN_ID,text:TEXT,media:'data:image/png;base64,'+image.toString('base64')})
  }).catch(error=>{pending=undefined;throw error})
  return pending
}
