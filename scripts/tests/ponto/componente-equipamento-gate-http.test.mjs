// Prova, pela borda HTTP real (não chamando funções internas), que as três
// rotas novas do componente de equipamento continuam INALCANÇÁVEIS enquanto
// EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA for false — mesmo com um payload
// estruturalmente válido (uma assinatura real, um código de vínculo real).
// Esta é a propriedade de segurança mais importante desta rodada: a
// capacidade implementada não ativa nada sozinha.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import {
  subirServidorDeTeste, pararServidorDeTeste, obterSupabaseDeTeste, chamar, gerarToken,
  criarUsuarioDeTeste, habilitarPontoDeTeste, definirPilotoAtivoDeTeste,
  criarEquipamentoDeTeste, vincularEquipamentoDeTesteComChaveNode,
  limparVinculosCircularesDeTeste,
} from './_setup.mjs'
import { EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA } from '../../../src/lib/ponto/equipamento.js'

let usuario, admin, token, tokenAdmin

before(async () => {
  await subirServidorDeTeste()
  await definirPilotoAtivoDeTeste(true)
  admin = await criarUsuarioDeTeste({ role: 'admin' })
  usuario = await criarUsuarioDeTeste()
  await habilitarPontoDeTeste(usuario.id, true)
  token = gerarToken(usuario)
  tokenAdmin = gerarToken(admin)
})

after(async () => {
  const supabase = obterSupabaseDeTeste()
  await limparVinculosCircularesDeTeste([usuario.id, admin.id])
  await supabase.from('ponto_marcacoes').delete().eq('usuario_id', usuario.id)
  await supabase.from('ponto_desafios').delete().eq('usuario_id', usuario.id)
  await supabase.from('ponto_equipamentos').delete().eq('usuario_id', usuario.id)
  await pararServidorDeTeste()
})

test('pré-condição: EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA é false neste código', () => {
  assert.equal(EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA, false)
})

test('POST /api/ponto-admin/equipamentos/:id/vinculos → 501, mesmo para admin', async () => {
  const equipamentoId = await criarEquipamentoDeTeste({ usuarioId: usuario.id, cadastradoPor: admin.id })
  const res = await chamar('POST', `/api/ponto-admin/equipamentos/${equipamentoId}/vinculos`, { token: tokenAdmin, body: {} })
  assert.equal(res.status, 501)
})

test('POST /api/ponto-equipamento/vincular → 501, mesmo com chave e prova de posse estruturalmente válidas', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = publicKey.export({ format: 'jwk' })
  const prova = crypto.sign('sha256', Buffer.from('meu-ponto-prova-posse|QUALQUER-CODIGO'), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64')

  const res = await chamar('POST', '/api/ponto-equipamento/vincular', {
    body: { codigo: 'QUALQUER-CODIGO', chave_publica_jwk: jwk, chave_hardware_backed: true, prova_posse: prova },
  })
  assert.equal(res.status, 501)
})

test('POST /api/ponto/desafios → 501, mesmo colaborador habilitado e piloto ativo', async () => {
  const equipamentoId = await criarEquipamentoDeTeste({ usuarioId: usuario.id, cadastradoPor: admin.id })
  await vincularEquipamentoDeTesteComChaveNode({ equipamentoId })
  const res = await chamar('POST', '/api/ponto/desafios', { token, body: { equipamento_id: equipamentoId, tipo: 'entrada', hash_conteudo: 'a'.repeat(64) } })
  assert.equal(res.status, 501)
})

test('POST /api/ponto/marcacoes com assinatura real e válida ainda assim → 501 (nunca vira 201)', async () => {
  const { emitirDesafio, registrarMarcacaoAssinada } = await import('../../../src/lib/ponto/equipamentoService.js')
  const { calcularHashConteudo, payloadAssinaturaEquipamento } = await import('../../../src/lib/ponto/assinaturaEquipamento.js')

  const equipamentoId = await criarEquipamentoDeTeste({ usuarioId: usuario.id, cadastradoPor: admin.id })
  const { privateKey } = await vincularEquipamentoDeTesteComChaveNode({ equipamentoId })
  const hash = calcularHashConteudo(Buffer.from('foto-fake-gate'))
  const desafio = await emitirDesafio({ usuarioId: usuario.id, equipamentoId, tipo: 'entrada', hashConteudo: hash })
  const operacaoId = crypto.randomUUID()
  const payload = payloadAssinaturaEquipamento({ nonce: desafio.nonce, equipamentoId, usuarioId: usuario.id, operacaoId, tipo: 'entrada', hashConteudo: hash })
  const assinatura = crypto.sign('sha256', payload, { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64')

  const res = await chamar('POST', '/api/ponto/marcacoes', {
    token,
    body: {
      operacao_id: operacaoId, tipo: 'entrada', senha_atual: usuario.senha,
      foto_base64: Buffer.from('foto-fake-gate').toString('base64'), mime_type: 'image/jpeg',
      equipamento_id: equipamentoId, nonce: desafio.nonce, assinatura,
    },
  })
  assert.equal(res.status, 501, 'a rota real precisa continuar bloqueada mesmo com um payload genuinamente válido de ponta a ponta')

  const { count } = await obterSupabaseDeTeste().from('ponto_marcacoes').select('id', { count: 'exact', head: true }).eq('operacao_id', operacaoId)
  assert.equal(count, 0, 'nenhuma marcação deveria ter sido criada')
})
