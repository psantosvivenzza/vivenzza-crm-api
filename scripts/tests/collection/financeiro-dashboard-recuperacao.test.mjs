// 2026-09-02 — "DASHBOARD DE RECUPERAÇÃO / COBRANÇA — KPIs OPERACIONAIS":
// GET /api/financeiro/dashboard-recuperacao. 100% leitura — nenhuma mutation
// nesta rota, então estes testes só criam fixtures (contas/baixas/promessas/
// dispatches/DNC) pra observar o agregado, nunca chamam endpoint de escrita.
//
// O banco de teste NÃO começa vazio (supabase/seed.sql insere ~16
// contas_financeiras e 2 collection_promises) — por isso quase todo teste
// aqui compara "antes vs depois" (delta), nunca um valor absoluto, exceto
// onde a tabela de origem é garantidamente vazia no início (baixas_financeiras,
// collection_dispatches/attempts, collection_do_not_contact — nenhuma delas
// é seedada).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import jwt from 'jsonwebtoken'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste, criarContaDeTeste, telefoneDeTeste } from './_setup.mjs'
import { invalidarCacheFlags } from '../../../src/lib/collection/featureFlags.js'

let supabase, server, porta, tokenNaoAdmin, multiWhatsappOriginal

before(async () => {
  await iniciarAmbienteDeTeste()
  ;({ supabase } = await import('../../../src/lib/supabase-admin.server.js'))
  process.env.API_SECRET_KEY = 'chave-teste-dashboard-recuperacao'
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-teste'
  tokenNaoAdmin = jwt.sign({ id: 'usuario-nao-admin', email: 'vendedor@teste.com', role: 'vendedor' }, process.env.JWT_SECRET)

  const { data: configAtual } = await supabase.from('automacoes_config').select('multi_whatsapp').eq('id', 1).maybeSingle()
  multiWhatsappOriginal = configAtual?.multi_whatsapp ?? false

  const express = (await import('express')).default
  const { auth, adminOnly } = await import('../../../src/middleware/auth.js')
  const router = (await import('../../../src/routes/dashboard-recuperacao.js')).default
  const app = express()
  app.use(express.json())
  app.use('/api/financeiro/dashboard-recuperacao', auth, adminOnly, router)
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  porta = server.address().port
})
after(async () => {
  await supabase.from('automacoes_config').update({ multi_whatsapp: multiWhatsappOriginal }).eq('id', 1)
  invalidarCacheFlags()
  server?.close()
  await pararAmbienteDeTeste()
})

function chamar(query = '', { comAuth = true, token = 'chave-teste-dashboard-recuperacao' } = {}) {
  return new Promise((resolve, reject) => {
    const headers = comAuth ? { authorization: `Bearer ${token}` } : {}
    const req = http.request({ host: '127.0.0.1', port: porta, method: 'GET', path: `/api/financeiro/dashboard-recuperacao${query}`, headers }, (res) => {
      let chunks = ''
      res.on('data', (c) => { chunks += c })
      res.on('end', () => resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null }))
    })
    req.on('error', reject)
    req.end()
  })
}

