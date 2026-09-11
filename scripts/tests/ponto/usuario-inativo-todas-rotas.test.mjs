// Cobre o achado da revisão de 2026-09-11: checar usuarios.ativo só nas
// rotas de decisão era insuficiente. Este arquivo prova, de forma
// data-driven, que TODA rota do módulo (colaborador, gestor, admin) — não
// só decisão — bloqueia um usuário desativado DEPOIS de o JWT já ter sido
// emitido, sem precisar de logout/novo login. Cobre explicitamente
// histórico, foto/URL assinada, correções, solicitações e administração
// de equipamentos/habilitações (exportação usa os mesmos GETs de
// marcações — não existe endpoint de export separado no backend, ver
// GestaoPonto.jsx).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  subirServidorDeTeste, pararServidorDeTeste, obterSupabaseDeTeste,
  gerarToken, chamar, criarUsuarioDeTeste, habilitarPontoDeTeste,
  definirPilotoAtivoDeTeste, concederEscopoGestorDeTeste, fotoSinteticaBase64,
  limparVinculosCircularesDeTeste,
} from './_setup.mjs'

let admin
const criados = []

before(async () => {
  await subirServidorDeTeste()
  await definirPilotoAtivoDeTeste(true)
  admin = await criarUsuarioDeTeste({ role: 'admin' })
  criados.push(admin.id)
})

after(async () => {
  const supabase = obterSupabaseDeTeste()
  await limparVinculosCircularesDeTeste(criados)
  await supabase.from('ponto_marcacoes').delete().in('usuario_id', criados)
  await supabase.from('ponto_solicitacoes_marcacao').delete().in('usuario_id', criados)
  await supabase.from('ponto_correcoes').delete().in('usuario_id', criados)
  await supabase.from('ponto_gestores').delete().in('gestor_usuario_id', criados)
  await supabase.from('ponto_equipamentos').delete().in('usuario_id', criados)
  await supabase.from('ponto_habilitacoes').delete().in('usuario_id', criados)
  await supabase.from('usuarios').delete().in('id', criados)
  await pararServidorDeTeste()
})

async function desativar(usuarioId) {
  const supabase = obterSupabaseDeTeste()
  const { error } = await supabase.from('usuarios').update({ ativo: false }).eq('id', usuarioId)
  if (error) throw error
}

test('colaborador desativado após emissão do JWT perde acesso a TODA rota de /api/ponto, inclusive foto e correções', async () => {
  const colaborador = await criarUsuarioDeTeste({ role: 'vendedor' })
  criados.push(colaborador.id)
  await habilitarPontoDeTeste(colaborador.id, true)
  const token = gerarToken(colaborador) // emitido enquanto ainda ativo

  // Cria uma solicitação e aprova (via um gestor ativo), pra ter uma
  // marcação e uma foto reais pra tentar acessar depois de desativado.
  const gestor = await criarUsuarioDeTeste({ role: 'vendedor' })
  criados.push(gestor.id)
  await concederEscopoGestorDeTeste({ gestorId: gestor.id, colaboradorId: colaborador.id, concedidoPor: admin.id })
  const operacaoId = crypto.randomUUID()
  const solicitacao = await chamar('POST', '/api/ponto/solicitacoes', {
    token,
    body: { operacao_id: operacaoId, tipo: 'entrada', senha_atual: colaborador.senha, justificativa: 'teste', foto_base64: fotoSinteticaBase64(), mime_type: 'image/jpeg' },
  })
  assert.equal(solicitacao.status, 201)
  const aprovar = await chamar('POST', `/api/ponto-gestao/solicitacoes/${solicitacao.body.id}/decisao`, { token: gerarToken(gestor), body: { decisao: 'aprovada' } })
  assert.equal(aprovar.status, 200)
  const marcacaoId = aprovar.body.marcacao_gerada.id

  const correcao = await chamar('POST', '/api/ponto/correcoes', {
    token,
    body: { marcacao_id: marcacaoId, tipo_solicitacao: 'outro', valor_proposto: {}, justificativa: 'teste' },
  })
  assert.equal(correcao.status, 201)

  // Confirma que TUDO funciona normalmente enquanto ainda ativo.
  const rotasGet = [
    '/api/ponto/estado',
    '/api/ponto/marcacoes',
    `/api/ponto/marcacoes/${marcacaoId}/foto`,
    '/api/ponto/solicitacoes',
    `/api/ponto/solicitacoes/por-operacao/${operacaoId}`,
    '/api/ponto/correcoes',
  ]
  for (const rota of rotasGet) {
    const antes = await chamar('GET', rota, { token })
    assert.ok(antes.status < 400, `${rota} deveria funcionar enquanto ativo, veio ${antes.status}`)
  }

  await desativar(colaborador.id)

  for (const rota of rotasGet) {
    const depois = await chamar('GET', rota, { token })
    assert.equal(depois.status, 403, `${rota} deveria bloquear usuário desativado, veio ${depois.status}`)
  }

  const solicitarDepois = await chamar('POST', '/api/ponto/solicitacoes', {
    token,
    body: { operacao_id: crypto.randomUUID(), tipo: 'saida', senha_atual: colaborador.senha, justificativa: 'teste' },
  })
  assert.equal(solicitarDepois.status, 403)

  const corrigirDepois = await chamar('POST', '/api/ponto/correcoes', {
    token,
    body: { marcacao_id: marcacaoId, tipo_solicitacao: 'outro', valor_proposto: {}, justificativa: 'teste' },
  })
  assert.equal(corrigirDepois.status, 403)
})

