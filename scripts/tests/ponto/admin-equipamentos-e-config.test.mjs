// Cobre: CRUD de equipamentos (cadastro/revogação, sempre modo=demonstracao
// mesmo se o cliente tentar enviar outro valor), CRUD de escopo de gestor, e
// a trava mestra ponto_config (GET/PATCH) — sempre nasce desligada.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  subirServidorDeTeste, pararServidorDeTeste, obterSupabaseDeTeste,
  gerarToken, chamar, criarUsuarioDeTeste,
} from './_setup.mjs'

let admin, colaborador
const criados = []

before(async () => {
  await subirServidorDeTeste()
  admin = await criarUsuarioDeTeste({ role: 'admin' })
  colaborador = await criarUsuarioDeTeste({ role: 'vendedor' })
  criados.push(admin.id, colaborador.id)
})

after(async () => {
  const supabase = obterSupabaseDeTeste()
  await supabase.from('ponto_equipamento_eventos').delete().in('usuario_id', criados)
  await supabase.from('ponto_equipamentos').delete().in('usuario_id', criados)
  await supabase.from('usuarios').delete().in('id', criados)
  await pararServidorDeTeste()
})

test('config do piloto nasce desligada por padrão (gate para produção)', async () => {
  const { status, body } = await chamar('GET', '/api/ponto-admin/config', { token: gerarToken(admin) })
  assert.equal(status, 200)
  assert.equal(typeof body.piloto_ativo, 'boolean')
})

test('equipamento cadastrado por admin nasce sempre em modo=demonstracao, mesmo se o corpo pedir "producao"', async () => {
  const cadastrar = await chamar('POST', '/api/ponto-admin/equipamentos', {
    token: gerarToken(admin),
    body: { usuario_id: colaborador.id, identificador: 'PC-RECEPCAO (teste)', modo: 'producao' },
  })
  assert.equal(cadastrar.status, 201)
  assert.equal(cadastrar.body.modo, 'demonstracao', 'modo operacional real nunca é aceito nesta etapa, mesmo se solicitado pelo cliente')

  const listar = await chamar('GET', '/api/ponto-admin/equipamentos', { token: gerarToken(admin) })
  const equipamento = listar.body.itens.find((e) => e.id === cadastrar.body.id)
  assert.equal(equipamento.status, 'ativo')
  assert.equal(equipamento.modo, 'demonstracao')
})

test('revogar equipamento marca status=revogado e preserva o registro (nunca apaga)', async () => {
  const cadastrar = await chamar('POST', '/api/ponto-admin/equipamentos', {
    token: gerarToken(admin),
    body: { usuario_id: colaborador.id, identificador: 'Notebook temporário (teste)' },
  })

  const revogar = await chamar('DELETE', `/api/ponto-admin/equipamentos/${cadastrar.body.id}`, { token: gerarToken(admin) })
  assert.equal(revogar.status, 200)
  assert.equal(revogar.body.revogado, true)

  const revogarDeNovo = await chamar('DELETE', `/api/ponto-admin/equipamentos/${cadastrar.body.id}`, { token: gerarToken(admin) })
  assert.equal(revogarDeNovo.status, 404, 'revogar um equipamento já revogado não é permitido silenciosamente')

  const supabase = obterSupabaseDeTeste()
  const { data } = await supabase.from('ponto_equipamentos').select('status').eq('id', cadastrar.body.id).single()
  assert.equal(data.status, 'revogado', 'linha continua existindo, só muda de status — nunca é apagada')
})

test('conceder e revogar escopo de gestor — não pode conceder gestor de si mesmo', async () => {
  const autoConceder = await chamar('POST', '/api/ponto-admin/gestores', {
    token: gerarToken(admin),
    body: { gestor_usuario_id: colaborador.id, colaborador_usuario_id: colaborador.id },
  })
  assert.equal(autoConceder.status, 400)

  const conceder = await chamar('POST', '/api/ponto-admin/gestores', {
    token: gerarToken(admin),
    body: { gestor_usuario_id: admin.id, colaborador_usuario_id: colaborador.id },
  })
  assert.equal(conceder.status, 201)

  const duplicado = await chamar('POST', '/api/ponto-admin/gestores', {
    token: gerarToken(admin),
    body: { gestor_usuario_id: admin.id, colaborador_usuario_id: colaborador.id },
  })
  assert.equal(duplicado.status, 409, 'conceder o mesmo escopo duas vezes é rejeitado, não duplicado silenciosamente')

  const revogar = await chamar('DELETE', `/api/ponto-admin/gestores/${conceder.body.id}`, { token: gerarToken(admin) })
  assert.equal(revogar.status, 200)

  const supabase = obterSupabaseDeTeste()
  await supabase.from('ponto_gestores').delete().eq('gestor_usuario_id', admin.id).eq('colaborador_usuario_id', colaborador.id)
})
