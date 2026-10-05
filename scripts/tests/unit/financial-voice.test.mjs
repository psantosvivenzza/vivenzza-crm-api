import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { consultarContextoFinanceiroVoz, centavos } from '../../../src/lib/voice/financialVoiceContext.js'
import { responderCobrancaVoz } from '../../../src/lib/voice/financialVoiceDialogue.js'

const titulo = { id: 'ficticio-1', codigo_cliente: 'ficticio', tipo: 'receber', status: 'vencida', valor: '123.45', valor_pago: '23.45', vencimento: '2026-09-01' }
function dependencias(overrides = {}) {
  return { buscarChamada: async () => ({ campanha: 'COBRANCA_FILA', direction: 'outbound', destination_type: 'EXTERNAL', codigo_cliente: 'ficticio', telefone_hash: 'hash-ficticio' }),
    hashTelefone: () => 'hash-ficticio', hoje: () => '2026-10-04',
    buscarTitulos: async () => [{ ...titulo }], guardGlobal: async () => ({ permitido: true }), guardTitulo: async () => ({ permitido: true }), ...overrides }
}
const consultar = deps => consultarContextoFinanceiroVoz({ callId: 'chamada-ficticia', numero: 'numero-ficticio' }, deps)
test('saldo parcial exato em centavos, somente leitura', async () => {
  assert.equal(centavos('0.29'), 29)
  assert.equal((await consultar(dependencias())).saldoCentavos, 10000)
  assert.throws(() => centavos('1.001'))
})
for (const motivo of ['pagamento', 'promessa', 'DNC']) test(`bloqueia ${motivo}`, async () => {
  assert.equal((await consultar(dependencias({ guardTitulo: async () => ({ permitido: false }) }))).permitido, false)
})
test('bloqueia sync antigo, chamada sem vínculo e erro', async () => {
  for (const override of [ { guardGlobal: async () => ({ permitido: false }) }, { buscarChamada: async () => null }, { hashTelefone: () => 'outro' }, { buscarTitulos: async () => { throw Error('indisponivel') } } ]) {
    assert.equal((await consultar(dependencias(override))).permitido, false)
  }
})
test('pagamento durante reconsulta, revisão e duplicidade bloqueiam', async () => {
  for (const dados of [[{ ...titulo, valor_pago: '123.45' }], [{ ...titulo, em_revisao_financeira: true }], [titulo, titulo]]) {
    assert.equal((await consultar(dependencias({ buscarTitulos: async () => dados }))).permitido, false)
  }
  let leitura = 0
  assert.equal((await consultar(dependencias({ buscarTitulos: async () => ++leitura === 1 ? [titulo] : [] }))).permitido, false)
})
test('conversa completa exige identidade e disponibilidade antes do valor', async () => {
  const estado = { responsavelConfirmado: false }
  let consultas = 0
  const carregar = async () => { consultas++; return { permitido: true, saldoCentavos: 10000, vencimento: '2026-09-01' } }
  assert.doesNotMatch((await responderCobrancaVoz('quem fala?', estado, carregar)).respostaTexto, /saldo|R\$/)
  assert.match((await responderCobrancaVoz('sim', estado, carregar)).respostaTexto, /conversar agora/)
  assert.equal(consultas, 0)
  assert.match((await responderCobrancaVoz('sim', estado, carregar)).respostaTexto, /100,00.*01\/09\/2026/)
  const pago = await responderCobrancaVoz('já paguei', estado, carregar)
  assert.equal(pago.requiresHuman, true)
  assert.doesNotMatch(pago.respostaTexto, /R\$|registrado|baixado/)
})
test('divergência, humano, indisponibilidade e mudança de saldo não inventam ações', async () => {
  for (const fala of ['não reconheço', 'quero atendente']) {
    const r = await responderCobrancaVoz(fala, { responsavelConfirmado: true }, async () => { throw Error('não consultar') })
    assert.equal(r.requiresHuman, true)
  }
  const estado = { responsavelConfirmado: true, etapaFinanceira: 'disponibilidade' }
  assert.equal((await responderCobrancaVoz('não', estado, async () => { throw Error() })).intent, 'SEM_DISPONIBILIDADE')
  assert.equal((await responderCobrancaVoz('sim', estado, async () => ({ permitido: false }))).intent, 'CONFERENCIA_FINANCEIRA')
})
test('integração reserva turnos suficientes e nunca envia saldo no canal', () => {
  const ari = readFileSync(new URL('../../../src/lib/voice/ariCallService.js', import.meta.url), 'utf8')
  const fila = readFileSync(new URL('../../voice/rodar-fila-cobranca.mjs', import.meta.url), 'utf8')
  assert.match(ari, /numeroCobranca \? Math\.max\(MAX_TURNOS, 6\)/)
  assert.match(ari, /carregarContextoFinanceiroVoz\(\{ callId: channel\.id/)
  assert.match(fila, /VIVENZZA_COBRANCA_NUMERO: numero/)
  assert.doesNotMatch(fila, /VIVENZZA_(SALDO|VALOR|VENCIMENTO)/)
})
test('negação de pagamento não vira pagamento; previsão não é promessa registrada', async () => {
  for (const fala of ['não paguei', 'não está pago', 'vou pagar amanhã']) {
    const r = await responderCobrancaVoz(fala, { responsavelConfirmado: true, etapaFinanceira: 'pagamento' }, async () => ({ permitido: true }))
    assert.equal(r.intent, 'CONFERENCIA_FINANCEIRA')
    assert.doesNotMatch(r.respostaTexto, /registrad|baixad|confirmad/)
  }
})
