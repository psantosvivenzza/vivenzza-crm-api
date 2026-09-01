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
import { dentroDoHorarioPermitido } from '../../../src/jobs/cobranca-whatsapp.js'

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
