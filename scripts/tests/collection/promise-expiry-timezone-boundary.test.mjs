// 2026-09-01 — pedido "REVISÃO FINAL, HARDENING E MERGE DA PR #62", item 4:
// prova que "hoje" pra processarPromessasVencidas() é sempre a data
// operacional em America/Sao_Paulo, nunca a data UTC do host — usando
// node:test mock.timers pra congelar o relógio em instantes exatos de
// fronteira, SEM depender da hora real da máquina que roda o teste.
//
// Escolha dos instantes: 2026-06-15T02:30:00Z (23:30 no dia 14 em BRT) e
// 2026-06-15T03:30:00Z (00:30 no dia 15 em BRT, logo depois da meia-noite
// BRT — BRT = UTC-3 sem horário de verão desde 2019, então 03:00 UTC é
// sempre exatamente meia-noite BRT). Os dois instantes caem no MESMO dia
// UTC (15/06) mas em dias BRT DIFERENTES (14 e 15) — se alguém trocar
// hojeBrtISO() por algo baseado ingenuamente em new Date().toISOString(),
// esse teste quebra (os dois instantes passariam a reportar o mesmo dia).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste, criarContaDeTeste } from './_setup.mjs'

const INSTANTE_23H30_BRT_DIA_14 = '2026-06-15T02:30:00Z' // 14/06 23:30 BRT
const INSTANTE_00H30_BRT_DIA_15 = '2026-06-15T03:30:00Z' // 15/06 00:30 BRT

test('promise-expiry-sweep: fronteira de virada de dia usa data BRT, não UTC do host', async (t) => {
  await iniciarAmbienteDeTeste()
  const { supabase } = await import('../../../src/lib/supabase-admin.server.js')
  const { hojeBrtISO } = await import('../../../src/lib/collection/collectionContactPolicy.js')
  const { registrarPromessa, promessaAtivaPara } = await import('../../../src/lib/collection/promises.js')

  await t.test('1. hojeBrtISO() no instante 02:30Z (23:30 BRT do dia 14) retorna 2026-06-14, não 2026-06-15', (ctx) => {
    ctx.mock.timers.enable({ apis: ['Date'], now: new Date(INSTANTE_23H30_BRT_DIA_14) })
    assert.equal(hojeBrtISO(), '2026-06-14')
  })

  await t.test('2. hojeBrtISO() no instante 03:30Z (00:30 BRT do dia 15) já retorna 2026-06-15 — mesmo dia UTC do teste 1, dia BRT diferente', (ctx) => {
    ctx.mock.timers.enable({ apis: ['Date'], now: new Date(INSTANTE_00H30_BRT_DIA_15) })
    assert.equal(hojeBrtISO(), '2026-06-15')
  })

  await t.test('3. runPromiseExpirySweep, congelado em 23:30 BRT do dia 14: promessa com promised_date=2026-06-14 (hoje BRT) NÃO quebra', async (ctx) => {
    ctx.mock.timers.enable({ apis: ['Date'], now: new Date(INSTANTE_23H30_BRT_DIA_14) })
    const conta = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 0 })
    const p = await registrarPromessa({ contasFinanceirasId: conta.id, clienteNome: conta.pessoa_nome, clienteTelefone: conta.telefone_cobranca, valor: 500, promisedDate: '2026-06-14', origem: 'HUMAN' })
    const { runPromiseExpirySweep } = await import('../../../src/jobs/promise-expiry-sweep.js')
    await runPromiseExpirySweep()
    const ativa = await promessaAtivaPara(conta.id)
    assert.ok(ativa, 'promessa de hoje (BRT) não deveria ter sido quebrada ainda')
    assert.equal(ativa.id, p.id)
  })

  await t.test('4. runPromiseExpirySweep, congelado em 23:30 BRT do dia 14: promessa com promised_date=2026-06-13 (ontem BRT) quebra', async (ctx) => {
    ctx.mock.timers.enable({ apis: ['Date'], now: new Date(INSTANTE_23H30_BRT_DIA_14) })
    const conta = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 0 })
    await registrarPromessa({ contasFinanceirasId: conta.id, clienteNome: conta.pessoa_nome, clienteTelefone: conta.telefone_cobranca, valor: 500, promisedDate: '2026-06-13', origem: 'HUMAN' })
    const { runPromiseExpirySweep } = await import('../../../src/jobs/promise-expiry-sweep.js')
    await runPromiseExpirySweep()
    assert.equal(await promessaAtivaPara(conta.id), null, 'promessa de ontem (BRT) deveria ter quebrado')
  })

  await t.test('5. runPromiseExpirySweep, congelado em 00:30 BRT do dia 15: promessa com promised_date=2026-06-14 (ontem BRT agora) quebra — mesmo com o dia UTC ainda sendo 15/06 em ambos os testes 3-5', async (ctx) => {
    ctx.mock.timers.enable({ apis: ['Date'], now: new Date(INSTANTE_00H30_BRT_DIA_15) })
    const conta = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 0 })
    await registrarPromessa({ contasFinanceirasId: conta.id, clienteNome: conta.pessoa_nome, clienteTelefone: conta.telefone_cobranca, valor: 500, promisedDate: '2026-06-14', origem: 'HUMAN' })
    const { runPromiseExpirySweep } = await import('../../../src/jobs/promise-expiry-sweep.js')
    await runPromiseExpirySweep()
    assert.equal(await promessaAtivaPara(conta.id), null, 'a mesma data (2026-06-14) que era "hoje" no teste 3 já é "ontem" 1h de relógio depois, na virada BRT')
  })

  await pararAmbienteDeTeste()
})
