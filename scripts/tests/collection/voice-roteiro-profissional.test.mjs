import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
// Contrato textual: sem importar o cerebro, que carrega cliente de banco.
const prompt = readFileSync(new URL('../../../src/lib/voice/voiceBrain.js', import.meta.url), 'utf8')
import { fraseDespedida, FRASE_TRANSFERIR_HUMANO } from '../../../src/lib/voice/saudacao.js'

test('roteiro faz uma pergunta por vez e exige contexto verificado', () => {
  assert.match(prompt, /UMA pergunta por vez/)
  assert.match(prompt, /nunca invente esses dados/)
  assert.match(prompt, /Você pode falar agora/)
  assert.match(prompt, /O pagamento precisa ser conferido/)
})
test('encerramentos não prometem tarefas ou retorno sem registro', () => {
  for (const texto of [fraseDespedida(), FRASE_TRANSFERIR_HUMANO]) {
    assert.doesNotMatch(texto, /vou registrar|retorna depois|entra em contato com você/i)
    assert.doesNotMatch(texto, /\b(dívida|débito|vencimento|boleto)\b/i)
  }
})
