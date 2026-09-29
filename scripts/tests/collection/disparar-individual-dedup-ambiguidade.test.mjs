// 2026-09-28 — correção de incidente real: POST /api/cobrancas/disparar-individual
// somava TODOS os títulos abertos de um cliente sem deduplicar por legacy_id
// nem tratar ambiguidade (2+ títulos sem legacy_id) — mesma classe de bug que
// consolidacaoParcelas.js já resolvia pro cron, mas nunca reaplicada aqui.
// Além disso, a mensagem final (reguaCobranca.js) mencionava "Esse valor
// corresponde a N títulos com o mesmo vencimento" — um envio real (18/08/2026,
// cliente SERGIO PELAGIO PROENÇA) confirmou essa frase em produção, violando o
// requisito de negócio de que a cobrança consolidada precisa ser indistinguível
// de uma cobrança normal de título único. Este arquivo cobre os 2 fixes:
// dedup/ambiguidade no disparo manual + ausência total da nota/assinatura certa.
import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste, criarContaDeTeste, limparInstanciasDeTeste, telefoneDeTeste } from './_setup.mjs'

let supabase, fakeEvolution, invalidarCacheFlags

before(async () => {
  fakeEvolution = await iniciarAmbienteDeTeste()
  ;({ supabase } = await import('../../../src/lib/supabase-admin.server.js'))
  ;({ invalidarCacheFlags } = await import('../../../src/lib/collection/featureFlags.js'))
})
after(async () => { await pararAmbienteDeTeste() })

async function garantirSyncFinanceiroFresco() {
  await supabase.from('sincronizacoes_financeiro').delete().eq('dry_run', false)
  const agora = new Date().toISOString()
  await supabase.from('sincronizacoes_financeiro').insert({
    status: 'concluido', dry_run: false, iniciado_em: agora, concluido_em: agora,
    total_lido: 1, total_atualizado: 0, total_sem_alteracao: 0, total_sem_match: 0,
    total_conflito: 0, total_cancelado: 0, total_com_erro: 0,
  })
}

async function criarInstancia(nome, overrides = {}) {
  const { data, error } = await supabase.from('whatsapp_instances').insert({
    name: nome, instance_name: nome, priority: 1, role: 'principal', enabled: true, ...overrides,
  }).select().single()
  if (error) throw error
  return data
}

beforeEach(async () => {
  fakeEvolution.resetar()
  await limparInstanciasDeTeste(supabase)
  await garantirSyncFinanceiroFresco()
  await supabase.from('automacoes_config').update({
    multi_whatsapp: true, whatsapp_failover: false, cobranca_whatsapp_ativa: true,
    global_daily_limit: 30, global_hourly_limit: 10,
  }).eq('id', 1)
  invalidarCacheFlags()
  await criarInstancia(`wa01-${Date.now()}`, { priority: 1 })
})

let servidor = null
async function dispararIndividual(pessoaNome) {
  process.env.API_SECRET_KEY = 'chave-teste-disparar-individual'
  const express = (await import('express')).default
  const { auth, adminOuFinanceiro } = await import('../../../src/middleware/auth.js')
  const cobrancasRouter = (await import('../../../src/routes/cobrancas.js')).default
  const app = express()
  app.use(express.json())
  app.use('/api/cobrancas', auth, adminOuFinanceiro, cobrancasRouter)
  servidor = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  const porta = servidor.address().port

  try {
    return await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: porta, method: 'POST',
        path: `/api/cobrancas/disparar-individual/${encodeURIComponent(pessoaNome)}`,
        headers: { authorization: 'Bearer chave-teste-disparar-individual', 'content-type': 'application/json' },
      }, (res) => {
        let chunks = ''
        res.on('data', (c) => { chunks += c })
        res.on('end', () => resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null }))
      })
      req.on('error', reject)
      req.end()
    })
  } finally {
    servidor.close()
  }
}

test('1. 2 títulos distintos (legacy_id diferente), mesmo vencimento → soma correta, sem nota de múltiplos títulos, assinatura Andrieli', async () => {
  const pessoaNome = `Cliente Dedup Normal ${Date.now()}`
  const codigoCliente = `DEDUP-NORMAL-${Date.now()}`
  const telefone = telefoneDeTeste()
  const vencimento = new Date().toISOString().slice(0, 10)

  const a = await criarContaDeTeste(supabase, { pessoa_nome: pessoaNome, codigo_cliente: codigoCliente, telefone_cobranca: telefone, vencimento, valor: 1055.06 })
  await supabase.from('contas_financeiras').update({ legacy_id: `LEG-A-${a.id}` }).eq('id', a.id)
  const b = await criarContaDeTeste(supabase, { pessoa_nome: pessoaNome, codigo_cliente: codigoCliente, telefone_cobranca: telefone, vencimento, valor: 1055.06 })
  await supabase.from('contas_financeiras').update({ legacy_id: `LEG-B-${b.id}` }).eq('id', b.id)

  const resultado = await dispararIndividual(pessoaNome)
  assert.equal(resultado.status, 201, JSON.stringify(resultado.body))
  assert.equal(Number(resultado.body.valor), 2110.12, 'soma dos 2 saldos reais (1055.06 + 1055.06)')
  assert.equal(resultado.body.mensagem_enviada.includes('títulos'), false, 'mensagem nunca deve mencionar "títulos"')
  assert.equal(resultado.body.mensagem_enviada.includes('corresponde a'), false)
  assert.match(resultado.body.mensagem_enviada, /R\$ 2\.110,12/)
  assert.match(resultado.body.mensagem_enviada, /_Andrieli — Financeiro Vivenzza_$/)
  assert.equal(resultado.body.mensagem_enviada.includes('Jeffeson'), false)
})

