// Teste de integração dedicado à correção do parser de embed do compat
// client local (src/lib/localdev/pgCompatClient.js, 2026-09-08). Prova, com
// Postgres real e as rotas reais de produção (montadas exatamente como em
// src/index.js: auth + financeiro.js), que as duas consultas antes
// bloqueadas por "erro de sintaxe em ou próximo a ':'" agora completam com
// sucesso (200) E retornam os dados aninhados corretos — inclusive quando a
// MESMA tabela (usuarios) é referenciada mais de uma vez na mesma query por
// FKs diferentes (o caso que quebrava o parser antigo).
//
// Depende das mesmas 5 migrations legadas aplicadas (fora deste repositório
// versionado, só neste cluster sintético) em financeiro-controle-acesso.test.mjs:
// estornos_financeiros.sql, fn_baixar_titulo.sql, fn_estornar_baixa.sql,
// fn_aprovar_estorno.sql, fn_rejeitar_estorno.sql. Precisa rodar depois delas
// terem sido aplicadas ao cluster (não reaplica sozinho).
//
// Com isso, a limitação documentada em financeiro-controle-acesso.test.mjs
// (linhas "GET /estornos/pendentes e GET /contas/:contaId/baixas — gate de
// papel confirmado; execução completa tem limitação de ambiente") deixa de
// ser uma limitação para os embeds cobertos aqui — atualizado nesta mesma
// rodada para refletir isso.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import jwt from 'jsonwebtoken'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste } from './_setup.mjs'

let supabase, server, porta
let idA, idB, nomeA, nomeB
let tokenA, tokenB

before(async () => {
  await iniciarAmbienteDeTeste()
  ;({ supabase } = await import('../../../src/lib/supabase-admin.server.js'))
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-teste'
  process.env.LIMITE_ESTORNO_SEM_APROVACAO = '50' // baixa <=50 estorna na hora; >50 fica pendente_aprovacao

  const sufixo = Date.now()
  async function criarUsuarioDeTeste(role, rotulo) {
    const { data, error } = await supabase.from('usuarios')
      .insert({ nome: `${rotulo} (teste pcef)`, email: `${rotulo}-${sufixo}@teste-pcef.local`, role, ativo: true })
      .select('id, nome').single()
    if (error) throw error
    return data
  }
  const usuA = await criarUsuarioDeTeste('admin', 'usuario-a')
  const usuB = await criarUsuarioDeTeste('financeiro', 'usuario-b')
  idA = usuA.id
  idB = usuB.id
  nomeA = usuA.nome
  nomeB = usuB.nome

  tokenA = jwt.sign({ id: idA, email: 'a@teste.com', role: 'admin' }, process.env.JWT_SECRET)
  tokenB = jwt.sign({ id: idB, email: 'b@teste.com', role: 'financeiro' }, process.env.JWT_SECRET)

  const express = (await import('express')).default
  const { auth } = await import('../../../src/middleware/auth.js')
  const router = (await import('../../../src/routes/financeiro.js')).default
  const app = express()
  app.use(express.json())
  app.use('/api/financeiro', auth, router) // mesmo mount de src/index.js
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  porta = server.address().port
})
after(async () => {
  server?.close()
  await supabase.from('usuarios').delete().in('id', [idA, idB])
  await pararAmbienteDeTeste()
})

