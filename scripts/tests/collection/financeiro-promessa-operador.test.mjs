// 2026-09-02 — pedido "EXPERIÊNCIA OPERACIONAL DE NEGOCIAÇÃO / PROMESSAS":
// GET/POST /api/financeiro/:id/promessa + POST .../promessa/cancelar. Rotas
// reais, montadas exatamente como em produção (auth + adminOnly nas
// mutations, mesmo padrão do restante de financeiro.js), Postgres local.
// Nenhum WhatsApp real em nenhum cenário. Nunca cria pagamento/baixa/quitação
// manual — só a promessa em si.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import jwt from 'jsonwebtoken'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste, criarContaDeTeste } from './_setup.mjs'

let supabase, server, porta, tokenNaoAdmin

before(async () => {
  await iniciarAmbienteDeTeste()
  ;({ supabase } = await import('../../../src/lib/supabase-admin.server.js'))
  process.env.API_SECRET_KEY = 'chave-teste-financeiro-promessa'
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-teste'
  tokenNaoAdmin = jwt.sign({ id: 'usuario-nao-admin', email: 'vendedor@teste.com', role: 'vendedor' }, process.env.JWT_SECRET)

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

function chamar(method, path, { comAuth = true, token = 'chave-teste-financeiro-promessa', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const headers = comAuth ? { authorization: `Bearer ${token}` } : {}
    if (body) headers['content-type'] = 'application/json'
    const req = http.request({ host: '127.0.0.1', port: porta, method, path, headers }, (res) => {
      let chunks = ''
      res.on('data', (c) => { chunks += c })
      res.on('end', () => resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null }))
    })
    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

const AMANHA = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10)
const ONTEM = new Date(Date.now() - 1 * 86400000).toISOString().slice(0, 10)
const DAQUI_200_DIAS = new Date(Date.now() + 200 * 86400000).toISOString().slice(0, 10)

test('GET/POST /api/financeiro/:id/promessa + cancelar', async (t) => {
  const { timelineDoTitulo } = await import('../../../src/lib/collection/timeline.js')

  await t.test('1. GET sem promessa -> promessa: null', async () => {
    const conta = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 0 })
    const { status, body } = await chamar('GET', `/api/financeiro/${conta.id}/promessa`)
    assert.equal(status, 200)
    assert.equal(body.promessa, null)
  })

  await t.test('2. POST cria promessa válida -> 201, saldo do título usado como valor (sem campo valor no payload)', async () => {
    const conta = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 100 })
    const { status, body } = await chamar('POST', `/api/financeiro/${conta.id}/promessa`, { body: { data_prometida: AMANHA, observacao: 'Cliente confirmou por telefone' } })
    assert.equal(status, 201)
    assert.equal(String(body.promessa.promised_date).slice(0, 10), AMANHA)
    assert.equal(Number(body.promessa.valor), 400, 'valor = saldo devedor (500-100), nunca inventado/parcial')
    assert.equal(body.promessa.notes, 'Cliente confirmou por telefone')
    assert.equal(body.promessa.origem, 'HUMAN')
  })

  await t.test('3. GET com promessa ativa -> retorna a promessa criada', async () => {
    const conta = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 0 })
    await chamar('POST', `/api/financeiro/${conta.id}/promessa`, { body: { data_prometida: AMANHA } })
    const { status, body } = await chamar('GET', `/api/financeiro/${conta.id}/promessa`)
    assert.equal(status, 200)
    assert.equal(body.promessa.contas_financeiras_id, conta.id)
    assert.equal(body.promessa.status, 'ativa')
  })

  await t.test('4. data passada -> 400, nenhuma promessa criada', async () => {
    const conta = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 0 })
    const { status, body } = await chamar('POST', `/api/financeiro/${conta.id}/promessa`, { body: { data_prometida: ONTEM } })
    assert.equal(status, 400)
    assert.match(body.erro, /passada/)
    const check = await chamar('GET', `/api/financeiro/${conta.id}/promessa`)
    assert.equal(check.body.promessa, null)
  })

  await t.test('4b. data mais de 90 dias no futuro -> 400', async () => {
    const conta = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 0 })
    const { status, body } = await chamar('POST', `/api/financeiro/${conta.id}/promessa`, { body: { data_prometida: DAQUI_200_DIAS } })
    assert.equal(status, 400)
    assert.match(body.erro, /90 dias/)
  })

  await t.test('4c. formato de data inválido -> 400', async () => {
    const conta = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 0 })
    const { status } = await chamar('POST', `/api/financeiro/${conta.id}/promessa`, { body: { data_prometida: '15/09/2026' } })
    assert.equal(status, 400)
  })

  await t.test('4d. limite de "hoje" respeita fuso America/Sao_Paulo, não UTC/horário local do processo — caso próximo da meia-noite BRT', async (subT) => {
    // 02:00 UTC = 23:00 BRT do dia ANTERIOR (BRT = UTC-3). Nesse instante,
    // "hoje" em UTC já virou o dia seguinte, mas "hoje" em BRT ainda é o dia
    // anterior — validarDataPrometida() usa hojeBrtISO(), não Date local.
    subT.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-10T02:00:00Z') })
    const hojeBrt = '2026-09-09'
    const ontemBrt = '2026-09-08'

    const conta = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 0 })
    const rHoje = await chamar('POST', `/api/financeiro/${conta.id}/promessa`, { body: { data_prometida: hojeBrt } })
    assert.equal(rHoje.status, 201, '"hoje" em BRT precisa ser aceito mesmo com o relógio UTC do processo já no dia seguinte')

    const conta2 = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 0 })
    const rOntem = await chamar('POST', `/api/financeiro/${conta2.id}/promessa`, { body: { data_prometida: ontemBrt } })
    assert.equal(rOntem.status, 400, '"ontem" em BRT precisa continuar bloqueado como data passada')
  })

  await t.test('5. título inexistente -> 404', async () => {
    const { status } = await chamar('POST', '/api/financeiro/00000000-0000-0000-0000-000000000000/promessa', { body: { data_prometida: AMANHA } })
    assert.equal(status, 404)
  })

  await t.test('6. título quitado -> 409, motivo=quitado, nenhuma promessa criada', async () => {
    const conta = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 500 })
    const { status, body } = await chamar('POST', `/api/financeiro/${conta.id}/promessa`, { body: { data_prometida: AMANHA } })
    assert.equal(status, 409)
    assert.equal(body.motivo, 'quitado')
  })

  await t.test('7. título cancelado -> 409, motivo=cancelado', async () => {
    const conta = await criarContaDeTeste(supabase, { status: 'cancelada', valor: 500, valor_pago: 0 })
    const { status, body } = await chamar('POST', `/api/financeiro/${conta.id}/promessa`, { body: { data_prometida: AMANHA } })
    assert.equal(status, 409)
    assert.equal(body.motivo, 'cancelado')
  })

  await t.test('8. título em revisão financeira -> 409, motivo=em_revisao_financeira (revisão NUNCA é tratada como pagamento)', async () => {
    const conta = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 0, em_revisao_financeira: true })
    const { status, body } = await chamar('POST', `/api/financeiro/${conta.id}/promessa`, { body: { data_prometida: AMANHA } })
    assert.equal(status, 409)
    assert.equal(body.motivo, 'em_revisao_financeira')
  })

  await t.test('9. observação sanitizada: HTML cru rejeitado (400), texto normal trimado e aceito', async () => {
    const conta = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 0 })
    const comHtml = await chamar('POST', `/api/financeiro/${conta.id}/promessa`, { body: { data_prometida: AMANHA, observacao: '<script>alert(1)</script>' } })
    assert.equal(comHtml.status, 400)

    const conta2 = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 0 })
    const comEspacos = await chamar('POST', `/api/financeiro/${conta2.id}/promessa`, { body: { data_prometida: AMANHA, observacao: '   nota com espaços   ' } })
    assert.equal(comEspacos.status, 201)
    assert.equal(comEspacos.body.promessa.notes, 'nota com espaços')
  })

  await t.test('9b. observação acima do limite de tamanho -> 400', async () => {
    const conta = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 0 })
    const { status } = await chamar('POST', `/api/financeiro/${conta.id}/promessa`, { body: { data_prometida: AMANHA, observacao: 'x'.repeat(281) } })
    assert.equal(status, 400)
  })

  await t.test('10. duplicidade: 2ª promessa sem "substituir" -> 409, não cria/cancela nada', async () => {
    const conta = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 0 })
    const r1 = await chamar('POST', `/api/financeiro/${conta.id}/promessa`, { body: { data_prometida: AMANHA } })
    assert.equal(r1.status, 201)
    const r2 = await chamar('POST', `/api/financeiro/${conta.id}/promessa`, { body: { data_prometida: AMANHA } })
    assert.equal(r2.status, 409)
    assert.equal(r2.body.promessa_existente.id, r1.body.promessa.id)

    const check = await chamar('GET', `/api/financeiro/${conta.id}/promessa`)
    assert.equal(check.body.promessa.id, r1.body.promessa.id, 'a primeira promessa continua ativa, intocada')
  })

  await t.test('10b. substituir:true -> cancela a anterior e cria nova (ação explícita, auditável)', async () => {
    const conta = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 0 })
    const r1 = await chamar('POST', `/api/financeiro/${conta.id}/promessa`, { body: { data_prometida: AMANHA } })
    const novaData = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10)
    const r2 = await chamar('POST', `/api/financeiro/${conta.id}/promessa`, { body: { data_prometida: novaData, substituir: true } })
    assert.equal(r2.status, 200)
    assert.notEqual(r2.body.promessa.id, r1.body.promessa.id)

    const { data: anterior } = await supabase.from('collection_promises').select('status').eq('id', r1.body.promessa.id).single()
    assert.equal(anterior.status, 'cancelada')
  })

  await t.test('11. cancelar promessa ativa explicitamente -> promessa fica cancelada, título liberado', async () => {
    const conta = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 0 })
    const r1 = await chamar('POST', `/api/financeiro/${conta.id}/promessa`, { body: { data_prometida: AMANHA } })
    const rCancelar = await chamar('POST', `/api/financeiro/${conta.id}/promessa/cancelar`, { body: { motivo: 'Cliente desistiu' } })
    assert.equal(rCancelar.status, 200)
    assert.equal(rCancelar.body.promessa.id, r1.body.promessa.id)
    assert.equal(rCancelar.body.promessa.status, 'cancelada')

    const check = await chamar('GET', `/api/financeiro/${conta.id}/promessa`)
    assert.equal(check.body.promessa, null)
  })

  await t.test('11b. cancelar sem promessa ativa -> 404', async () => {
    const conta = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 0 })
    const { status } = await chamar('POST', `/api/financeiro/${conta.id}/promessa/cancelar`)
    assert.equal(status, 404)
  })

  await t.test('11c. cancelamento idempotente: repetir cancelar sobre a mesma promessa já cancelada -> 2ª tentativa 404 coerente, sem 2º evento PROMESSA_CANCELADA', async () => {
    const conta = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 0 })
    await chamar('POST', `/api/financeiro/${conta.id}/promessa`, { body: { data_prometida: AMANHA } })
    const r1 = await chamar('POST', `/api/financeiro/${conta.id}/promessa/cancelar`)
    assert.equal(r1.status, 200)
    const r2 = await chamar('POST', `/api/financeiro/${conta.id}/promessa/cancelar`)
    assert.equal(r2.status, 404, 'a 2ª tentativa não encontra mais promessa ativa — resposta coerente, nunca finge sucesso de novo')

    const eventos = await timelineDoTitulo(conta.id)
    assert.equal(eventos.filter((e) => e.tipo === 'PROMESSA_CANCELADA').length, 1, 'repetir o cancelamento não pode gerar um 2º evento falso')
  })

  await t.test('12A. concorrência — duas CRIAÇÕES simultâneas sem promessa anterior: 1 vence (201), 1 perde com 409 coerente (nunca 500), no máximo 1 ativa, timeline sem evento falso', async () => {
    const conta = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 0 })
    const [r1, r2] = await Promise.all([
      chamar('POST', `/api/financeiro/${conta.id}/promessa`, { body: { data_prometida: AMANHA } }),
      chamar('POST', `/api/financeiro/${conta.id}/promessa`, { body: { data_prometida: AMANHA } }),
    ])
    const respostas = [r1, r2]
    const vencedoras = respostas.filter((r) => r.status === 201)
    const perdedoras = respostas.filter((r) => r.status !== 201)
    assert.equal(vencedoras.length, 1, 'exatamente 1 das 2 chamadas deveria criar de fato (201)')
    assert.equal(perdedoras.length, 1)
    assert.equal(perdedoras[0].status, 409, 'a perdedora precisa de uma resposta coerente (409), nunca 500 bruto de constraint')
    assert.ok(perdedoras[0].body.erro)

    const { data: ativas } = await supabase.from('collection_promises').select('id').eq('contas_financeiras_id', conta.id).eq('status', 'ativa')
    assert.equal(ativas.length, 1, 'no máximo 1 promessa ativa no final')

    const eventos = await timelineDoTitulo(conta.id)
    assert.equal(eventos.filter((e) => e.tipo === 'PROMESSA_PAGAMENTO').length, 1, 'PROMESSA_PAGAMENTO só pela chamada que realmente criou — a perdedora não registra evento falso de sucesso')
    assert.equal(eventos.filter((e) => e.tipo === 'PROMESSA_SUBSTITUIDA').length, 0, 'não havia promessa anterior — não pode ter substituído nada')
  })

  await t.test('12B. concorrência — duas SUBSTITUIÇÕES simultâneas sobre a mesma promessa ativa: estado final coerente, promessa anterior cancelada no máximo 1x, PROMESSA_SUBSTITUIDA nunca duplicado', async () => {
    const conta = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 0 })
    const original = await chamar('POST', `/api/financeiro/${conta.id}/promessa`, { body: { data_prometida: AMANHA } })
    assert.equal(original.status, 201)

    const dataB = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10)
    const dataC = new Date(Date.now() + 15 * 86400000).toISOString().slice(0, 10)
    const [rB, rC] = await Promise.all([
      chamar('POST', `/api/financeiro/${conta.id}/promessa`, { body: { data_prometida: dataB, substituir: true } }),
      chamar('POST', `/api/financeiro/${conta.id}/promessa`, { body: { data_prometida: dataC, substituir: true } }),
    ])
    const respostas = [rB, rC]
    const vencedoras = respostas.filter((r) => r.status === 200)
    const perdedoras = respostas.filter((r) => r.status !== 200)
    assert.equal(vencedoras.length, 1, 'exatamente 1 substituição vence de fato')
    assert.equal(perdedoras.length, 1)
    assert.equal(perdedoras[0].status, 409, 'a perdedora recebe 409 coerente, nunca 500')

    const { data: ativas } = await supabase.from('collection_promises').select('id').eq('contas_financeiras_id', conta.id).eq('status', 'ativa')
    assert.equal(ativas.length, 1, 'exatamente 1 ativa no final')

    const { data: original_bd } = await supabase.from('collection_promises').select('status').eq('id', original.body.promessa.id).single()
    assert.equal(original_bd.status, 'cancelada')

    const eventos = await timelineDoTitulo(conta.id)
    assert.equal(eventos.filter((e) => e.tipo === 'PROMESSA_SUBSTITUIDA').length, 1, 'a promessa original só pode ter sido substituída UMA vez, mesmo com 2 chamadas concorrentes tentando')
    assert.equal(eventos.filter((e) => e.tipo === 'PROMESSA_PAGAMENTO').length, 2, '1 da promessa original + 1 da substituta vencedora — a perdedora nunca chega a registrar PROMESSA_PAGAMENTO')
  })

  await t.test('12C. concorrência — CANCELAR e SUBSTITUIR simultâneos sobre a mesma promessa ativa: estado final determinístico, evento só quando a transição correspondente realmente ocorreu', async () => {
    const conta = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 0 })
    const original = await chamar('POST', `/api/financeiro/${conta.id}/promessa`, { body: { data_prometida: AMANHA } })
    assert.equal(original.status, 201)

    const novaData = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10)
    const [rCancelar, rSubstituir] = await Promise.all([
      chamar('POST', `/api/financeiro/${conta.id}/promessa/cancelar`, {}),
      chamar('POST', `/api/financeiro/${conta.id}/promessa`, { body: { data_prometida: novaData, substituir: true } }),
    ])

    // Estado final determinístico: OU (a) cancelar venceu e não sobrou
    // promessa nova (substituir não achou nada pra substituir — ver nota
    // abaixo), OU (b) substituir vez a promessa original antes do cancelar
    // rodar, e o cancelar então cancela a promessa NOVA (comportamento correto
    // e esperado de "cancelar a que estiver ativa agora" — nunca um erro,
    // nunca duas ativas).
    const { data: ativasFinal } = await supabase.from('collection_promises').select('id, promised_date, status').eq('contas_financeiras_id', conta.id).eq('status', 'ativa')
    assert.ok(ativasFinal.length <= 1, 'nunca mais de 1 ativa no final, não importa a ordem real de execução')

    const { data: todasFinal } = await supabase.from('collection_promises').select('id, status').eq('contas_financeiras_id', conta.id)
    const canceladas = todasFinal.filter((p) => p.status === 'cancelada')
    assert.ok(canceladas.length >= 1, 'pelo menos a promessa original terminou cancelada, de um jeito ou de outro')

    // Nunca as duas operações relatam sucesso "criando confusão" — cancelar
    // só reporta sucesso (200) se de fato cancelou algo; se não havia nada
    // ativo no momento exato da sua transição condicional, reporta 404, nunca
    // finge sucesso.
    assert.ok([200, 404].includes(rCancelar.status), `cancelar precisa responder 200 (cancelou de verdade) ou 404 (nada ativo no momento) — nunca outra coisa (recebido ${rCancelar.status})`)
    assert.ok([200, 201, 409].includes(rSubstituir.status), `substituir precisa responder 200/201 (criou de verdade) ou 409 (perdeu a corrida) — nunca 500 (recebido ${rSubstituir.status})`)

    // A quantidade de eventos de cancelamento/substituição bate exatamente
    // com o que aconteceu de verdade no banco — nunca um evento "extra" só
    // porque duas requisições tentaram ao mesmo tempo.
    const eventos = await timelineDoTitulo(conta.id)
    const totalCancelSubst = eventos.filter((e) => e.tipo === 'PROMESSA_CANCELADA').length + eventos.filter((e) => e.tipo === 'PROMESSA_SUBSTITUIDA').length
    assert.ok(totalCancelSubst <= 1, `a promessa original só pode ter sido resolvida (cancelada OU substituída) 1 vez — encontrado ${totalCancelSubst} evento(s)`)
  })

  await t.test('13. timeline recebe exatamente 1 PROMESSA_PAGAMENTO na criação', async () => {
    const conta = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 0 })
    await chamar('POST', `/api/financeiro/${conta.id}/promessa`, { body: { data_prometida: AMANHA } })
    const eventos = await timelineDoTitulo(conta.id)
    assert.equal(eventos.filter((e) => e.tipo === 'PROMESSA_PAGAMENTO').length, 1)
  })

  await t.test('14. timeline recebe PROMESSA_SUBSTITUIDA na substituição e exatamente 1 PROMESSA_CANCELADA no cancelamento explícito', async () => {
    const contaSub = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 0 })
    await chamar('POST', `/api/financeiro/${contaSub.id}/promessa`, { body: { data_prometida: AMANHA } })
    await chamar('POST', `/api/financeiro/${contaSub.id}/promessa`, { body: { data_prometida: AMANHA, substituir: true } })
    const eventosSub = await timelineDoTitulo(contaSub.id)
    assert.equal(eventosSub.filter((e) => e.tipo === 'PROMESSA_SUBSTITUIDA').length, 1)
    assert.equal(eventosSub.filter((e) => e.tipo === 'PROMESSA_PAGAMENTO').length, 2, '1 da promessa original + 1 da substituta')

    const contaCancel = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 0 })
    await chamar('POST', `/api/financeiro/${contaCancel.id}/promessa`, { body: { data_prometida: AMANHA } })
    await chamar('POST', `/api/financeiro/${contaCancel.id}/promessa/cancelar`)
    const eventosCancel = await timelineDoTitulo(contaCancel.id)
    assert.equal(eventosCancel.filter((e) => e.tipo === 'PROMESSA_CANCELADA').length, 1)
  })

  await t.test('14b. PROMESSA_CANCELADA na timeline consultável (GET /:id/timeline): label reconhecido (nunca "evento desconhecido"), metadata sem promise_id/UUID/telefone/segredo', async () => {
    const conta = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 0 })
    await chamar('POST', `/api/financeiro/${conta.id}/promessa`, { body: { data_prometida: AMANHA } })
    await chamar('POST', `/api/financeiro/${conta.id}/promessa/cancelar`, { body: { motivo: 'Cliente desistiu' } })

    const { status, body } = await chamar('GET', `/api/financeiro/${conta.id}/timeline`)
    assert.equal(status, 200)
    const evCancelado = body.eventos.find((e) => e.tipo === 'PROMESSA_CANCELADA')
    assert.ok(evCancelado, 'PROMESSA_CANCELADA precisa aparecer na timeline consultável')
    assert.equal(evCancelado.label, 'Promessa cancelada', 'label reconhecido, nunca cai como tipo bruto/desconhecido')
    assert.ok(evCancelado.resumo, 'resumo (descrição legível) presente')
    const metadataStr = JSON.stringify(evCancelado.metadata)
    assert.ok(!('promise_id' in evCancelado.metadata), 'metadata não pode expor o UUID interno da promessa')
    assert.doesNotMatch(metadataStr, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, 'metadata não pode conter nenhum UUID')
    assert.doesNotMatch(metadataStr, /telefone|phone|token|secret|senha/i, 'metadata não pode expor telefone/token/segredo')
  })

  await t.test('15. sem auth -> 401 (GET e POST)', async () => {
    const conta = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 0 })
    const rGet = await chamar('GET', `/api/financeiro/${conta.id}/promessa`, { comAuth: false })
    assert.equal(rGet.status, 401)
    const rPost = await chamar('POST', `/api/financeiro/${conta.id}/promessa`, { comAuth: false, body: { data_prometida: AMANHA } })
    assert.equal(rPost.status, 401)
  })

  await t.test('16. sem permissão de admin -> 403 nas mutations (POST criar e POST cancelar) — GET continua liberado pra qualquer autenticado, mesmo padrão do resto do módulo', async () => {
    const conta = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 0 })
    const rPost = await chamar('POST', `/api/financeiro/${conta.id}/promessa`, { token: tokenNaoAdmin, body: { data_prometida: AMANHA } })
    assert.equal(rPost.status, 403)
    const rCancelar = await chamar('POST', `/api/financeiro/${conta.id}/promessa/cancelar`, { token: tokenNaoAdmin })
    assert.equal(rCancelar.status, 403)
    const rGet = await chamar('GET', `/api/financeiro/${conta.id}/promessa`, { token: tokenNaoAdmin })
    assert.equal(rGet.status, 200)
  })

  await t.test('17. nenhuma ação desta rota emite PAGO ou PROMESSA_CUMPRIDA (esses continuam exclusivos do lifecycle real de pagamento)', async () => {
    const conta = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 0 })
    await chamar('POST', `/api/financeiro/${conta.id}/promessa`, { body: { data_prometida: AMANHA } })
    await chamar('POST', `/api/financeiro/${conta.id}/promessa`, { body: { data_prometida: AMANHA, substituir: true } })
    await chamar('POST', `/api/financeiro/${conta.id}/promessa/cancelar`)
    const eventos = await timelineDoTitulo(conta.id)
    assert.equal(eventos.filter((e) => e.tipo === 'PAGO').length, 0)
    assert.equal(eventos.filter((e) => e.tipo === 'PROMESSA_CUMPRIDA').length, 0)

    const { data: contaApos } = await supabase.from('contas_financeiras').select('status, valor_pago').eq('id', conta.id).single()
    assert.equal(contaApos.status, 'aberta', 'status do título nunca é alterado por esta rota')
    assert.equal(Number(contaApos.valor_pago), 0, 'valor_pago nunca é alterado por esta rota')
  })
})
