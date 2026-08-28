// 2026-08-27 — fila "Revisão de Contatos": clientes com telefone confirmado
// PERMANENT_RECIPIENT, pra o Financeiro corrigir no NetVision. Contra código
// real (rota completa via HTTP), Postgres local — nenhum WhatsApp real em
// nenhum cenário.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste, criarContaDeTeste, limparInstanciasDeTeste, telefoneDeTeste } from './_setup.mjs'

let supabase, fakeEvolution, server, porta

before(async () => {
  fakeEvolution = await iniciarAmbienteDeTeste()
  ;({ supabase } = await import('../../../src/lib/supabase-admin.server.js'))
  process.env.API_SECRET_KEY = 'chave-teste-contact-review'

  const express = (await import('express')).default
  const { auth, adminOnly } = await import('../../../src/middleware/auth.js')
  const router = (await import('../../../src/routes/collection-contact-review.js')).default
  const app = express()
  app.use(express.json())
  app.use('/api/collection-contact-review', auth, adminOnly, router)
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  porta = server.address().port
})
after(async () => {
  // Limpeza final — protege qualquer arquivo de teste que rode depois deste
  // na mesma bateria (npm run test:collection) contra resíduo de
  // collection_dispatches/contas_financeiras criado aqui (achado real: um
  // teste de isolamento de OUTRO arquivo quebrou por causa disso antes desta
  // correção).
  await limparTudo()
  server?.close()
  await pararAmbienteDeTeste()
})

function chamar(query = '', { comAuth = true } = {}) {
  return new Promise((resolve, reject) => {
    const headers = comAuth ? { authorization: 'Bearer chave-teste-contact-review' } : {}
    const req = http.request({ host: '127.0.0.1', port: porta, method: 'GET', path: `/api/collection-contact-review${query}`, headers }, (res) => {
      let chunks = ''
      res.on('data', (c) => { chunks += c })
      res.on('end', () => resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null }))
    })
    req.on('error', reject)
    req.end()
  })
}

async function limparTudo() {
  await limparInstanciasDeTeste(supabase)
  // collection_dispatch_attempts.dispatch_id TEM ON DELETE CASCADE (ao
  // contrário de whatsapp_instance_id, sem cascade) — apagar
  // collection_dispatches já leva as tentativas junto. Sem isso, os
  // dispatches criados por registrarFalhaPermanentRecipient/
  // registrarFalhaOutraCategoria vazavam pra fora deste arquivo e quebravam
  // uma asserção de isolamento de OUTRO arquivo de teste (achado real).
  await supabase.from('collection_dispatches').delete().like('idempotency_key', 'revisao-teste-%')
  // codigo_cliente, não legacy_id (contas_financeiras não seta legacy_id por
  // padrão em criarContaDeTeste) — achado real, o filtro antigo não
  // apagava nada.
  await supabase.from('contas_financeiras').delete().like('codigo_cliente', 'CLI-REVISAO-%')
  await supabase.from('collection_do_not_contact').delete().neq('id', '00000000-0000-0000-0000-000000000000')
  await supabase.from('clientes_erp').delete().like('legacy_id', 'CLI-REVISAO-%')
}

// criarContaDeTeste() só cria a linha em clientes_erp quando codigo_cliente
// NÃO é passado explicitamente — testes que precisam de um código
// PREVISÍVEL (pra depois setar contatos) precisam criar a linha eles
// mesmos primeiro.
async function criarClienteErpComContatos(codigoCliente, contatos) {
  await supabase.from('clientes_erp').insert({ legacy_id: codigoCliente, tipo: 'PJ', razao_social: `Cliente Teste ${codigoCliente}`, ativo: true, contatos })
}

// Registra uma falha PERMANENT_RECIPIENT histórica direto no banco (dispatch
// + attempt) — sem depender do motor de envio real, só provando o que a
// ROTA DE LEITURA lê depois.
async function registrarFalhaPermanentRecipient({ contaId, telefone, criadoEm, purpose = 'collection' }) {
  const { data: dispatch, error: e1 } = await supabase.from('collection_dispatches').insert({
    contas_financeiras_id: contaId, etapa: 1, canal: 'whatsapp',
    idempotency_key: `revisao-teste-${contaId}-${criadoEm}`,
    status: 'failed', origem: 'cron', mensagem: 'teste', cliente_nome: 'Teste', cliente_telefone: telefone,
    valor: 100, purpose, criado_em: criadoEm,
  }).select().single()
  if (e1) throw e1
  const { error: e2 } = await supabase.from('collection_dispatch_attempts').insert({
    dispatch_id: dispatch.id, attempt_number: 1, status: 'failed', failure_kind: 'permanent_recipient', criado_em: criadoEm,
  })
  if (e2) throw e2
  return dispatch
}

