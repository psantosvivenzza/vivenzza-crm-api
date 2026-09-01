// 2026-09-01 — pedido "TIMELINE FINANCEIRA CONSULTÁVEL POR TÍTULO":
// GET /api/financeiro/:id/timeline. Rota real, montada exatamente como em
// produção (auth, sem adminOnly — mesma regra do resto de financeiro.js),
// Postgres local. Somente leitura em todos os cenários — nenhuma
// mutação/WhatsApp real.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste, criarContaDeTeste } from './_setup.mjs'

let supabase, server, porta

before(async () => {
  await iniciarAmbienteDeTeste()
  ;({ supabase } = await import('../../../src/lib/supabase-admin.server.js'))
  process.env.API_SECRET_KEY = 'chave-teste-financeiro-timeline'

  const express = (await import('express')).default
  const { auth } = await import('../../../src/middleware/auth.js')
  const router = (await import('../../../src/routes/financeiro.js')).default
  const app = express()
  app.use(express.json())
  app.use('/api/financeiro', auth, router)
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  porta = server.address().port
})
after(async () => {
  server?.close()
  await pararAmbienteDeTeste()
})

function chamar(path, { comAuth = true } = {}) {
  return new Promise((resolve, reject) => {
    const headers = comAuth ? { authorization: 'Bearer chave-teste-financeiro-timeline' } : {}
    const req = http.request({ host: '127.0.0.1', port: porta, method: 'GET', path, headers }, (res) => {
      let chunks = ''
      res.on('data', (c) => { chunks += c })
      res.on('end', () => resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('GET /api/financeiro/:id/timeline', async (t) => {
  const { registrarEvento, ORIGEM } = await import('../../../src/lib/collection/timeline.js')
  const { registrarPromessa } = await import('../../../src/lib/collection/promises.js')
  const { cancelarAutomacaoPorPagamento } = await import('../../../src/lib/collection/paymentGuard.js')

  await t.test('A. título existente sem eventos -> 200 com lista vazia', async () => {
    const conta = await criarContaDeTeste(supabase, { status: 'aberta' })
    const { status, body } = await chamar(`/api/financeiro/${conta.id}/timeline`)
    assert.equal(status, 200)
    assert.equal(body.titulo_id, conta.id)
    assert.equal(body.total, 0)
    assert.deepEqual(body.eventos, [])
  })

  await t.test('B. título com vários eventos -> ordem cronológica (mais antigo primeiro, ordem canônica do backend)', async () => {
    const conta = await criarContaDeTeste(supabase, { status: 'aberta' })
    await registrarEvento({ contasFinanceirasId: conta.id, tipo: 'MENSAGEM_ENVIADA', origem: ORIGEM.AUTOMATION, descricao: 'evento 1', dados: { provider_message_id: 'MSG1' } })
    await new Promise((r) => setTimeout(r, 5))
    await registrarEvento({ contasFinanceirasId: conta.id, tipo: 'MENSAGEM_FALHOU', origem: ORIGEM.SYSTEM, descricao: 'evento 2' })
    await new Promise((r) => setTimeout(r, 5))
    await registrarEvento({ contasFinanceirasId: conta.id, tipo: 'COBRANCA_BLOQUEADA_OPT_OUT', origem: ORIGEM.SYSTEM, descricao: 'evento 3', dados: { reason: 'opt_out' } })

    const { status, body } = await chamar(`/api/financeiro/${conta.id}/timeline`)
    assert.equal(status, 200)
    assert.equal(body.total, 3)
    assert.equal(body.eventos.length, 3)
    assert.deepEqual(body.eventos.map((e) => e.tipo), ['MENSAGEM_ENVIADA', 'MENSAGEM_FALHOU', 'COBRANCA_BLOQUEADA_OPT_OUT'])
    const datas = body.eventos.map((e) => new Date(e.criado_em).getTime())
    assert.ok(datas[0] <= datas[1] && datas[1] <= datas[2], 'crescente por criado_em')
  })

  await t.test('C. título inexistente -> 404', async () => {
    const { status, body } = await chamar('/api/financeiro/00000000-0000-0000-0000-000000000000/timeline')
    assert.equal(status, 404)
    assert.ok(body.erro)
  })

  await t.test('D. sem auth -> 401', async () => {
    const conta = await criarContaDeTeste(supabase, { status: 'aberta' })
    const { status } = await chamar(`/api/financeiro/${conta.id}/timeline`, { comAuth: false })
    assert.equal(status, 401)
  })

  await t.test('E. autorização: rota usa exatamente a mesma regra do resto de /api/financeiro (auth, sem camada extra de permissão/role) — não existe conceito de role "financeiro" no projeto hoje (confirmado: só auth/adminOnly existem em src/middleware/auth.js), então não há 403 nesta rota, igual às demais de financeiro.js', async () => {
    const conta = await criarContaDeTeste(supabase, { status: 'aberta' })
    const { status } = await chamar(`/api/financeiro/${conta.id}/timeline`)
    assert.equal(status, 200, 'qualquer usuário autenticado tem acesso — mesmo comportamento de GET /api/financeiro/:id')
  })

  await t.test('F. metadata sensível não aparece na resposta — só campos allowlisted por tipo, nunca "dados" bruto', async () => {
    const conta = await criarContaDeTeste(supabase, { status: 'aberta' })
    await registrarEvento({
      contasFinanceirasId: conta.id, tipo: 'MENSAGEM_ENVIADA', origem: ORIGEM.AUTOMATION, descricao: 'evento',
      dados: { dispatch_id: 'uuid-interno-1', attempt_id: 'uuid-interno-2', instance_id: 'uuid-interno-3', provider_message_id: 'MSG-REAL-123', token_nunca_deveria_existir_aqui: 'segredo-x' },
    })
    const { status, body } = await chamar(`/api/financeiro/${conta.id}/timeline`)
    assert.equal(status, 200)
    const evento = body.eventos[0]
    assert.deepEqual(Object.keys(evento).sort(), ['criado_em', 'id', 'label', 'metadata', 'origem', 'resumo', 'tipo'])
    assert.deepEqual(evento.metadata, { provider_message_id: 'MSG-REAL-123' }, 'só o campo allowlisted pra MENSAGEM_ENVIADA aparece — dispatch_id/attempt_id/instance_id/token nunca')
    assert.equal(JSON.stringify(body).includes('uuid-interno'), false)
    assert.equal(JSON.stringify(body).includes('segredo-x'), false)
  })

  await t.test('G. tipo de evento desconhecido -> API não quebra, mostra fallback legível com o código original', async () => {
    const conta = await criarContaDeTeste(supabase, { status: 'aberta' })
    // TIPO_FUTURO_HIPOTETICO não está em nenhum allowlist/label conhecido —
    // prova que um tipo novo, ainda não mapeado, não derruba a rota.
    await registrarEvento({ contasFinanceirasId: conta.id, tipo: 'TIPO_FUTURO_HIPOTETICO', origem: ORIGEM.SYSTEM, descricao: 'evento de tipo novo', dados: { campo_qualquer: 'x' } })
    const { status, body } = await chamar(`/api/financeiro/${conta.id}/timeline`)
    assert.equal(status, 200)
    assert.equal(body.eventos[0].tipo, 'TIPO_FUTURO_HIPOTETICO')
    assert.equal(body.eventos[0].label, 'TIPO_FUTURO_HIPOTETICO', 'fallback: label = o próprio código quando não há label conhecida')
    assert.deepEqual(body.eventos[0].metadata, {}, 'tipo desconhecido nunca expõe dados brutos — allowlist vazia por padrão')
  })

  await t.test('H. eventos PAGO/PROMESSA_CUMPRIDA/PROMESSA_QUEBRADA aparecem corretamente (código real do lifecycle, não simulado)', async () => {
    const conta = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 0 })
    await registrarPromessa({ contasFinanceirasId: conta.id, clienteNome: conta.pessoa_nome, clienteTelefone: conta.telefone_cobranca, valor: 500, promisedDate: '2026-12-01', origem: 'HUMAN' })
    await supabase.from('contas_financeiras').update({ valor_pago: 500 }).eq('id', conta.id)
    await cancelarAutomacaoPorPagamento(conta.id) // código real do PR #62 — emite PAGO + PROMESSA_CUMPRIDA

    const { status, body } = await chamar(`/api/financeiro/${conta.id}/timeline`)
    assert.equal(status, 200)
    const tipos = body.eventos.map((e) => e.tipo)
    assert.ok(tipos.includes('PROMESSA_PAGAMENTO'))
    assert.ok(tipos.includes('PROMESSA_CUMPRIDA'))
    assert.ok(tipos.includes('PAGO'))
    const eventoPago = body.eventos.find((e) => e.tipo === 'PAGO')
    assert.equal(eventoPago.label, 'Pagamento confirmado')
    assert.equal(eventoPago.metadata.promessaCumprida, true)
  })

  await t.test('I. paginação simples funciona (limit/page)', async () => {
    const conta = await criarContaDeTeste(supabase, { status: 'aberta' })
    for (let i = 0; i < 5; i++) {
      await registrarEvento({ contasFinanceirasId: conta.id, tipo: 'MENSAGEM_FALHOU', origem: ORIGEM.SYSTEM, descricao: `evento ${i}` })
    }
    const p1 = await chamar(`/api/financeiro/${conta.id}/timeline?limit=2&page=1`)
    const p2 = await chamar(`/api/financeiro/${conta.id}/timeline?limit=2&page=2`)
    assert.equal(p1.body.total, 5)
    assert.equal(p1.body.eventos.length, 2)
    assert.equal(p2.body.eventos.length, 2)
    assert.notDeepEqual(p1.body.eventos.map((e) => e.id), p2.body.eventos.map((e) => e.id))
  })
})
