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
  horaAtual: new Date(2026, 0, 5, 10, 0), // segunda-feira 10:00 (2026-01-05 é segunda)
  politicaHorario: { janelas: [{ dias: [1, 2, 3, 4, 5], inicioMinutos: 9 * 60, fimMinutos: 18 * 60 }] },
  chamadasHoje: [],
  limiteDiario: 3,
}

test('VOICE EXTERNAL READINESS: sem trunk configurado -> SEMPRE bloqueado, mesmo com tudo mais correto', () => {
  assert.throws(() => resolverDestino(TIPO_DESTINO.EXTERNAL), /fail-closed/)
  const resultado = avaliarAutorizacaoChamadaExterna(CONTEXTO_BASE)
  assert.equal(resultado.permitido, false)
  assert.match(resultado.motivo, /sem_trunk/)
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

test('VOICE EXTERNAL READINESS: horário fail-closed sem política configurada', () => {
  assert.equal(avaliarHorarioPermitido(new Date(2026, 0, 5, 10, 0), null), false)
  assert.equal(avaliarHorarioPermitido(new Date(2026, 0, 5, 10, 0), { janelas: [] }), false)
  const politica = { janelas: [{ dias: [1, 2, 3, 4, 5], inicioMinutos: 9 * 60, fimMinutos: 18 * 60 }] }
  assert.equal(avaliarHorarioPermitido(new Date(2026, 0, 5, 10, 0), politica), true) // segunda 10h
  assert.equal(avaliarHorarioPermitido(new Date(2026, 0, 5, 20, 0), politica), false) // segunda 20h, fora da janela
  assert.equal(avaliarHorarioPermitido(new Date(2026, 0, 4, 10, 0), politica), false) // domingo, fora dos dias
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