async function registrarFalhaOutraCategoria({ contaId, telefone, failureKind }) {
  const { data: dispatch } = await supabase.from('collection_dispatches').insert({
    contas_financeiras_id: contaId, etapa: 1, canal: 'whatsapp',
    idempotency_key: `revisao-teste-outra-${contaId}-${failureKind}`,
    status: 'failed', origem: 'cron', mensagem: 'teste', cliente_nome: 'Teste', cliente_telefone: telefone,
    valor: 100, purpose: 'collection',
  }).select().single()
  await supabase.from('collection_dispatch_attempts').insert({
    dispatch_id: dispatch.id, attempt_number: 1, status: 'failed', failure_kind: failureKind,
  })
}

async function registrarDnc({ telefone, motivo, expiraEm = null }) {
  await supabase.from('collection_do_not_contact').insert({ cliente_telefone: telefone, canal: 'whatsapp', motivo, expira_em: expiraEm })
}

test('Fila de Revisão de Contatos', async (t) => {
  await t.test('1. PERMANENT_RECIPIENT aparece na fila, com status pendente', async () => {
    await limparTudo()
    const telefone = telefoneDeTeste()
    const conta = await criarContaDeTeste(supabase, { telefone_cobranca: telefone, codigo_cliente: `CLI-REVISAO-${Date.now()}` })
    await registrarFalhaPermanentRecipient({ contaId: conta.id, telefone, criadoEm: new Date().toISOString() })
    await registrarDnc({ telefone, motivo: 'numero_invalido_whatsapp', expiraEm: new Date(Date.now() + 29 * 86400000).toISOString() })

    const { status, body } = await chamar()
    assert.equal(status, 200)
    const item = body.itens.find((i) => i.codigo_cliente === conta.codigo_cliente)
    assert.ok(item, 'cliente deveria aparecer na fila')
    assert.equal(item.status, 'pendente')
    assert.equal(item.quarentena_ativa, true)
  })

  await t.test('2. opt-out permanente não aparece na fila', async () => {
    await limparTudo()
    const telefone = telefoneDeTeste()
    const conta = await criarContaDeTeste(supabase, { telefone_cobranca: telefone, codigo_cliente: `CLI-REVISAO-${Date.now()}` })
    await registrarDnc({ telefone, motivo: 'pedido do cliente', expiraEm: null })

    const { body } = await chamar()
    const item = body.itens.find((i) => i.codigo_cliente === conta.codigo_cliente)
    assert.equal(item, undefined, 'opt-out nunca deveria aparecer nesta fila')
  })

  await t.test('3. timeout (falha técnica) não aparece na fila', async () => {
    await limparTudo()
    const telefone = telefoneDeTeste()
    const conta = await criarContaDeTeste(supabase, { telefone_cobranca: telefone, codigo_cliente: `CLI-REVISAO-${Date.now()}` })
    await registrarFalhaOutraCategoria({ contaId: conta.id, telefone, failureKind: 'instance_unavailable' })

    const { body } = await chamar()
    const item = body.itens.find((i) => i.codigo_cliente === conta.codigo_cliente)
    assert.equal(item, undefined, 'falha técnica não é PERMANENT_RECIPIENT')
  })

  await t.test('4. 429 (rate limit) não aparece na fila', async () => {
    await limparTudo()
    const telefone = telefoneDeTeste()
    const conta = await criarContaDeTeste(supabase, { telefone_cobranca: telefone, codigo_cliente: `CLI-REVISAO-${Date.now()}` })
    await registrarFalhaOutraCategoria({ contaId: conta.id, telefone, failureKind: 'rate_limit' })

    const { body } = await chamar()
    const item = body.itens.find((i) => i.codigo_cliente === conta.codigo_cliente)
    assert.equal(item, undefined, '429 nunca deveria aparecer nesta fila')
  })

  await t.test('5. cliente sem alternativa: celular_alternativo_existe=false, outro_contato_existe=false', async () => {
    await limparTudo()
    const telefone = telefoneDeTeste()
    const codigo = `CLI-REVISAO-${Date.now()}`
    await criarClienteErpComContatos(codigo, [{ tipo: 'celular', valor: telefone }])
    const conta = await criarContaDeTeste(supabase, { telefone_cobranca: telefone, codigo_cliente: codigo })
    await registrarFalhaPermanentRecipient({ contaId: conta.id, telefone, criadoEm: new Date().toISOString() })

    const { body } = await chamar()
    const item = body.itens.find((i) => i.codigo_cliente === codigo)
    assert.equal(item.celular_alternativo_existe, false)
    assert.equal(item.outro_contato_existe, false)
  })

  await t.test('6. cliente com alternativa: celular_alternativo_existe=true', async () => {
    await limparTudo()
    const telefone = telefoneDeTeste()
    const alternativo = telefoneDeTeste()
    const codigo = `CLI-REVISAO-${Date.now()}`
    await criarClienteErpComContatos(codigo, [{ tipo: 'fone', valor: telefone }, { tipo: 'celular', valor: alternativo }])
    const conta = await criarContaDeTeste(supabase, { telefone_cobranca: telefone, codigo_cliente: codigo })
    await registrarFalhaPermanentRecipient({ contaId: conta.id, telefone, criadoEm: new Date().toISOString() })

    const { body } = await chamar()
    const item = body.itens.find((i) => i.codigo_cliente === codigo)
    assert.equal(item.celular_alternativo_existe, true)
    assert.equal(item.outro_contato_existe, true)
    assert.equal(item.tipo_contato_atual, 'fone')
  })

  await t.test('7/8. soma dos títulos e valor em aberto corretos (2 títulos do mesmo cliente)', async () => {
    await limparTudo()
    const telefone = telefoneDeTeste()
    const codigo = `CLI-REVISAO-${Date.now()}`
    const contaA = await criarContaDeTeste(supabase, { telefone_cobranca: telefone, codigo_cliente: codigo, valor: 300, valor_pago: 50 })
    const contaB = await criarContaDeTeste(supabase, { telefone_cobranca: telefone, codigo_cliente: codigo, valor: 200, valor_pago: 0 })
    await registrarFalhaPermanentRecipient({ contaId: contaA.id, telefone, criadoEm: new Date().toISOString() })

    const { body } = await chamar()
    const item = body.itens.find((i) => i.codigo_cliente === codigo)
    assert.equal(item.titulos_em_aberto, 2)
    assert.equal(item.valor_em_aberto, 450, '(300-50) + (200-0) = 450')
  })

  await t.test('9. telefone novo após sync (diferente, sem DNC próprio) -> resolvido_automaticamente', async () => {
    await limparTudo()
    const telefoneAntigo = telefoneDeTeste()
    const telefoneNovo = telefoneDeTeste()
    const codigo = `CLI-REVISAO-${Date.now()}`
    // conta já reflete o telefone NOVO (como ficaria após o próximo sync
    // trazer o cadastro corrigido do NetVision)
    const conta = await criarContaDeTeste(supabase, { telefone_cobranca: telefoneNovo, codigo_cliente: codigo })
    // mas a falha histórica registrada foi contra o telefone ANTIGO
    await registrarFalhaPermanentRecipient({ contaId: conta.id, telefone: telefoneAntigo, criadoEm: new Date(Date.now() - 3 * 86400000).toISOString() })
    await registrarDnc({ telefone: telefoneAntigo, motivo: 'numero_invalido_whatsapp', expiraEm: new Date(Date.now() + 27 * 86400000).toISOString() })

    const { body } = await chamar()
    const item = body.itens.find((i) => i.codigo_cliente === codigo)
    assert.equal(item.status, 'resolvido_automaticamente')
    assert.equal(item.telefone_cobranca_atual, telefoneNovo)
  })

  await t.test('10. DNC antigo permanece intocado (rota é 100% leitura)', async () => {
    await limparTudo()
    const telefone = telefoneDeTeste()
    const codigo = `CLI-REVISAO-${Date.now()}`
    const conta = await criarContaDeTeste(supabase, { telefone_cobranca: telefone, codigo_cliente: codigo })
    await registrarFalhaPermanentRecipient({ contaId: conta.id, telefone, criadoEm: new Date().toISOString() })
    await registrarDnc({ telefone, motivo: 'numero_invalido_whatsapp', expiraEm: new Date(Date.now() + 29 * 86400000).toISOString() })

    const { data: antes } = await supabase.from('collection_do_not_contact').select('*').eq('cliente_telefone', telefone).single()
    await chamar()
    await chamar('?status=pendente')
    const { data: depois } = await supabase.from('collection_do_not_contact').select('*').eq('cliente_telefone', telefone).single()
    assert.deepEqual(antes, depois, 'nenhum campo do DNC deveria mudar só por chamar a rota de leitura')
  })

  await t.test('11. paginação', async () => {
    await limparTudo()
    for (let i = 0; i < 5; i++) {
      const telefone = telefoneDeTeste()
      const codigo = `CLI-REVISAO-PAG-${Date.now()}-${i}`
      const conta = await criarContaDeTeste(supabase, { telefone_cobranca: telefone, codigo_cliente: codigo })
      await registrarFalhaPermanentRecipient({ contaId: conta.id, telefone, criadoEm: new Date().toISOString() })
    }
    const { body } = await chamar('?tamanho_pagina=2&pagina=1')
    assert.equal(body.itens.length, 2)
    assert.equal(body.paginacao.tamanho_pagina, 2)
    assert.ok(body.paginacao.total_itens >= 5)
    assert.ok(body.paginacao.total_paginas >= 3)
  })

  await t.test('12. filtros (status, alternativa, quarentena)', async () => {
    await limparTudo()
    const telefonePendente = telefoneDeTeste()
    const codigoPendente = `CLI-REVISAO-${Date.now()}-p`
    const contaPendente = await criarContaDeTeste(supabase, { telefone_cobranca: telefonePendente, codigo_cliente: codigoPendente })
    await registrarFalhaPermanentRecipient({ contaId: contaPendente.id, telefone: telefonePendente, criadoEm: new Date().toISOString() })
    await registrarDnc({ telefone: telefonePendente, motivo: 'numero_invalido_whatsapp', expiraEm: new Date(Date.now() + 29 * 86400000).toISOString() })

    const telefoneAntigo2 = telefoneDeTeste()
    const telefoneNovo2 = telefoneDeTeste()
    const codigoResolvido = `CLI-REVISAO-${Date.now()}-r`
    const contaResolvida = await criarContaDeTeste(supabase, { telefone_cobranca: telefoneNovo2, codigo_cliente: codigoResolvido })
    await registrarFalhaPermanentRecipient({ contaId: contaResolvida.id, telefone: telefoneAntigo2, criadoEm: new Date(Date.now() - 86400000).toISOString() })
    await registrarDnc({ telefone: telefoneAntigo2, motivo: 'numero_invalido_whatsapp', expiraEm: new Date(Date.now() + 29 * 86400000).toISOString() })

    const { body: soPendentes } = await chamar('?status=pendente')
    assert.ok(soPendentes.itens.every((i) => i.status === 'pendente'))
    assert.ok(soPendentes.itens.some((i) => i.codigo_cliente === codigoPendente))
    assert.ok(!soPendentes.itens.some((i) => i.codigo_cliente === codigoResolvido))

    const { body: soResolvidos } = await chamar('?status=resolvido_automaticamente')
    assert.ok(soResolvidos.itens.some((i) => i.codigo_cliente === codigoResolvido))
  })

  await t.test('13. autorização: sem token -> 401', async () => {
    const { status } = await chamar('', { comAuth: false })
    assert.equal(status, 401)
  })

  await t.test('15. nenhuma mensagem real enviada ao consultar a fila', async () => {
    await limparTudo()
    fakeEvolution.resetar()
    const telefone = telefoneDeTeste()
    const conta = await criarContaDeTeste(supabase, { telefone_cobranca: telefone, codigo_cliente: `CLI-REVISAO-${Date.now()}` })
    await registrarFalhaPermanentRecipient({ contaId: conta.id, telefone, criadoEm: new Date().toISOString() })

    await chamar()
    assert.equal(fakeEvolution.mensagensEnviadas.length, 0)
  })
})