test('2. duplicata técnica (mesmo legacy_id repetido) → NÃO dobra o valor', async () => {
  const pessoaNome = `Cliente Duplicata Tecnica ${Date.now()}`
  const codigoCliente = `DEDUP-DUP-${Date.now()}`
  const telefone = telefoneDeTeste()
  const vencimento = new Date().toISOString().slice(0, 10)
  const legacyCompartilhado = `LEG-DUP-${Date.now()}`

  const a = await criarContaDeTeste(supabase, { pessoa_nome: pessoaNome, codigo_cliente: codigoCliente, telefone_cobranca: telefone, vencimento, valor: 300 })
  await supabase.from('contas_financeiras').update({ legacy_id: legacyCompartilhado }).eq('id', a.id)
  const b = await criarContaDeTeste(supabase, { pessoa_nome: pessoaNome, codigo_cliente: codigoCliente, telefone_cobranca: telefone, vencimento, valor: 300 })
  await supabase.from('contas_financeiras').update({ legacy_id: legacyCompartilhado }).eq('id', b.id)

  const resultado = await dispararIndividual(pessoaNome)
  assert.equal(resultado.status, 201, JSON.stringify(resultado.body))
  assert.equal(Number(resultado.body.valor), 300, 'duplicata técnica (mesmo legacy_id) não pode dobrar o valor cobrado')
})

test('3. 2+ títulos SEM legacy_id → ambíguo, bloqueado (409), nenhuma mensagem enviada', async () => {
  const pessoaNome = `Cliente Ambiguo Manual ${Date.now()}`
  const codigoCliente = `DEDUP-AMBIGUO-${Date.now()}`
  const telefone = telefoneDeTeste()
  const vencimento = new Date().toISOString().slice(0, 10)

  await criarContaDeTeste(supabase, { pessoa_nome: pessoaNome, codigo_cliente: codigoCliente, telefone_cobranca: telefone, vencimento, valor: 100 })
  await criarContaDeTeste(supabase, { pessoa_nome: pessoaNome, codigo_cliente: codigoCliente, telefone_cobranca: telefone, vencimento, valor: 100 })

  const antesEnvios = fakeEvolution.mensagensEnviadas.length
  const resultado = await dispararIndividual(pessoaNome)
  assert.equal(resultado.status, 409, JSON.stringify(resultado.body))
  assert.equal(resultado.body.motivo, 'sem_legacy_id_multiplo')
  assert.equal(fakeEvolution.mensagensEnviadas.length, antesEnvios, 'nenhuma mensagem deveria ter sido enviada pro grupo ambíguo')

  const { data: cobrancas } = await supabase.from('cobrancas_whatsapp').select('id').eq('cliente_nome', pessoaNome)
  assert.equal(cobrancas?.length ?? 0, 0, 'grupo ambíguo nunca deveria gerar registro de cobrança')
})

test('4. 1 título único → comportamento preservado, sem nota, valor exato', async () => {
  const pessoaNome = `Cliente Titulo Unico Manual ${Date.now()}`
  const telefone = telefoneDeTeste()
  const conta = await criarContaDeTeste(supabase, { pessoa_nome: pessoaNome, telefone_cobranca: telefone, valor: 813.9 })
  await supabase.from('contas_financeiras').update({ legacy_id: `LEG-UNICO-${conta.id}` }).eq('id', conta.id)

  const resultado = await dispararIndividual(pessoaNome)
  assert.equal(resultado.status, 201, JSON.stringify(resultado.body))
  assert.equal(Number(resultado.body.valor), 813.9)
  assert.equal(resultado.body.mensagem_enviada.includes('títulos'), false)
})

