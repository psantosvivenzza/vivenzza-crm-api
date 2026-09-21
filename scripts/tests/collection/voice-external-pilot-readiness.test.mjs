// Voice AI EXTERNAL PILOT READINESS — testa só lógica PURA (sem rede/ARI/
// DB, sem PSTN real). Objetivo do item 13 do pedido: provar por teste que
// NENHUMA combinação de configuração incompleta autoriza uma chamada
// externa nesta fase.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { TIPO_DESTINO, resolverDestino } from '../../../src/lib/voice/destinoResolver.js'
import {
  avaliarFlagExternalHabilitada,
  avaliarNumeroNaAllowlist,
  avaliarIdempotencia,
  avaliarChamadaDuplicadaAtiva,
  avaliarHorarioPermitido,
  avaliarLimiteDiarioPorTelefone,
  avaliarAutorizacaoChamadaExterna,
} from '../../../src/lib/voice/externalPilotGuardrails.js'
import { RESULTADOS_TECNICOS, RESULTADOS_CONVERSACIONAIS } from '../../../src/lib/voice/voiceCallResult.js'
import { fixtureContextoCobranca } from '../../../src/lib/voice/collectionContextFixture.js'
import { detectarPromiseCandidate } from '../../../src/lib/voice/promiseCandidateDetector.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(__dirname, '..', '..', '..', 'src')

const CONTEXTO_BASE = {
  flags: { voice_external_enabled: true },
  numero: '+5511999998888',
  allowlist: ['+5511999998888'],
  idempotencyKey: 'chave-teste-001',
  chavesJaProcessadas: new Set(),
  chamadasAtivas: [],
  // ATUALIZADO 2026-09-17: instante em UTC EXPLÍCITO. new Date(ano, mes, dia,
  // hora) usa o fuso LOCAL da máquina — o runner roda em UTC, então 10:00
  // "local" era 07:00 em Brasília e o teste provava a janela errada. BRT =
  // UTC-3 fixo (sem horário de verão desde 2019): 13:00Z = 10:00 BRT.
  horaAtual: new Date('2026-01-05T13:00:00Z'), // segunda-feira, 10:00 BRT
  politicaHorario: { janelas: [{ dias: [1, 2, 3, 4, 5], inicioMinutos: 9 * 60, fimMinutos: 18 * 60 }] },
  chamadasHoje: [],
  limiteDiario: 3,
}

// ATUALIZADO 2026-09-17: o trunk da Nvoip foi homologado em 16-17/09 e
// TRUNK_EXTERNO_CONFIGURADO passou a ser true — a premissa original deste
// teste ("nenhum trunk existe, logo nada pode ligar") deixou de valer. O que
// ele precisa provar agora é o oposto e mais importante: mesmo COM trunk
// real, as travas de flag e allowlist continuam bloqueando sozinhas.
test('VOICE EXTERNAL READINESS: com trunk real, flag desabilitada ainda bloqueia sozinha', () => {
  assert.equal(resolverDestino(TIPO_DESTINO.EXTERNAL), 'PJSIP/nvoip-endpoint')
  const resultado = avaliarAutorizacaoChamadaExterna({
    ...CONTEXTO_BASE,
    flags: { voice_external_enabled: false },
  })
  assert.equal(resultado.permitido, false)
  assert.match(resultado.motivo, /flag_desabilitada/)
})

test('VOICE EXTERNAL READINESS: com trunk real, número fora da allowlist ainda bloqueia sozinho', () => {
  const resultado = avaliarAutorizacaoChamadaExterna({
    ...CONTEXTO_BASE,
    allowlist: ['+5511000000000'],
  })
  assert.equal(resultado.permitido, false)
  assert.match(resultado.motivo, /fora_da_allowlist/)
})

test('VOICE EXTERNAL READINESS: INTERNAL continua resolvendo pro ramal já homologado', () => {
  assert.equal(resolverDestino(TIPO_DESTINO.INTERNAL), 'PJSIP/7001')
})

test('VOICE EXTERNAL READINESS: flag desabilitada bloqueia isoladamente', () => {
  assert.equal(avaliarFlagExternalHabilitada({ voice_external_enabled: false }), false)
  assert.equal(avaliarFlagExternalHabilitada({}), false)
  assert.equal(avaliarFlagExternalHabilitada(undefined), false)
  assert.equal(avaliarFlagExternalHabilitada({ voice_external_enabled: true }), true)
})

test('VOICE EXTERNAL READINESS: fora da allowlist bloqueia isoladamente', () => {
  assert.equal(avaliarNumeroNaAllowlist('+5511000000000', ['+5511999998888']), false)
  assert.equal(avaliarNumeroNaAllowlist('+5511999998888', ['+5511999998888']), true)
  assert.equal(avaliarNumeroNaAllowlist('+5511999998888', []), false)
  assert.equal(avaliarNumeroNaAllowlist('+5511999998888', null), false)
})

test('VOICE EXTERNAL READINESS: idempotência bloqueia disparo duplicado pela mesma chave', () => {
  const chaves = new Set(['ja-usada'])
  assert.equal(avaliarIdempotencia('ja-usada', chaves), false)
  assert.equal(avaliarIdempotencia('nova-chave', chaves), true)
  assert.equal(avaliarIdempotencia(null, chaves), false)
})

