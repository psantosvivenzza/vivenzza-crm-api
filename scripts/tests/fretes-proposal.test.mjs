import test from 'node:test'
import assert from 'node:assert/strict'
import {extrairPropostaTextualFrete as extract} from '../../src/lib/fretes/proposal.js'
test('preco e protocolo explicitos de frete sao capturados sem completar proposta',()=>{
 assert.deepEqual(extract('Cotação de frete gravada: 12345678 R$ 365,00'),{valor_total:365,protocolo:'12345678'})
 assert.deepEqual(extract('Valor total do frete: R$ 1.234,56'),{valor_total:1234.56,protocolo:null})
 assert.deepEqual(extract('Cotação de frete gravada: AB12 R$ 365,00.'),{valor_total:365,protocolo:'AB12'})
})
test('moeda deve pertencer ao total do frete e nao seguro ou preco unitario',()=>{
 for(const suffix of ['por unidade','/kg','por tonelada','por palete','por caixa','aproximadamente','estimado','taxas à parte'])assert.equal(extract('Valor total do frete: R$ 10,00 '+suffix),null,suffix)
 for(const text of ['Subtotal frete: R$ 100,00','Total do frete a combinar. Valor transportado R$ 300,00','Total do frete da carga R$ 300,00'])assert.equal(extract(text),null,text)
 for(const text of ['Total do frete a combinar. Seguro R$ 45,00','Total do frete a combinar. Mercadoria R$ 300,00','Valor total do frete: R$ 10,00 por kg','Valor total do frete: R$ 50,00 + ICMS'])assert.equal(extract(text),null,text)
})
test('valor de mercadoria, somas, estimativas e formatos ambiguos nunca viram frete',()=>{
 for(const text of ['DADOS DO FRETE: Valor: R$ 3077.76','Valor da mercadoria R$ 3.077,76','Valor total do frete: R$ 200,00 mais taxas','Valor total do frete: R$ 200,00 + R$ 50,00','Valor total do frete: a partir de R$ 200,00','Valor total do frete: R$ 0,00','Valor total do frete: R$ 10,999','[mídia]'])assert.equal(extract(text),null,text)
})
