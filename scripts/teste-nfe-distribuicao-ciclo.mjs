// Teste unitário da decisão de ciclo (config + throttling combinados)
// (src/services/nfe-distribuicao/ciclo.js, Fase B) — puro, sem I/O, sem
// rede. Roda com: node scripts/teste-nfe-distribuicao-ciclo.mjs
import { decidirCicloDeSincronizacao } from '../src/services/nfe-distribuicao/ciclo.js'

let falhas = 0
function check(nome, cond, detalhe) {
  if (cond) console.log(`OK — ${nome}`)
  else { falhas++; console.log(`FALHOU — ${nome}${detalhe ? ' — ' + detalhe : ''}`) }
}

const AGORA = new Date('2026-08-01T12:00:00Z')

check(
  'sync desligada (entrada_sync_ativa=false) bloqueia mesmo sem nenhum histórico',
  decidirCicloDeSincronizacao({ entrada_sync_ativa: false }, null, AGORA).deveConsultar === false
)

check(
  'config nula/ausente bloqueia por segurança (fail-safe)',
  decidirCicloDeSincronizacao(null, null, AGORA).deveConsultar === false
)

check(
  'sync ligada + nunca sincronizou antes = permite (primeira consulta)',
  decidirCicloDeSincronizacao({ entrada_sync_ativa: true }, null, AGORA).deveConsultar === true
)

{
  const estado = { ult_nsu: '000000000000050', ultima_sincronizacao: new Date('2026-08-01T11:50:00Z') } // 10min atrás
  const r = decidirCicloDeSincronizacao({ entrada_sync_ativa: true }, estado, AGORA)
  check('sync ligada mas dentro da janela de 1h (10min atrás) bloqueia', r.deveConsultar === false)
  check('bloqueio por throttling informa ultNsuParaConsulta pro próximo ciclo', r.ultNsuParaConsulta === '000000000000050')
}

{
  const estado = { ult_nsu: '000000000000050', ultima_sincronizacao: new Date('2026-08-01T10:50:00Z') } // 70min atrás
  const r = decidirCicloDeSincronizacao({ entrada_sync_ativa: true }, estado, AGORA)
  check('sync ligada e fora da janela de 1h (70min atrás) permite', r.deveConsultar === true)
  check('permissão retorna o ultNSU correto pra retomar a partir dele', r.ultNsuParaConsulta === '000000000000050')
}

check(
  'estado sem ult_nsu usa "000000000000000" como ponto de partida seguro',
  decidirCicloDeSincronizacao({ entrada_sync_ativa: true }, { ultima_sincronizacao: null }, AGORA).ultNsuParaConsulta === '000000000000000'
)

console.log(`\n${falhas === 0 ? 'TODOS OS TESTES PASSARAM' : `${falhas} TESTE(S) FALHARAM`}`)
process.exit(falhas === 0 ? 0 : 1)