test('gestor desativado após emissão do JWT perde acesso a TODA rota de /api/ponto-gestao, inclusive foto e listagens usadas na exportação', async () => {
  const colaborador = await criarUsuarioDeTeste({ role: 'vendedor' })
  criados.push(colaborador.id)
  await habilitarPontoDeTeste(colaborador.id, true)

  const gestor = await criarUsuarioDeTeste({ role: 'vendedor' })
  criados.push(gestor.id)
  await concederEscopoGestorDeTeste({ gestorId: gestor.id, colaboradorId: colaborador.id, concedidoPor: admin.id })
  const token = gerarToken(gestor)

  const solicitacao = await chamar('POST', '/api/ponto/solicitacoes', {
    token: gerarToken(colaborador),
    body: { operacao_id: crypto.randomUUID(), tipo: 'entrada', senha_atual: colaborador.senha, justificativa: 'teste', foto_base64: fotoSinteticaBase64(), mime_type: 'image/jpeg' },
  })
  assert.equal(solicitacao.status, 201)

  const rotasGetAntesDeDecidir = [
    '/api/ponto-gestao/colaboradores',
    '/api/ponto-gestao/marcacoes', // é a MESMA listagem que GestaoPonto.jsx usa pra exportar CSV/PDF
    '/api/ponto-gestao/correcoes',
    '/api/ponto-gestao/solicitacoes',
    `/api/ponto-gestao/solicitacoes/${solicitacao.body.id}/foto`,
  ]
  for (const rota of rotasGetAntesDeDecidir) {
    const antes = await chamar('GET', rota, { token })
    assert.ok(antes.status < 400, `${rota} deveria funcionar enquanto ativo, veio ${antes.status}`)
  }

  await desativar(gestor.id)

  for (const rota of rotasGetAntesDeDecidir) {
    const depois = await chamar('GET', rota, { token })
    assert.equal(depois.status, 403, `${rota} deveria bloquear gestor desativado, veio ${depois.status}`)
  }

  const decidirDepois = await chamar('POST', `/api/ponto-gestao/solicitacoes/${solicitacao.body.id}/decisao`, { token, body: { decisao: 'aprovada' } })
  assert.equal(decidirDepois.status, 403)
})

test('admin desativado após emissão do JWT perde acesso a TODA rota de /api/ponto-admin', async () => {
  const admin2 = await criarUsuarioDeTeste({ role: 'admin' })
  criados.push(admin2.id)
  const colaborador = await criarUsuarioDeTeste({ role: 'vendedor' })
  criados.push(colaborador.id)
  const token = gerarToken(admin2)

  const rotasGet = ['/api/ponto-admin/habilitacoes', '/api/ponto-admin/gestores', '/api/ponto-admin/equipamentos', '/api/ponto-admin/config']
  for (const rota of rotasGet) {
    const antes = await chamar('GET', rota, { token })
    assert.ok(antes.status < 400, `${rota} deveria funcionar enquanto ativo, veio ${antes.status}`)
  }

  await desativar(admin2.id)

  for (const rota of rotasGet) {
    const depois = await chamar('GET', rota, { token })
    assert.equal(depois.status, 403, `${rota} deveria bloquear admin desativado, veio ${depois.status}`)
  }

  const patchDepois = await chamar('PATCH', `/api/ponto-admin/habilitacoes/${colaborador.id}`, { token, body: { habilitado: true } })
  assert.equal(patchDepois.status, 403)
})
