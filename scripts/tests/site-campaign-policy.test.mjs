import test from 'node:test'
import assert from 'node:assert/strict'
import { siteCampaignContext, siteCampaignInstructions, isStopRequest, enforceSiteCampaignReply } from '../../src/lib/siteCampaignPolicy.js'
const env = { SDR_SITE_ENABLED: 'true', SDR_SITE_INSTANCE: 'Mesagens Site Reativação', EVOLUTION_INSTANCE: 'vivenzza' }
test('accepts only explicitly enabled dedicated instance', () => {
  assert.equal(siteCampaignContext({instance:'vivenzza'}, env), null)
  assert.equal(siteCampaignContext({instance:'vivenzza-financeiro'}, env), null)
  assert.equal(siteCampaignContext({instance:env.SDR_SITE_INSTANCE}, {...env, SDR_SITE_ENABLED:'false'}), null)
  assert.equal(siteCampaignContext({instance:env.SDR_SITE_INSTANCE}, {...env, SDR_SITE_INSTANCE:''}), null)
  assert.equal(siteCampaignContext({instance:'vivenzza'}, {...env, SDR_SITE_INSTANCE:'vivenzza'}), null)
  assert.equal(siteCampaignContext({instance:env.SDR_SITE_INSTANCE}, env).instance, env.SDR_SITE_INSTANCE)
})
test('coupon remains valid after October 30 and expires November 6 in Brasilia', () => {
  assert.match(siteCampaignInstructions(new Date('2026-11-01T12:00:00Z')), /período de validade/)
  assert.match(siteCampaignInstructions(new Date('2026-11-07T02:59:59Z')), /período de validade/)
  assert.match(siteCampaignInstructions(new Date('2026-11-07T03:00:00Z')), /cupom venceu/)
})
test('stop requests do not become sales replies', () => {
  for (const text of ['SAIR','não quero mais receber','pare de mandar mensagem','remova meu número']) assert.equal(isStopRequest(text), true)
  assert.equal(isStopRequest('quero comprar uma máscara'), false)
})

test('sair inside a shopping question is not an opt-out',()=>{for(const s of ['vai sair quando?','não consigo sair do carrinho','quero sair com a escova progressiva']) assert.equal(isStopRequest(s),false)})
test('recognizes stop requests without the word mais',()=>{for(const s of ['não quero receber','não me chame','para de me mandar','pare','cancelar'])assert.equal(isStopRequest(s),true)})
test('delivery instructions and double negatives are not opt-outs',()=>{for(const s of ['não envie para outro endereço','não pare de me mandar ofertas'])assert.equal(isStopRequest(s),false)})
test('expired promotion is removed after model generation',()=>{assert.match(enforceSiteCampaignReply('Use VOLTE10 com 10% de desconto',new Date('2026-11-08')),/encerrou/);assert.equal(enforceSiteCampaignReply('Qual o seu tipo de cabelo?',new Date('2026-11-08')),'Qual o seu tipo de cabelo?')})