test('5. pagamento parcial (saldo aberto) + título cheio, mesmo cliente → soma só os saldos reais', async () => {
  const pessoaNome = `Cliente Parcial Manual ${Date.now()}`
  const codigoCliente = `DEDUP-PARCIAL-${Date.now()}`
  const telefone = telefoneDeTeste()
  const vencimento = new Date().toISOString().slice(0, 10)

  // saldo 300 (500 - 200 já pago)
  const a = await criarContaDeTeste(supabase, { pessoa_nome: pessoaNome, codigo_cliente: codigoCliente, telefone_cobranca: telefone, vencimento, valor: 500, valor_pago: 200 })
  await supabase.from('contas_financeiras').update({ legacy_id: `LEG-PARC-A-${a.id}` }).eq('id', a.id)
  // saldo 400 (sem pagamento)
  const b = await criarContaDeTeste(supabase, { pessoa_nome: pessoaNome, codigo_cliente: codigoCliente, telefone_cobranca: telefone, vencimento, valor: 400, valor_pago: 0 })
  await supabase.from('contas_financeiras').update({ legacy_id: `LEG-PARC-B-${b.id}` }).eq('id', b.id)
  // já quitado na prática (não deve entrar na soma)
  const c = await criarContaDeTeste(supabase, { pessoa_nome: pessoaNome, codigo_cliente: codigoCliente, telefone_cobranca: telefone, vencimento, valor: 250, valor_pago: 250, status: 'paga' })
  await supabase.from('contas_financeiras').update({ legacy_id: `LEG-PARC-C-${c.id}` }).eq('id', c.id)

  const resultado = await dispararIndividual(pessoaNome)
  assert.equal(resultado.status, 201, JSON.stringify(resultado.body))
  assert.equal(Number(resultado.body.valor), 700, 'soma dos saldos reais (300 + 400), ignorando o título já quitado')
})

test('6. formatação BRL correta no valor consolidado (separador de milhar e vírgula decimal)', async () => {
  const pessoaNome = `Cliente Formatacao BRL ${Date.now()}`
  const codigoCliente = `DEDUP-BRL-${Date.now()}`
  const telefone = telefoneDeTeste()
  const vencimento = new Date().toISOString().slice(0, 10)

  const a = await criarContaDeTeste(supabase, { pessoa_nome: pessoaNome, codigo_cliente: codigoCliente, telefone_cobranca: telefone, vencimento, valor: 1221.29 })
  await supabase.from('contas_financeiras').update({ legacy_id: `LEG-BRL-A-${a.id}` }).eq('id', a.id)
  const b = await criarContaDeTeste(supabase, { pessoa_nome: pessoaNome, codigo_cliente: codigoCliente, telefone_cobranca: telefone, vencimento, valor: 1221.29 })
  await supabase.from('contas_financeiras').update({ legacy_id: `LEG-BRL-B-${b.id}` }).eq('id', b.id)

  const resultado = await dispararIndividual(pessoaNome)
  assert.equal(resultado.status, 201, JSON.stringify(resultado.body))
  assert.equal(Number(resultado.body.valor), 2442.58)
  assert.match(resultado.body.mensagem_enviada, /R\$ 2\.442,58/, 'formatação BRL com separador de milhar e vírgula decimal')
})

test('7. vencimentos DIFERENTES → soma só o grupo do vencimento mais atrasado; outros vencimentos ficam de fora', async () => {
  const pessoaNome = `Cliente Vencimentos Distintos ${Date.now()}`
  const codigoCliente = `DEDUP-VENC-${Date.now()}`
  const telefone = telefoneDeTeste()
  const dia = (delta) => new Date(Date.now() + delta * 86400000).toISOString().slice(0, 10)

  // 2 títulos no vencimento mais antigo (entram na soma)
  const a = await criarContaDeTeste(supabase, { pessoa_nome: pessoaNome, codigo_cliente: codigoCliente, telefone_cobranca: telefone, vencimento: dia(-10), valor: 100.1 })
  await supabase.from('contas_financeiras').update({ legacy_id: `LEG-V-A-${a.id}` }).eq('id', a.id)
  const b = await criarContaDeTeste(supabase, { pessoa_nome: pessoaNome, codigo_cliente: codigoCliente, telefone_cobranca: telefone, vencimento: dia(-10), valor: 200.2 })
  await supabase.from('contas_financeiras').update({ legacy_id: `LEG-V-B-${b.id}` }).eq('id', b.id)
  // outro vencimento (NÃO entra), inclusive sem legacy_id em dobro — não deve gerar 409 pro grupo certo
  await criarContaDeTeste(supabase, { pessoa_nome: pessoaNome, codigo_cliente: codigoCliente, telefone_cobranca: telefone, vencimento: dia(-2), valor: 999 })
  await criarContaDeTeste(supabase, { pessoa_nome: pessoaNome, codigo_cliente: codigoCliente, telefone_cobranca: telefone, vencimento: dia(-2), valor: 999 })

  const resultado = await dispararIndividual(pessoaNome)
  assert.equal(resultado.status, 201, JSON.stringify(resultado.body))
  assert.equal(Number(resultado.body.valor), 300.3, 'soma exata só do mesmo vencimento (100.10 + 200.20), sem deriva de ponto flutuante')
  assert.equal(String(resultado.body.vencimento).slice(0, 10), dia(-10))
})