function hojeBrtISO() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
}
function diasAtrasISO(dias) {
  const d = new Date(`${hojeBrtISO()}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() - dias)
  return d.toISOString().slice(0, 10)
}
function diasFuturoISO(dias) {
  return diasAtrasISO(-dias)
}

test('GET /api/financeiro/dashboard-recuperacao', async (t) => {
  await t.test('1. sem auth -> 401', async () => {
    const { status } = await chamar('', { comAuth: false })
    assert.equal(status, 401)
  })

  await t.test('2. autenticado sem permissão de admin -> 403', async () => {
    const { status } = await chamar('', { token: tokenNaoAdmin })
    assert.equal(status, 403)
  })

  await t.test('3. admin, sem período informado -> 200, período default = mes, shape completo', async () => {
    const { status, body } = await chamar('')
    assert.equal(status, 200)
    assert.equal(body.periodo.chave, 'mes')
    assert.equal(body.periodo.timezone, 'America/Sao_Paulo')
    for (const grupo of ['saldo', 'aging', 'recuperacao', 'promessas', 'contatos', 'cobranca']) {
      assert.ok(body[grupo], `grupo "${grupo}" ausente na resposta`)
    }
    assert.ok(Array.isArray(body.nao_implementados))
  })

  await t.test('3b. período inválido cai no default (mes), nunca quebra', async () => {
    const { status, body } = await chamar('?periodo=lixo-invalido')
    assert.equal(status, 200)
    assert.equal(body.periodo.chave, 'mes')
  })

  await t.test('4. período "hoje" -> data_inicio === data_fim === hoje BRT', async () => {
    const { body } = await chamar('?periodo=hoje')
    assert.equal(body.periodo.data_inicio, hojeBrtISO())
    assert.equal(body.periodo.data_fim, hojeBrtISO())
  })

  await t.test('5. período "7dias" -> data_inicio = hoje - 6 dias (janela de 7 dias inclusive)', async () => {
    const { body } = await chamar('?periodo=7dias')
    assert.equal(body.periodo.data_inicio, diasAtrasISO(6))
    assert.equal(body.periodo.data_fim, hojeBrtISO())
  })

  await t.test('6. período "30dias" -> data_inicio = hoje - 29 dias', async () => {
    const { body } = await chamar('?periodo=30dias')
    assert.equal(body.periodo.data_inicio, diasAtrasISO(29))
  })

  await t.test('6b. período "mes" -> data_inicio = dia 1 do mês corrente (BRT)', async () => {
    const { body } = await chamar('?periodo=mes')
    assert.equal(body.periodo.data_inicio, `${hojeBrtISO().slice(0, 7)}-01`)
  })

  await t.test('7. timezone: limite de "hoje" usa America/Sao_Paulo, não UTC do processo — perto da meia-noite BRT', async (subT) => {
    // 02:00 UTC = 23:00 BRT do dia anterior — "hoje" em UTC já é amanhã, mas
    // em BRT ainda é o dia anterior (mesmo caso-limite já validado na PR de
    // promessas, aqui reaplicado ao período do dashboard).
    subT.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-10T02:00:00Z') })
    const { body } = await chamar('?periodo=hoje')
    assert.equal(body.periodo.data_inicio, '2026-09-09')
  })

  await t.test('8. aberto/vencido/a vencer: saldo (valor - valor_pago) contabilizado corretamente por bucket temporal', async () => {
    const antes = (await chamar('')).body.saldo

    const contaVencida = await criarContaDeTeste(supabase, { status: 'vencida', valor: 300, valor_pago: 100, vencimento: diasAtrasISO(15) })
    const contaAVencer = await criarContaDeTeste(supabase, { status: 'aberta', valor: 150, valor_pago: 0, vencimento: diasFuturoISO(10) })

    const depois = (await chamar('')).body.saldo
    assert.equal(round2(depois.total_aberto - antes.total_aberto), 350, '200 (vencida) + 150 (a vencer) = 350 a mais em aberto')
    assert.equal(round2(depois.total_vencido - antes.total_vencido), 200, 'só a conta vencida (saldo 300-100=200) entra em vencido')
    assert.equal(round2(depois.total_a_vencer - antes.total_a_vencer), 150, 'só a conta a vencer entra em a_vencer')

    // Cancela pra não poluir os testes de aging/cobrança seguintes.
    await supabase.from('contas_financeiras').update({ status: 'cancelada' }).in('id', [contaVencida.id, contaAVencer.id])
  })

  await t.test('9. aging: cada faixa D+ (1-7/8-15/16-30/31-60/61-90/90+) soma só o saldo com o atraso exato daquela faixa', async () => {
    const antes = (await chamar('')).body.aging

    const fixtures = [
      { faixa: '1_7', dias: 5 },
      { faixa: '8_15', dias: 10 },
      { faixa: '16_30', dias: 20 },
      { faixa: '31_60', dias: 45 },
      { faixa: '61_90', dias: 75 },
      { faixa: '90_mais', dias: 120 },
    ]
    const idsCriados = []
    for (const f of fixtures) {
      const conta = await criarContaDeTeste(supabase, { status: 'vencida', valor: 100, valor_pago: 0, vencimento: diasAtrasISO(f.dias) })
      idsCriados.push(conta.id)
    }

    const depois = (await chamar('')).body.aging
    for (const f of fixtures) {
      assert.equal(round2(depois[f.faixa] - antes[f.faixa]), 100, `faixa ${f.faixa} deveria ter +100 (título com ${f.dias} dias de atraso)`)
    }

    await supabase.from('contas_financeiras').update({ status: 'cancelada' }).in('id', idsCriados)
  })

  await t.test('10. promessas: "ativas" é snapshot atual; "cumpridas"/"quebradas" contam pela data real da transição dentro do período', async () => {
    const antes = (await chamar('?periodo=hoje')).body.promessas

    const contaAtiva = await criarContaDeTeste(supabase, { status: 'vencida' })
    await supabase.from('collection_promises').insert({
      contas_financeiras_id: contaAtiva.id, cliente_nome: 'Teste', cliente_telefone: telefoneDeTeste(),
      valor: 100, promised_date: diasFuturoISO(5), origem: 'HUMAN', status: 'ativa',
    })

    const contaCumprida = await criarContaDeTeste(supabase, { status: 'vencida' })
    await supabase.from('collection_promises').insert({
      contas_financeiras_id: contaCumprida.id, cliente_nome: 'Teste', cliente_telefone: telefoneDeTeste(),
      valor: 100, promised_date: diasAtrasISO(1), origem: 'HUMAN', status: 'cumprida', fulfilled_at: new Date().toISOString(),
    })

    const contaQuebrada = await criarContaDeTeste(supabase, { status: 'vencida' })
    await supabase.from('collection_promises').insert({
      contas_financeiras_id: contaQuebrada.id, cliente_nome: 'Teste', cliente_telefone: telefoneDeTeste(),
      valor: 100, promised_date: diasAtrasISO(1), origem: 'HUMAN', status: 'quebrada', broken_at: new Date().toISOString(),
    })

    // Fora do período "hoje" — não pode contar (prova que o filtro por data é real, não decorativo).
    const contaCumpridaAntiga = await criarContaDeTeste(supabase, { status: 'vencida' })
    await supabase.from('collection_promises').insert({
      contas_financeiras_id: contaCumpridaAntiga.id, cliente_nome: 'Teste', cliente_telefone: telefoneDeTeste(),
      valor: 100, promised_date: '2020-01-05', origem: 'HUMAN', status: 'cumprida', fulfilled_at: '2020-01-10T12:00:00Z',
    })

    const depois = (await chamar('?periodo=hoje')).body.promessas
    assert.equal(depois.ativas - antes.ativas, 1)
    assert.equal(depois.cumpridas_periodo - antes.cumpridas_periodo, 1, 'só a cumprida DENTRO do período de hoje conta — a de 2020 fica de fora')
    assert.equal(depois.quebradas_periodo - antes.quebradas_periodo, 1)
  })

  await t.test('11. revisão financeira: título em revisão soma em contatos.titulos_em_revisao_financeira, mas fica FORA de cobranca.titulos_em_cobranca', async () => {
    const antesContatos = (await chamar('')).body.contatos
    const antesCobranca = (await chamar('')).body.cobranca

    const conta = await criarContaDeTeste(supabase, { status: 'aberta', valor: 80, valor_pago: 0, em_revisao_financeira: true })

    const depoisContatos = (await chamar('')).body.contatos
    const depoisCobranca = (await chamar('')).body.cobranca
    assert.equal(depoisContatos.titulos_em_revisao_financeira - antesContatos.titulos_em_revisao_financeira, 1)
    assert.equal(round2(depoisContatos.valor_em_revisao_financeira - antesContatos.valor_em_revisao_financeira), 80)
    assert.equal(depoisCobranca.titulos_em_cobranca - antesCobranca.titulos_em_cobranca, 0, 'título em revisão financeira nunca é contado como "em cobrança"')

    await supabase.from('contas_financeiras').update({ status: 'cancelada' }).eq('id', conta.id)
  })

  await t.test('12. contatos inválidos: só bloqueios AINDA válidos contam — expirado não soma', async () => {
    const antes = (await chamar('')).body.contatos.invalidos_ou_bloqueados

    const telValido = telefoneDeTeste()
    const telExpirado = telefoneDeTeste()
    await supabase.from('collection_do_not_contact').insert([
      { cliente_telefone: telValido, motivo: 'opt-out teste', canal: 'todos', expira_em: null },
      { cliente_telefone: telExpirado, motivo: 'quarentena teste', canal: 'whatsapp', expira_em: '2020-01-01T00:00:00Z' },
    ])

    const depois = (await chamar('')).body.contatos.invalidos_ou_bloqueados
    assert.equal(depois - antes, 1, 'só o bloqueio sem expiração (ou não vencido) conta — o expirado em 2020 não soma')
  })

  await t.test('13. cobrança elegível: título aberto com telefone bloqueado por DNC não entra em titulos_em_cobranca', async () => {
    const antes = (await chamar('')).body.cobranca

    const telBloqueado = telefoneDeTeste()
    await supabase.from('collection_do_not_contact').insert({ cliente_telefone: telBloqueado, motivo: 'teste', canal: 'todos', expira_em: null })
    const contaBloqueada = await criarContaDeTeste(supabase, { status: 'aberta', telefone_cobranca: telBloqueado })

    const telLivre = telefoneDeTeste()
    const contaLivre = await criarContaDeTeste(supabase, { status: 'aberta', telefone_cobranca: telLivre })

    const depois = (await chamar('')).body.cobranca
    assert.equal(depois.titulos_em_cobranca - antes.titulos_em_cobranca, 1, 'só a conta com telefone livre soma — a bloqueada por DNC fica de fora')
    assert.equal(depois.clientes_em_cobranca - antes.clientes_em_cobranca, 1)

    await supabase.from('contas_financeiras').update({ status: 'cancelada' }).in('id', [contaBloqueada.id, contaLivre.id])
  })

  await t.test('14. recebido/recuperado no período: baixa ativa soma em "recebido"; só a paga DEPOIS do vencimento soma em "recuperado"', async () => {
    const antes = (await chamar('?periodo=hoje')).body.recuperacao

    // Pago em dia (vencimento é hoje, pagamento é hoje) — conta em "recebido", não em "recuperado".
    const contaEmDia = await criarContaDeTeste(supabase, { status: 'aberta', valor: 200, vencimento: hojeBrtISO() })
    await supabase.from('baixas_financeiras').insert({ conta_financeira_id: contaEmDia.id, valor_baixado: 200, data_pagamento: hojeBrtISO(), status: 'ativa', origem: 'manual' })

    // Pago com atraso de 10 dias — conta nos dois, e cai na faixa 8_15 de recuperação.
    const contaAtrasada = await criarContaDeTeste(supabase, { status: 'aberta', valor: 300, vencimento: diasAtrasISO(10) })
    await supabase.from('baixas_financeiras').insert({ conta_financeira_id: contaAtrasada.id, valor_baixado: 300, data_pagamento: hojeBrtISO(), status: 'ativa', origem: 'manual' })

    // Baixa ESTORNADA — nunca deve contar em nada (mesma verdade financeira do fn_estornar_baixa).
    const contaEstornada = await criarContaDeTeste(supabase, { status: 'aberta', valor: 999, vencimento: hojeBrtISO() })
    await supabase.from('baixas_financeiras').insert({ conta_financeira_id: contaEstornada.id, valor_baixado: 999, data_pagamento: hojeBrtISO(), status: 'estornada', origem: 'manual' })

    const depois = (await chamar('?periodo=hoje')).body.recuperacao
    assert.equal(round2(depois.recebido_periodo - antes.recebido_periodo), 500, '200 (em dia) + 300 (atrasada) — a estornada (999) nunca soma')
    assert.equal(round2(depois.valor_recuperado_periodo - antes.valor_recuperado_periodo), 300, 'só a paga depois do vencimento conta como "recuperado"')
    assert.equal(round2(depois.recuperado_por_faixa_dias_atraso['8_15'] - antes.recuperado_por_faixa_dias_atraso['8_15']), 300)
  })

  await t.test('15. performance de cobrança (motor v2): tentativas/entregas/falhas batem exatamente com collection_dispatch_attempts, purpose=internal_test é excluído, e divisão por zero é null antes de qualquer fixture', async () => {
    await supabase.from('automacoes_config').update({ multi_whatsapp: true }).eq('id', 1)
    invalidarCacheFlags()

    // 15a — ainda sem nenhum dispatch criado nesta rodada (tabela começa
    // vazia, nenhum outro teste deste arquivo insere em collection_dispatches
    // antes deste ponto): tentativas=0 força divisão por zero — precisa dar
    // null, nunca NaN/Infinity.
    const zero = (await chamar('?periodo=hoje')).body.cobranca
    assert.equal(zero.tentativas_periodo, 0)
    assert.equal(zero.entregas_confirmadas_periodo, 0)
    assert.equal(zero.falhas_periodo, 0)
    assert.equal(zero.taxa_entrega_pct, null, 'divisão por zero (0 tentativas) precisa dar null, nunca NaN/Infinity')

    // 15b — com fixtures reais.
    const conta = await criarContaDeTeste(supabase, { status: 'vencida' })
    const dispatchReal = await inserirDispatch(supabase, conta.id, 'collection')
    await inserirAttempt(supabase, dispatchReal.id, 1, 'delivered')
    await inserirAttempt(supabase, dispatchReal.id, 2, 'failed')
    await inserirAttempt(supabase, dispatchReal.id, 3, 'sent') // nem entrega nem falha — só soma em tentativas

    // Dispatch de homologação (internal_test) — nunca deveria aparecer nas métricas.
    const dispatchTeste = await inserirDispatch(supabase, conta.id, 'internal_test')
    await inserirAttempt(supabase, dispatchTeste.id, 1, 'delivered')

    const { body } = await chamar('?periodo=hoje')
    assert.equal(body.cobranca.tentativas_periodo, 3, 'purpose=internal_test não deve ser contado')
    assert.equal(body.cobranca.entregas_confirmadas_periodo, 1)
    assert.equal(body.cobranca.falhas_periodo, 1)
    assert.equal(body.cobranca.taxa_entrega_pct, Number(((1 / 3) * 100).toFixed(1)))
    assert.deepEqual(body.nao_implementados, [], 'com multi_whatsapp=true todas as métricas de performance são calculáveis')
  })

  await t.test('16. segurança: resposta agregada nunca expõe telefone/UUID de fixtures usadas nos testes', async () => {
    const telSensivel = telefoneDeTeste()
    const conta = await criarContaDeTeste(supabase, { status: 'aberta', telefone_cobranca: telSensivel })
    await supabase.from('collection_do_not_contact').insert({ cliente_telefone: telSensivel, motivo: 'teste', canal: 'todos', expira_em: null })

    const { body } = await chamar('')
    const bruto = JSON.stringify(body)
    assert.ok(!bruto.includes(telSensivel), 'telefone não pode aparecer no agregado')
    assert.ok(!bruto.includes(conta.id), 'UUID de título não pode aparecer no agregado')

    await supabase.from('contas_financeiras').update({ status: 'cancelada' }).eq('id', conta.id)
  })

  await t.test('17. ausência de dados / shape sanity: todo campo numérico é number (nunca undefined/NaN) numa chamada comum', async () => {
    const { body } = await chamar('?periodo=hoje')
    for (const [grupo, valores] of Object.entries({ saldo: body.saldo, aging: body.aging, promessas: body.promessas, contatos: body.contatos })) {
      for (const [campo, valor] of Object.entries(valores)) {
        if (valor === null) continue // campos com guard de divisão por zero podem ser null legitimamente
        assert.equal(typeof valor, 'number', `${grupo}.${campo} deveria ser number, veio ${typeof valor}`)
        assert.ok(!Number.isNaN(valor), `${grupo}.${campo} é NaN`)
      }
    }
  })
})

function round2(n) {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100
}

async function inserirDispatch(supabase, contasFinanceirasId, purpose) {
  const { data, error } = await supabase.from('collection_dispatches').insert({
    contas_financeiras_id: contasFinanceirasId,
    etapa: 1,
    canal: 'whatsapp',
    idempotency_key: `teste-dashboard-${Math.random().toString(36).slice(2)}`,
    status: 'sent',
    origem: 'manual',
    mensagem: 'mensagem de teste',
    cliente_nome: 'Teste',
    cliente_telefone: telefoneDeTeste(),
    purpose,
  }).select().single()
  if (error) throw error
  return data
}
async function inserirAttempt(supabase, dispatchId, attemptNumber, status) {
  const { error } = await supabase.from('collection_dispatch_attempts').insert({
    dispatch_id: dispatchId, attempt_number: attemptNumber, status,
  })
  if (error) throw error
}
