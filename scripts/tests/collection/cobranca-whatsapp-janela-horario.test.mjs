// 2026-09-01 — hardening de testes dependentes de horário: comportamento
// TEMPORAL da régua (janela operacional 08h-17h BRT) isolado da lógica de
// consolidação/DNC/envio (collection-consolidacao-cobranca.test.mjs), que
// não deve mais ser responsável por provar fronteira de horário. Testa
// dentroDoHorarioPermitido() diretamente — função pura, sem DB/rede, sem
// FakeEvolution — usando node:test mock.timers pra congelar o relógio em
// instantes conhecidos, nunca dependendo da hora real da máquina que roda o
// teste. Regra de produção (08h-17h BRT, HORA_INICIO_BRT/HORA_FIM_BRT em
// cobranca-whatsapp.js) não é alterada por este arquivo — só testada.
import { test } from 'node:test'
import assert from 'node:assert/strict'
// Import só pelo efeito colateral: define LOCAL_PG_URL/NODE_ENV=test antes do
// import de cobranca-whatsapp.js abaixo (que importa supabase-admin.server.js
// no topo do módulo e falha sem essas env vars) — nunca conecta de fato, este
// arquivo não abre Postgres nem FakeEvolution (dentroDoHorarioPermitido() é
// função pura, sem I/O).
import './_setup.mjs'
import { dentroDoHorarioPermitido, aguardarIntervaloAleatorio } from '../../../src/jobs/cobranca-whatsapp.js'

// Instantes em UTC — BRT = UTC-3 fixo (sem horário de verão desde 2019).
const CASOS = [
  { desc: '05:00 BRT (02:00 UTC) — bem antes da janela', utc: '2026-06-15T02:00:00Z', esperado: false },
  { desc: '07:59 BRT (10:59 UTC) — 1 minuto antes do início', utc: '2026-06-15T10:59:00Z', esperado: false },
  { desc: '08:00 BRT (11:00 UTC) — exatamente o início da janela (inclusivo)', utc: '2026-06-15T11:00:00Z', esperado: true },
  { desc: '08:01 BRT (11:01 UTC) — logo depois do início', utc: '2026-06-15T11:01:00Z', esperado: true },
  { desc: '12:00 BRT (15:00 UTC) — meio da janela', utc: '2026-06-15T15:00:00Z', esperado: true },
  { desc: '16:59 BRT (19:59 UTC) — 1 minuto antes do fim', utc: '2026-06-15T19:59:00Z', esperado: true },
  { desc: '17:00 BRT (20:00 UTC) — exatamente o fim da janela (exclusivo — HORA_FIM_BRT=17, comentário no código confirma)', utc: '2026-06-15T20:00:00Z', esperado: false },
  { desc: '17:01 BRT (20:01 UTC) — logo depois do fim', utc: '2026-06-15T20:01:00Z', esperado: false },
  { desc: '22:00 BRT (01:00 UTC do dia seguinte) — bem depois da janela', utc: '2026-06-16T01:00:00Z', esperado: false },
]

test('dentroDoHorarioPermitido(): janela operacional 08h-17h BRT, fronteiras exatas', async (t) => {
  for (const caso of CASOS) {
    await t.test(caso.desc, (subT) => {
      subT.mock.timers.enable({ apis: ['Date'], now: new Date(caso.utc) })
      assert.equal(dentroDoHorarioPermitido(), caso.esperado)
    })
  }
})

// aguardarIntervaloAleatorio(): prova que NODE_ENV==='test' é o ÚNICO bypass
// do intervalo real de 45-90s — sem esperar 45-90s de verdade (mock.timers no
// setTimeout: avança o relógio fake, nunca o real). NODE_ENV ausente,
// 'production', ou qualquer outro valor têm que continuar esperando o
// intervalo real de produção.
test('aguardarIntervaloAleatorio(): NODE_ENV=test é o único bypass do intervalo real de 45-90s', async (t) => {
  const nodeEnvOriginal = process.env.NODE_ENV

  const casosSemBypass = [
    ['ausente', undefined],
    ['production', 'production'],
    ['staging', 'staging'],
    ["'test' com case diferente ('Test') não conta — comparação é estrita", 'Test'],
  ]

  // Sem tickAsync nesta versão do node:test — tick() é síncrono, então cada
  // avanço precisa de um flush de microtask/macrotask (setImmediate) depois
  // pra deixar o .then() do setTimeout mockado rodar antes de checar o
  // resultado.
  async function avancar(subT, ms) {
    subT.mock.timers.tick(ms)
    await new Promise((resolve) => setImmediate(resolve))
  }

  for (const [descricao, valor] of casosSemBypass) {
    await t.test(`NODE_ENV=${descricao} -> espera pelo menos 45s (intervalo real de produção, não pulado)`, async (subT) => {
      subT.mock.timers.enable({ apis: ['setTimeout'] })
      if (valor === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = valor
      try {
        let resolvido = false
        aguardarIntervaloAleatorio().then(() => { resolvido = true })

        await avancar(subT, 44999)
        assert.equal(resolvido, false, 'não pode resolver antes de 45s — isso indicaria que o bypass de teste vazou pra este ambiente')

        await avancar(subT, 45001) // completa até o teto de 90s
        assert.equal(resolvido, true, 'até 90s (45000 + até 45000 aleatório) precisa ter resolvido')
      } finally {
        process.env.NODE_ENV = nodeEnvOriginal
      }
    })
  }

  await t.test("NODE_ENV='test' -> resolve quase instantaneamente (bypass ativo, comportamento usado pela suíte)", async (subT) => {
    subT.mock.timers.enable({ apis: ['setTimeout'] })
    process.env.NODE_ENV = 'test'
    try {
      let resolvido = false
      aguardarIntervaloAleatorio().then(() => { resolvido = true })

      await avancar(subT, 10)
      assert.equal(resolvido, true, 'NODE_ENV=test deveria resolver em 10ms, não em 45-90s')
    } finally {
      process.env.NODE_ENV = nodeEnvOriginal
    }
  })
})