test('VOICE EXTERNAL READINESS: chamada já ativa pro mesmo número bloqueia', () => {
  const ativas = [{ numero: '+5511999998888', status: 'RINGING' }]
  assert.equal(avaliarChamadaDuplicadaAtiva('+5511999998888', ativas), false)
  assert.equal(avaliarChamadaDuplicadaAtiva('+5511000000000', ativas), true)
  const encerrada = [{ numero: '+5511999998888', status: 'HANGUP' }]
  assert.equal(avaliarChamadaDuplicadaAtiva('+5511999998888', encerrada), true)
})

// ATUALIZADO 2026-09-17: todos os instantes em UTC EXPLÍCITO. O guard agora
// resolve a hora SEMPRE em horário de Brasília, independente do fuso do
// processo — antes ele usava getHours() local, e num runner em UTC (o caso
// aqui e o caso de qualquer servidor em nuvem) isso significava autorizar
// ligação às 07:00 BRT achando que eram 10:00. BRT = UTC-3 fixo.
test('VOICE EXTERNAL READINESS: horário fail-closed e sempre resolvido em BRT', () => {
  const politica = { janelas: [{ dias: [1, 2, 3, 4, 5], inicioMinutos: 9 * 60, fimMinutos: 18 * 60 }] }
  const segunda10hBrt = new Date('2026-01-05T13:00:00Z')
  const segunda20hBrt = new Date('2026-01-05T23:00:00Z')
  const segunda7hBrt = new Date('2026-01-05T10:00:00Z')
  const domingo10hBrt = new Date('2026-01-04T13:00:00Z')

  assert.equal(avaliarHorarioPermitido(segunda10hBrt, null), false)
  assert.equal(avaliarHorarioPermitido(segunda10hBrt, { janelas: [] }), false)
  assert.equal(avaliarHorarioPermitido(segunda10hBrt, politica), true)
  assert.equal(avaliarHorarioPermitido(segunda20hBrt, politica), false, 'segunda 20h BRT está fora da janela')
  assert.equal(avaliarHorarioPermitido(domingo10hBrt, politica), false, 'domingo está fora dos dias')
  // A prova da correção: este instante é 10:00 UTC. O guard antigo (getHours()
  // local, runner em UTC) diria "10h, autorizado" — mas em Brasília são 07:00,
  // fora da janela legal estadual.
  assert.equal(avaliarHorarioPermitido(segunda7hBrt, politica), false, '07:00 BRT (10:00 UTC) nunca pode ser autorizado')
})

test('VOICE EXTERNAL READINESS: limite diário por telefone bloqueia ao atingir o teto', () => {
  const hoje = [{ numero: '+5511999998888' }, { numero: '+5511999998888' }]
  assert.equal(avaliarLimiteDiarioPorTelefone('+5511999998888', hoje, 3), true)
  assert.equal(avaliarLimiteDiarioPorTelefone('+5511999998888', hoje, 2), false)
  assert.equal(avaliarLimiteDiarioPorTelefone('+5511999998888', hoje, 0), false)
})

test('VOICE EXTERNAL READINESS: fixture sintética tem payload correto e nunca é dado real', () => {
  const fixture = fixtureContextoCobranca()
  assert.ok(fixture.contaId.startsWith('fixture-'))
  assert.ok(fixture.telefone.startsWith('+55'))
  assert.equal(typeof fixture.valor, 'number')
})

test('VOICE EXTERNAL READINESS: promise_candidate nunca vira mutação — só rótulo', () => {
  const candidato = detectarPromiseCandidate({ intent: 'PEDIDO_NOVA_DATA' }, { extractedDate: '2026-08-22' })
  assert.equal(candidato.promise_candidate, true)
  assert.equal(candidato.data_extraida, '2026-08-22')
  assert.match(candidato.aviso, /nenhuma promessa real/)

  assert.equal(detectarPromiseCandidate({ intent: 'QUERO_ATENDENTE' }, {}), null)
  assert.equal(detectarPromiseCandidate({ intent: 'CONTESTA_VALOR' }, {}), null)
})

test('VOICE EXTERNAL READINESS: vocabulário de resultado técnico/conversacional', () => {
  assert.ok(RESULTADOS_TECNICOS.includes('NO_ANSWER'))
  assert.ok(RESULTADOS_TECNICOS.includes('BUSY'))
  assert.ok(RESULTADOS_TECNICOS.includes('COMPLETED'))
  assert.ok(RESULTADOS_CONVERSACIONAIS.includes('QUERO_ATENDENTE'))
  assert.ok(RESULTADOS_CONVERSACIONAIS.includes('UNKNOWN'))
})

test('VOICE EXTERNAL READINESS: prova estática — sem Evolution, sem mutação financeira, sem número externo hardcoded', () => {
  const arquivos = [
    'lib/voice/destinoResolver.js',
    'lib/voice/externalPilotGuardrails.js',
    'lib/voice/voiceCallResult.js',
    'lib/voice/collectionContextFixture.js',
    'lib/voice/promiseCandidateDetector.js',
  ]
  for (const rel of arquivos) {
    const conteudo = fs.readFileSync(path.join(SRC, rel), 'utf8')
    for (const proibido of ['evolutionAdapter', 'evolutionFinanceiro', 'sendText', '.rpc(', 'execute_sql', "from('contas_financeiras')", "UPDATE contas_financeiras", "from('collection_promises')", "from('collection_dispatches')"]) {
      assert.equal(conteudo.includes(proibido), false, `${rel} não deveria referenciar "${proibido}"`)
    }
    // nenhum telefone real (formato +55DDNNNNNNNNN de 13 dígitos) fora do fixture sintético
    if (rel !== 'lib/voice/collectionContextFixture.js') {
      assert.equal(/\+55\d{10,11}/.test(conteudo), false, `${rel} não deveria ter um telefone literal`)
    }
  }
})
