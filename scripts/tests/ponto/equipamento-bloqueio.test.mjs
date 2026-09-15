// Prova o achado central da revisão de 2026-09-10: "registro operacional
// bloqueado" não pode depender só de ponto_config.piloto_ativo=false — tem
// que ser estrutural, porque um admin LIGA o piloto legitimamente (mesmo
// que só em teste isolado) sem que isso signifique que o componente de
// equipamento passou a existir. Este arquivo prova que, mesmo com
// piloto_ativo=true, senha correta e foto válida, POST /api/ponto/marcacoes
// (criação DIRETA) continua bloqueada — porque
// EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA é uma constante de código
// (src/lib/ponto/equipamento.js), não uma flag de banco que um teste ou um
// admin possa religar.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  subirServidorDeTeste, pararServidorDeTeste, obterSupabaseDeTeste,
  gerarToken, chamar, criarUsuarioDeTeste, habilitarPontoDeTeste,
  definirPilotoAtivoDeTeste, fotoSinteticaBase64,
} from './_setup.mjs'
import { EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA } from '../../../src/lib/ponto/equipamento.js'

let colaborador
const criados = []

before(async () => {
  await subirServidorDeTeste()
  colaborador = await criarUsuarioDeTeste({ role: 'vendedor' })
  criados.push(colaborador.id)
  await habilitarPontoDeTeste(colaborador.id, true)
})

after(async () => {
  const supabase = obterSupabaseDeTeste()
  await supabase.from('ponto_marcacoes').delete().in('usuario_id', criados)
  await supabase.from('ponto_habilitacoes').delete().in('usuario_id', criados)
  await supabase.from('usuarios').delete().in('id', criados)
  await pararServidorDeTeste()
})

test('pré-condição: EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA é false nesta etapa (se isto falhar, todo o resto deste arquivo perde o sentido)', () => {
  assert.equal(EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA, false)
})

test('piloto_ativo=false: POST /marcacoes é bloqueado (403) antes mesmo de chegar no gate de equipamento', async () => {
  await definirPilotoAtivoDeTeste(false)
  const { status, body } = await chamar('POST', '/api/ponto/marcacoes', {
    token: gerarToken(colaborador),
    body: { operacao_id: crypto.randomUUID(), tipo: 'entrada', senha_atual: colaborador.senha, foto_base64: fotoSinteticaBase64(), mime_type: 'image/jpeg' },
  })
  assert.equal(status, 403)
  assert.match(body.erro, /desativado/i)
})

test('piloto_ativo=true + senha correta + foto válida: POST /marcacoes AINDA é bloqueado (501) — o achado central desta revisão', async () => {
  await definirPilotoAtivoDeTeste(true)
  const supabase = obterSupabaseDeTeste()
  const { count: antes } = await supabase.from('ponto_marcacoes').select('id', { count: 'exact', head: true }).eq('usuario_id', colaborador.id)

  const { status, body } = await chamar('POST', '/api/ponto/marcacoes', {
    token: gerarToken(colaborador),
    body: { operacao_id: crypto.randomUUID(), tipo: 'entrada', senha_atual: colaborador.senha, foto_base64: fotoSinteticaBase64(), mime_type: 'image/jpeg' },
  })
  assert.equal(status, 501, 'não pode virar 201 só porque piloto_ativo=true — falta a capacidade real de verificar equipamento')
  assert.match(body.erro, /equipamento/i)

  const { count: depois } = await supabase.from('ponto_marcacoes').select('id', { count: 'exact', head: true }).eq('usuario_id', colaborador.id)
  assert.equal(depois, antes, 'nenhuma linha em ponto_marcacoes deve ter sido criada')
})

test('enviar equipamento_id no corpo não muda nada — nunca é aceito como prova, nem sequer é lido', async () => {
  const { status, body } = await chamar('POST', '/api/ponto/marcacoes', {
    token: gerarToken(colaborador),
    body: {
      operacao_id: crypto.randomUUID(),
      tipo: 'entrada',
      senha_atual: colaborador.senha,
      foto_base64: fotoSinteticaBase64(),
      mime_type: 'image/jpeg',
      equipamento_id: '11111111-1111-1111-1111-111111111111',
      equipamento_assinatura: 'qualquer-coisa-que-pareça-uma-assinatura',
    },
  })
  assert.equal(status, 501, 'equipamento_id/assinatura no corpo não desbloqueia nada')
  assert.doesNotMatch(JSON.stringify(body), /11111111-1111-1111-1111-111111111111/, 'o equipamento_id enviado nem aparece na resposta — prova que não foi processado')
})

test('sem senha nenhuma, o bloqueio de equipamento ainda vem primeiro (501, não 400) — a ordem do gate não vaza informação sobre outros campos', async () => {
  const { status } = await chamar('POST', '/api/ponto/marcacoes', {
    token: gerarToken(colaborador),
    body: { operacao_id: crypto.randomUUID(), tipo: 'entrada' },
  })
  assert.equal(status, 501)
})

test('o caminho real desta etapa (POST /solicitacoes) NÃO é bloqueado por este gate — só a criação direta é', async () => {
  const { status, body } = await chamar('POST', '/api/ponto/solicitacoes', {
    token: gerarToken(colaborador),
    body: { operacao_id: crypto.randomUUID(), tipo: 'entrada', senha_atual: colaborador.senha, justificativa: 'equipamento ainda não implementado, registrando por solicitação' },
  })
  assert.equal(status, 201)
  assert.equal(body.status, 'pendente', 'vira uma solicitação PENDENTE, nunca uma marcação confirmada direto')
})