function chamar(method, path, { token = tokenA, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { authorization: `Bearer ${token}` }
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

async function criarConta({ valor = 100 } = {}) {
  const { data, error } = await supabase.from('contas_financeiras').insert({
    tipo: 'receber', descricao: 'Conta de teste — embed FK do compat client', valor, valor_pago: 0,
    vencimento: new Date().toISOString().slice(0, 10), status: 'aberta',
    pessoa_nome: 'Cliente de Teste PCEF',
  }).select().single()
  if (error) throw error
  return data
}
async function apagarContaDireto(id) {
  await supabase.from('estornos_financeiros').delete().eq('conta_financeira_id', id)
  await supabase.from('baixas_financeiras').delete().eq('conta_financeira_id', id)
  await supabase.from('contas_financeiras').delete().eq('id', id)
}

test('GET /contas/:contaId/baixas — embed criado_por/estornado_por (baixas_financeiras) e solicitado_por/aprovado_por (estornos_financeiros) resolvem corretamente, sem colidir', async (t) => {
  // Baixa 1: criada por A, estornada na hora (valor 30 <= limite 50) por B —
  // exercita criado_por != estornado_por na MESMA linha de baixas_financeiras.
  const conta1 = await criarConta({ valor: 30 })
  t.after(() => apagarContaDireto(conta1.id))
  const rBaixa1 = await chamar('PATCH', `/api/financeiro/contas/${conta1.id}/baixa`, { token: tokenA, body: { valor_recebido: 30 } })
  assert.equal(rBaixa1.status, 200, JSON.stringify(rBaixa1.body))
  const { data: baixa1 } = await supabase.from('baixas_financeiras').select('id').eq('conta_financeira_id', conta1.id).single()
  const rEstorno1 = await chamar('POST', `/api/financeiro/contas/${conta1.id}/baixas/${baixa1.id}/estornos`, {
    token: tokenB, body: { motivo_categoria: 'valor_incorreto', motivo_detalhado: 'teste pcef 1', confirmacao: true },
  })
  assert.equal(rEstorno1.status, 201, JSON.stringify(rEstorno1.body))

  const r1 = await chamar('GET', `/api/financeiro/contas/${conta1.id}/baixas`, { token: tokenA })
  assert.equal(r1.status, 200, `esperava 200 (embed resolvido); corpo: ${JSON.stringify(r1.body)}`)
  assert.equal(r1.body.data.length, 1)
  const baixaResp = r1.body.data[0]
  assert.equal(baixaResp.criado_por?.id, idA, 'criado_por precisa apontar pra A')
  assert.equal(baixaResp.criado_por?.nome, nomeA)
  assert.equal(baixaResp.estornado_por?.id, idB, 'estornado_por precisa apontar pra B — diferente de criado_por, mesma tabela usuarios')
  assert.equal(baixaResp.estornado_por?.nome, nomeB)
  assert.notEqual(baixaResp.criado_por?.id, baixaResp.estornado_por?.id, 'os dois embeds da mesma tabela não podem colidir/se sobrescrever')

  // Baixa 2: valor 200 > limite 50 → estorno fica pendente_aprovacao,
  // solicitado por A; depois aprovado por B (self-approval é bloqueado pela
  // RPC, por isso precisa de um segundo usuário). Exercita
  // solicitado_por != aprovado_por, e rejeitado_por permanece null (não
  // colide com os outros dois).
  const conta2 = await criarConta({ valor: 200 })
  t.after(() => apagarContaDireto(conta2.id))
  const rBaixa2 = await chamar('PATCH', `/api/financeiro/contas/${conta2.id}/baixa`, { token: tokenA, body: { valor_recebido: 200 } })
  assert.equal(rBaixa2.status, 200, JSON.stringify(rBaixa2.body))
  const { data: baixa2 } = await supabase.from('baixas_financeiras').select('id').eq('conta_financeira_id', conta2.id).single()
  const rEstorno2 = await chamar('POST', `/api/financeiro/contas/${conta2.id}/baixas/${baixa2.id}/estornos`, {
    token: tokenA, body: { motivo_categoria: 'valor_incorreto', motivo_detalhado: 'teste pcef 2', confirmacao: true },
  })
  assert.equal(rEstorno2.status, 201, JSON.stringify(rEstorno2.body))
  const { data: estorno2 } = await supabase.from('estornos_financeiros').select('id').eq('conta_financeira_id', conta2.id).single()
  const rAprovar = await chamar('PATCH', `/api/financeiro/estornos/${estorno2.id}/aprovar`, { token: tokenB })
  assert.equal(rAprovar.status, 200, JSON.stringify(rAprovar.body))

  const r2 = await chamar('GET', `/api/financeiro/contas/${conta2.id}/baixas`, { token: tokenA })
  assert.equal(r2.status, 200, `esperava 200 (embed resolvido); corpo: ${JSON.stringify(r2.body)}`)
  assert.equal(r2.body.estornos.length, 1)
  const estornoResp = r2.body.estornos[0]
  assert.equal(estornoResp.solicitado_por?.id, idA, 'solicitado_por precisa apontar pra A')
  assert.equal(estornoResp.aprovado_por?.id, idB, 'aprovado_por precisa apontar pra B — diferente de solicitado_por')
  assert.equal(estornoResp.rejeitado_por, null, 'rejeitado_por precisa ser null — não pode herdar dado de aprovado_por/solicitado_por por colisão de alias')
  assert.notEqual(estornoResp.solicitado_por?.id, estornoResp.aprovado_por?.id)
})

test('GET /estornos/pendentes — embeds plain (baixas_financeiras, contas_financeiras) + aliased+fkey (solicitado_por) na mesma query resolvem juntos', async (t) => {
  const conta = await criarConta({ valor: 500 })
  t.after(() => apagarContaDireto(conta.id))
  const rBaixa = await chamar('PATCH', `/api/financeiro/contas/${conta.id}/baixa`, { token: tokenA, body: { valor_recebido: 500 } })
  assert.equal(rBaixa.status, 200, JSON.stringify(rBaixa.body))
  const { data: baixa } = await supabase.from('baixas_financeiras').select('id').eq('conta_financeira_id', conta.id).single()
  const rEstorno = await chamar('POST', `/api/financeiro/contas/${conta.id}/baixas/${baixa.id}/estornos`, {
    token: tokenA, body: { motivo_categoria: 'valor_incorreto', motivo_detalhado: 'teste pcef pendentes', confirmacao: true },
  })
  assert.equal(rEstorno.status, 201, JSON.stringify(rEstorno.body)) // 500 > limite 50 → fica pendente_aprovacao

  const r = await chamar('GET', '/api/financeiro/estornos/pendentes', { token: tokenB })
  assert.equal(r.status, 200, `esperava 200 (embed resolvido); corpo: ${JSON.stringify(r.body)}`)
  const linha = r.body.data.find((e) => e.baixa_financeira_id === baixa.id)
  assert.ok(linha, 'estorno pendente criado precisa aparecer na fila')
  assert.equal(linha.baixas_financeiras?.id, baixa.id, 'embed plain baixas_financeiras precisa resolver (sem apelido, sem fkey — FK única entre as tabelas)')
  assert.equal(linha.contas_financeiras?.id, conta.id, 'embed plain contas_financeiras precisa resolver')
  assert.equal(linha.solicitado_por?.id, idA, 'embed aliased+fkey solicitado_por precisa resolver')
})
