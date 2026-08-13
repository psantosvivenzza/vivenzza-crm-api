// Voice AI OUTBOUND INTERNAL MVP — testa só a lógica PURA de guard/payload
// (outboundInternalTest.js), sem nenhuma chamada de rede/ARI e sem jamais
// fazer o telefone tocar. Complementa (não substitui) a validação humana
// por ligação real.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  ENDPOINT_PERMITIDO,
  validarDestinoPermitido,
  construirPayloadOriginate,
  avaliarChamadaJaAtiva,
  avaliarEndpointOnline,
  classificarCausaSemAtendimento,
} from '../../../src/lib/voice/outboundInternalTest.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(__dirname, '..', '..', '..', 'src')
const SCRIPTS = path.join(__dirname, '..', '..', '..', 'scripts')

test('VOICE AI OUTBOUND INTERNAL: guard de destino é fail-closed', () => {
  assert.doesNotThrow(() => validarDestinoPermitido('PJSIP/7001'))

  for (const destinoProibido of ['PJSIP/9999', 'SIP/trunk/5511999999999', 'PJSIP/0800123456', 'Local/1000@from-internal', '']) {
    assert.throws(() => validarDestinoPermitido(destinoProibido), `deveria bloquear destino "${destinoProibido}"`)
  }
})

test('VOICE AI OUTBOUND INTERNAL: payload de originate nunca referencia telefone/cliente/financeiro real', () => {
  const payload = construirPayloadOriginate('vivenzza-voice-ai')
  assert.equal(payload.endpoint, ENDPOINT_PERMITIDO)
  assert.equal(payload.endpoint, 'PJSIP/7001')
  assert.equal(payload.app, 'vivenzza-voice-ai')
  assert.ok(payload.timeout > 0 && payload.timeout <= 60, 'timeout deve ser um valor de teste razoável, não -1 (sem timeout)')

  const payloadTexto = JSON.stringify(payload)
  for (const proibido of ['contas_financeiras', 'cliente_id', 'promessa', 'boleto', 'pix', 'trunk', 'PSTN']) {
    assert.equal(payloadTexto.toLowerCase().includes(proibido.toLowerCase()), false, `payload não deveria conter "${proibido}"`)
  }
})

test('VOICE AI OUTBOUND INTERNAL: guard de concorrência bloqueia com qualquer canal ativo', () => {
  assert.equal(avaliarChamadaJaAtiva([]), false)
  assert.equal(avaliarChamadaJaAtiva(null), false)
  assert.equal(avaliarChamadaJaAtiva(undefined), false)
  assert.equal(avaliarChamadaJaAtiva([{ id: 'abc' }]), true)
  assert.equal(avaliarChamadaJaAtiva([{ id: 'abc' }, { id: 'def' }]), true)
})

test('VOICE AI OUTBOUND INTERNAL: guard de endpoint exige state=online explicitamente', () => {
  assert.equal(avaliarEndpointOnline({ state: 'online' }), true)
  assert.equal(avaliarEndpointOnline({ state: 'offline' }), false)
  assert.equal(avaliarEndpointOnline({ state: 'unknown' }), false)
  assert.equal(avaliarEndpointOnline(null), false)
  assert.equal(avaliarEndpointOnline(undefined), false)
})

test('VOICE AI OUTBOUND INTERNAL: classificação de causa sem atendimento', () => {
  assert.equal(classificarCausaSemAtendimento(17), 'BUSY')
  assert.equal(classificarCausaSemAtendimento(18), 'NO_ANSWER')
  assert.equal(classificarCausaSemAtendimento(19), 'NO_ANSWER')
  assert.equal(classificarCausaSemAtendimento(16), 'CANCELLED')
  assert.equal(classificarCausaSemAtendimento(21), 'FAILED')
  assert.equal(classificarCausaSemAtendimento(undefined), 'FAILED')
})

test('VOICE AI OUTBOUND INTERNAL: prova estática — sem trunk/PSTN/cliente real/mutação financeira, sem hardcode de outro destino', () => {
  const arquivos = [
    path.join(SRC, 'lib/voice/outboundInternalTest.js'),
    path.join(SCRIPTS, 'voice/trigger-outbound-test.mjs'),
  ]
  for (const arquivo of arquivos) {
    const conteudo = fs.readFileSync(arquivo, 'utf8')
    for (const proibido of ['evolutionAdapter', 'evolutionFinanceiro', 'sendText', '.rpc(', 'execute_sql', "from('contas_financeiras')", "from('collection_promises')", "from('collection_dispatches')"]) {
      assert.equal(conteudo.includes(proibido), false, `${path.basename(arquivo)} não deveria referenciar "${proibido}"`)
    }
    // único endpoint literal permitido em todo o código outbound é PJSIP/7001
    const endpointsLiterais = [...conteudo.matchAll(/PJSIP\/\d+/g)].map((m) => m[0])
    for (const ep of endpointsLiterais) {
      assert.equal(ep, 'PJSIP/7001', `${path.basename(arquivo)} referencia um endpoint diferente do permitido: ${ep}`)
    }
  }

  const ariCallService = fs.readFileSync(path.join(SRC, 'lib/voice/ariCallService.js'), 'utf8')
  const endpointsLiterais = [...ariCallService.matchAll(/PJSIP\/\d+/g)].map((m) => m[0])
  for (const ep of endpointsLiterais) {
    assert.equal(ep, 'PJSIP/7001', `ariCallService.js referencia um endpoint diferente do permitido: ${ep}`)
  }
})
