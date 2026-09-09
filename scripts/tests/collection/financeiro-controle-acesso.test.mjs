// Controle de acesso financeiro — decisão explícita do responsável
// (2026-09-07): só admin/financeiro operam qualquer coisa financeira;
// vendedor NUNCA, mesmo em título da própria carteira (abandona o modelo de
// posse testado numa rodada anterior). Rotas reais, montadas exatamente como
// em produção (auth + adminOuFinanceiro), Postgres local, dados 100%
// sintéticos. Nenhum WhatsApp/fiscal/voz em nenhum cenário.
//
// ATUALIZAÇÃO 2026-09-07 (rodada 5): fn_baixar_titulo, fn_estornar_baixa,
// fn_aprovar_estorno, fn_rejeitar_estorno e a tabela estornos_financeiros só
// existiam na árvore legada migrations/ (não numerada, não aplicada por
// scripts/localdb-reset.mjs — mesmo gap documentado em
// docs/MIGRATIONS_DRIFT_AUDIT_2026-09-03.md pra fn_sincronizar_baixa_legado).
// Aplicadas aqui, verbatim (nenhuma linha alterada), SÓ neste cluster
// sintético exclusivo (porta 55441, banco financeiro_access_20260907) via:
//   psql ... -f migrations/estornos_financeiros.sql
//   psql ... -f migrations/fn_baixar_titulo.sql
//   psql ... -f migrations/fn_estornar_baixa.sql
//   psql ... -f migrations/fn_aprovar_estorno.sql
//   psql ... -f migrations/fn_rejeitar_estorno.sql
// Nada foi aplicado em produção nem no banco compartilhado 5433/vivenzza_dev.
// Isso NÃO fica persistido em scripts/localdb-reset.mjs — um reset novo
// deste mesmo cluster (ou qualquer outro) precisaria reaplicar os 5 arquivos
// manualmente antes de rodar este teste de novo.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import jwt from 'jsonwebtoken'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste } from './_setup.mjs'

let supabase, server, porta
let idAdmin, idFinanceiro, idVendedorA, idTerceiroPapel
let tokenAdmin, tokenFinanceiro, tokenVendedorA, tokenTerceiroPapel, tokenSemRole

before(async () => {
  await iniciarAmbienteDeTeste()
  ;({ supabase } = await import('../../../src/lib/supabase-admin.server.js'))
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-teste'
  process.env.LIMITE_ESTORNO_SEM_APROVACAO = '50' // baixa <=50 estorna na hora; >50 fica pendente_aprovacao

  const sufixo = Date.now()
  async function criarUsuarioDeTeste(role, rotulo) {
    const { data, error } = await supabase.from('usuarios')
      .insert({ nome: `${rotulo} (teste fca)`, email: `${rotulo}-${sufixo}@teste-fca.local`, role, ativo: true })
      .select('id').single()
    if (error) throw error
    return data.id
  }
  idAdmin = await criarUsuarioDeTeste('admin', 'admin')
  idFinanceiro = await criarUsuarioDeTeste('financeiro', 'financeiro')
  idVendedorA = await criarUsuarioDeTeste('vendedor', 'vendedor-a')
  // ACHADO REAL (2026-09-09): usuarios_role_check em produção só aceita
  // admin/vendedor/financeiro — reproduzido fielmente no baseline local
  // desde então (ver scripts/localdb/schema-baseline/001_core.sql). Um
  // INSERT direto com role='gerente' agora FALHA de verdade (antes,
  // "funcionava" só porque o baseline local não tinha a constraint real).
  // O papel "desconhecido" testado aqui é sobre o CLAIM do token — é só
  // isso que auth() lê (nunca reconsulta o banco) — não sobre a linha em
  // si, que só existe como âncora de FK. Por isso reaproveita o id de um
  // usuário JÁ válido (idVendedorA), exatamente como tokenSemRole já
  // reaproveita idAdmin logo abaixo.
  idTerceiroPapel = idVendedorA

  tokenAdmin = jwt.sign({ id: idAdmin, email: 'admin@teste.com', role: 'admin' }, process.env.JWT_SECRET)
  tokenFinanceiro = jwt.sign({ id: idFinanceiro, email: 'financeiro@teste.com', role: 'financeiro' }, process.env.JWT_SECRET)
  tokenVendedorA = jwt.sign({ id: idVendedorA, email: 'a@teste.com', role: 'vendedor' }, process.env.JWT_SECRET)
  tokenTerceiroPapel = jwt.sign({ id: idTerceiroPapel, email: 'terceiro@teste.com', role: 'gerente' }, process.env.JWT_SECRET)
  tokenSemRole = jwt.sign({ id: idAdmin, email: 'sem-role@teste.com' }, process.env.JWT_SECRET) // sem claim "role"

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
  await supabase.from('usuarios').delete().in('id', [idAdmin, idFinanceiro, idVendedorA, idTerceiroPapel])
  await pararAmbienteDeTeste()
})

function chamar(method, path, { token = tokenAdmin, body = null } = {}) {
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

async function criarConta({ vendedorId = null, tipo = 'receber', status = 'aberta', valor = 100, valorPago = 0 } = {}) {
  const { data, error } = await supabase.from('contas_financeiras').insert({
    tipo, descricao: 'Conta de teste — controle de acesso financeiro', valor, valor_pago: valorPago,
    vencimento: new Date().toISOString().slice(0, 10), status, vendedor_id: vendedorId,
    pessoa_nome: 'Cliente de Teste FCA', // exigido por collection_promises.cliente_nome (NOT NULL)
  }).select().single()
  if (error) throw error
  return data
}
async function buscarConta(id) {
  const { data, error } = await supabase.from('contas_financeiras').select('*').eq('id', id).maybeSingle()
  if (error) throw error
  return data
}
async function contarBaixas(contaId) {
  const { count, error } = await supabase.from('baixas_financeiras').select('id', { count: 'exact', head: true }).eq('conta_financeira_id', contaId)
  if (error) throw error
  return count
}
async function apagarContaDireto(id) {
  await supabase.from('estornos_financeiros').delete().eq('conta_financeira_id', id)
  await supabase.from('baixas_financeiras').delete().eq('conta_financeira_id', id)
  await supabase.from('contas_financeiras').delete().eq('id', id)
}

test('POST / (criar) — só admin/financeiro; vendedor e papel desconhecido bloqueados', async (tSuite) => {
  await tSuite.test('vendedor é bloqueado, mesmo sem título prévio nenhum', async () => {
    const r = await chamar('POST', '/api/financeiro', {
      token: tokenVendedorA,
      body: { tipo: 'receber', descricao: 'x', valor: 10, vencimento: new Date().toISOString().slice(0, 10) },
    })
    assert.equal(r.status, 403)
  })

  await tSuite.test('papel desconhecido (gerente) é bloqueado', async () => {
    const r = await chamar('POST', '/api/financeiro', { token: tokenTerceiroPapel, body: { tipo: 'receber', descricao: 'x', valor: 10, vencimento: new Date().toISOString().slice(0, 10) } })
    assert.equal(r.status, 403)
  })

  await tSuite.test('token sem claim "role" é bloqueado', async () => {
    const r = await chamar('POST', '/api/financeiro', { token: tokenSemRole, body: { tipo: 'receber', descricao: 'x', valor: 10, vencimento: new Date().toISOString().slice(0, 10) } })
    assert.equal(r.status, 403)
  })

  await tSuite.test('admin autorizado', async (t) => {
    const r = await chamar('POST', '/api/financeiro', { token: tokenAdmin, body: { tipo: 'receber', descricao: 'x', valor: 10, vencimento: new Date().toISOString().slice(0, 10) } })
    assert.equal(r.status, 201)
    t.after(() => apagarContaDireto(r.body.id))
  })

  await tSuite.test('financeiro autorizado, inclusive tipo="pagar"', async (t) => {
    const r = await chamar('POST', '/api/financeiro', { token: tokenFinanceiro, body: { tipo: 'pagar', descricao: 'x', valor: 10, vencimento: new Date().toISOString().slice(0, 10) } })
    assert.equal(r.status, 201)
    t.after(() => apagarContaDireto(r.body.id))
  })
})

test('PUT /:id (editar) — só admin/financeiro, campos restritos a lista explícita', async (tSuite) => {
  await tSuite.test('vendedor bloqueado MESMO no título da própria carteira; nada muda', async (t) => {
    const conta = await criarConta({ vendedorId: idVendedorA, valor: 111 })
    t.after(() => apagarContaDireto(conta.id))
    const r = await chamar('PUT', `/api/financeiro/${conta.id}`, { token: tokenVendedorA, body: { categoria_dre: 'x' } })
    assert.equal(r.status, 403, 'posse não autoriza mais nada — decisão explícita abandona o modelo anterior')
    const depois = await buscarConta(conta.id)
    assert.equal(depois.categoria_dre, null)
  })

  await tSuite.test('papel desconhecido e token sem role bloqueados', async (t) => {
    const conta = await criarConta({})
    t.after(() => apagarContaDireto(conta.id))
    const r1 = await chamar('PUT', `/api/financeiro/${conta.id}`, { token: tokenTerceiroPapel, body: { categoria_dre: 'x' } })
    assert.equal(r1.status, 403)
    const r2 = await chamar('PUT', `/api/financeiro/${conta.id}`, { token: tokenSemRole, body: { categoria_dre: 'x' } })
    assert.equal(r2.status, 403)
  })

  await tSuite.test('admin edita categoria_dre de QUALQUER título (posse não é mais requisito pra quem é autorizado)', async (t) => {
    const conta = await criarConta({ vendedorId: idVendedorA }) // não é do admin, não importa mais
    t.after(() => apagarContaDireto(conta.id))
    const r = await chamar('PUT', `/api/financeiro/${conta.id}`, { token: tokenAdmin, body: { categoria_dre: 'despesas_operacionais' } })
    assert.equal(r.status, 200)
    assert.equal(r.body.categoria_dre, 'despesas_operacionais')
  })

  await tSuite.test('financeiro edita descricao/observacoes', async (t) => {
    const conta = await criarConta({})
    t.after(() => apagarContaDireto(conta.id))
    const r = await chamar('PUT', `/api/financeiro/${conta.id}`, { token: tokenFinanceiro, body: { descricao: 'corrigida', observacoes: 'nota' } })
    assert.equal(r.status, 200)
    assert.equal(r.body.descricao, 'corrigida')
    assert.equal(r.body.observacoes, 'nota')
  })

  await tSuite.test('rejeição explícita (400): enviar valor/valor_pago/status/tipo/vendedor_id no PUT é recusado por inteiro, NADA muda', async (t) => {
    const conta = await criarConta({ tipo: 'receber', valor: 500, valorPago: 0, status: 'aberta', vendedorId: null })
    t.after(() => apagarContaDireto(conta.id))

    for (const token of [tokenAdmin, tokenFinanceiro]) {
      const r = await chamar('PUT', `/api/financeiro/${conta.id}`, {
        token,
        // categoria_dre (permitido) misturado de propósito com campos
        // proibidos — a mistura inteira precisa ser recusada, nunca aplicar
        // só a parte permitida.
        body: { valor: 999999, valor_pago: 500, status: 'paga', tipo: 'pagar', vendedor_id: idVendedorA, categoria_dre: 'ok' },
      })
      assert.equal(r.status, 400, 'PUT precisa recusar a requisição inteira, não aceitar e ignorar em silêncio')
      assert.ok(Array.isArray(r.body.campos_nao_permitidos))
      for (const proibido of ['valor', 'valor_pago', 'status', 'tipo', 'vendedor_id']) {
        assert.ok(r.body.campos_nao_permitidos.includes(proibido), `"${proibido}" precisa aparecer na lista de campos recusados`)
      }
    }

    const depois = await buscarConta(conta.id)
    assert.equal(Number(depois.valor), 500, 'valor não pode ter mudado — requisição inteira foi recusada')
    assert.equal(Number(depois.valor_pago), 0)
    assert.equal(depois.status, 'aberta')
    assert.equal(depois.tipo, 'receber')
    assert.equal(depois.vendedor_id, null)
    assert.equal(depois.categoria_dre, null, 'nem o campo PERMITIDO (categoria_dre) pode ter sido aplicado — sem alteração parcial')

    const baixas = await contarBaixas(conta.id)
    assert.equal(baixas, 0, 'nenhuma baixa foi criada — confirma que não há bypass de fn_baixar_titulo')
  })

  await tSuite.test('payload real do frontend (só categoria_dre) continua funcionando sem exigir mudança nenhuma', async (t) => {
    // Mesmo payload literal de handleAlterarCategoriaDre em Financeiro.jsx —
    // api.put(`/api/financeiro/${id}`, { categoria_dre: valor }).
    const conta = await criarConta({})
    t.after(() => apagarContaDireto(conta.id))
    const r = await chamar('PUT', `/api/financeiro/${conta.id}`, { token: tokenAdmin, body: { categoria_dre: 'financeira' } })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.categoria_dre, 'financeira')
  })
})

test('PATCH /:id/cancelar — só admin/financeiro', async (tSuite) => {
  await tSuite.test('vendedor bloqueado mesmo no próprio título; status não muda', async (t) => {
    const conta = await criarConta({ vendedorId: idVendedorA, status: 'aberta' })
    t.after(() => apagarContaDireto(conta.id))
    const r = await chamar('PATCH', `/api/financeiro/${conta.id}/cancelar`, { token: tokenVendedorA })
    assert.equal(r.status, 403)
    const depois = await buscarConta(conta.id)
    assert.equal(depois.status, 'aberta')
  })

  await tSuite.test('papel desconhecido e token sem role bloqueados', async (t) => {
    const conta = await criarConta({ status: 'aberta' })
    t.after(() => apagarContaDireto(conta.id))
    assert.equal((await chamar('PATCH', `/api/financeiro/${conta.id}/cancelar`, { token: tokenTerceiroPapel })).status, 403)
    assert.equal((await chamar('PATCH', `/api/financeiro/${conta.id}/cancelar`, { token: tokenSemRole })).status, 403)
    const depois = await buscarConta(conta.id)
    assert.equal(depois.status, 'aberta')
  })

  await tSuite.test('admin e financeiro autorizados', async (t) => {
    const conta1 = await criarConta({ status: 'aberta' })
    const conta2 = await criarConta({ status: 'aberta' })
    t.after(() => Promise.all([apagarContaDireto(conta1.id), apagarContaDireto(conta2.id)]))
    assert.equal((await chamar('PATCH', `/api/financeiro/${conta1.id}/cancelar`, { token: tokenAdmin })).status, 200)
    assert.equal((await chamar('PATCH', `/api/financeiro/${conta2.id}/cancelar`, { token: tokenFinanceiro })).status, 200)
  })
})

test('DELETE /:id — só admin/financeiro', async (tSuite) => {
  await tSuite.test('vendedor bloqueado mesmo no próprio título; nada é apagado', async (t) => {
    const conta = await criarConta({ vendedorId: idVendedorA })
    t.after(() => apagarContaDireto(conta.id))
    const r = await chamar('DELETE', `/api/financeiro/${conta.id}`, { token: tokenVendedorA })
    assert.equal(r.status, 403)
    assert.ok(await buscarConta(conta.id))
  })

  await tSuite.test('papel desconhecido e token sem role bloqueados', async (t) => {
    const conta = await criarConta({})
    t.after(() => apagarContaDireto(conta.id))
    assert.equal((await chamar('DELETE', `/api/financeiro/${conta.id}`, { token: tokenTerceiroPapel })).status, 403)
    assert.equal((await chamar('DELETE', `/api/financeiro/${conta.id}`, { token: tokenSemRole })).status, 403)
    assert.ok(await buscarConta(conta.id))
  })

  await tSuite.test('financeiro autorizado, apaga de verdade', async () => {
    const conta = await criarConta({})
    const r = await chamar('DELETE', `/api/financeiro/${conta.id}`, { token: tokenFinanceiro })
    assert.equal(r.status, 204)
    assert.equal(await buscarConta(conta.id), null)
  })
})

test('PATCH /contas/:id/baixa — autorização + restrições internas da RPC fn_baixar_titulo', async (tSuite) => {
  await tSuite.test('vendedor bloqueado mesmo no próprio título; nenhuma baixa criada, valor_pago intacto', async (t) => {
    const conta = await criarConta({ vendedorId: idVendedorA, valor: 300, valorPago: 0, status: 'aberta' })
    t.after(() => apagarContaDireto(conta.id))
    const r = await chamar('PATCH', `/api/financeiro/contas/${conta.id}/baixa`, { token: tokenVendedorA, body: { valor_recebido: 300 } })
    assert.equal(r.status, 403)
    const depois = await buscarConta(conta.id)
    assert.equal(Number(depois.valor_pago), 0)
    assert.equal(await contarBaixas(conta.id), 0)
  })

  await tSuite.test('papel desconhecido e token sem role bloqueados', async (t) => {
    const conta = await criarConta({ valor: 300, status: 'aberta' })
    t.after(() => apagarContaDireto(conta.id))
    assert.equal((await chamar('PATCH', `/api/financeiro/contas/${conta.id}/baixa`, { token: tokenTerceiroPapel, body: { valor_recebido: 300 } })).status, 403)
    assert.equal((await chamar('PATCH', `/api/financeiro/contas/${conta.id}/baixa`, { token: tokenSemRole, body: { valor_recebido: 300 } })).status, 403)
  })

  await tSuite.test('admin dá baixa total — fluxo completo real, cria linha em baixas_financeiras, status vira "paga"', async (t) => {
    const conta = await criarConta({ valor: 300, valorPago: 0, status: 'aberta' })
    t.after(() => apagarContaDireto(conta.id))
    const r = await chamar('PATCH', `/api/financeiro/contas/${conta.id}/baixa`, { token: tokenAdmin, body: { valor_recebido: 300, forma_pagamento: 'pix' } })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.status, 'paga')
    const depois = await buscarConta(conta.id)
    assert.equal(Number(depois.valor_pago), 300)
    assert.equal(depois.status, 'paga')
    assert.equal(await contarBaixas(conta.id), 1)
  })

  await tSuite.test('financeiro dá baixa parcial — status vira "pago_parcial"', async (t) => {
    const conta = await criarConta({ valor: 300, valorPago: 0, status: 'aberta' })
    t.after(() => apagarContaDireto(conta.id))
    const r = await chamar('PATCH', `/api/financeiro/contas/${conta.id}/baixa`, { token: tokenFinanceiro, body: { valor_recebido: 100 } })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.status, 'pago_parcial')
    const depois = await buscarConta(conta.id)
    assert.equal(Number(depois.valor_pago), 100)
  })

  await tSuite.test('RESTRIÇÃO INTERNA DA RPC (não é o middleware): baixa num título já "paga" é rejeitada, mesmo pra financeiro', async (t) => {
    const conta = await criarConta({ valor: 100, valorPago: 100, status: 'paga' })
    t.after(() => apagarContaDireto(conta.id))
    const r = await chamar('PATCH', `/api/financeiro/contas/${conta.id}/baixa`, { token: tokenFinanceiro, body: { valor_recebido: 50 } })
    assert.equal(r.status, 400, 'rejeitado pela RPC (RAISE EXCEPTION), não pelo gate de papel — já passou no adminOuFinanceiro')
    assert.match(r.body.erro, /já está totalmente pago/)
    assert.equal(await contarBaixas(conta.id), 0, 'nenhuma baixa nova deveria ter sido criada')
  })

  await tSuite.test('RESTRIÇÃO INTERNA DA RPC: baixa num título "cancelada" é rejeitada, mesmo pra admin', async (t) => {
    const conta = await criarConta({ valor: 100, valorPago: 0, status: 'cancelada' })
    t.after(() => apagarContaDireto(conta.id))
    const r = await chamar('PATCH', `/api/financeiro/contas/${conta.id}/baixa`, { token: tokenAdmin, body: { valor_recebido: 100 } })
    assert.equal(r.status, 400)
    assert.match(r.body.erro, /está cancelado/)
  })
})

test('POST estornos / aprovar / rejeitar — autorização + restrições internas das RPCs fn_estornar_baixa/fn_aprovar_estorno/fn_rejeitar_estorno', async (tSuite) => {
  const ID_INEXISTENTE = '00000000-0000-0000-0000-000000000000'

  // Baixa real via a própria rota (fn_baixar_titulo) — não via insert direto,
  // pra exercitar a cadeia completa como ela roda de verdade.
  async function darBaixaReal(contaId, valor, token = tokenAdmin) {
    const r = await chamar('PATCH', `/api/financeiro/contas/${contaId}/baixa`, { token, body: { valor_recebido: valor } })
    assert.equal(r.status, 200, `setup: baixa deveria ter funcionado — ${JSON.stringify(r.body)}`)
    const { data } = await supabase.from('baixas_financeiras').select('id').eq('conta_financeira_id', contaId).order('criado_em', { ascending: false }).limit(1).single()
    return data.id
  }

  await tSuite.test('solicitar estorno: vendedor e papel desconhecido bloqueados (ids nem precisam existir — gate roda antes)', async () => {
    const body = { motivo_categoria: 'valor_incorreto', motivo_detalhado: 'teste', confirmacao: true }
    assert.equal((await chamar('POST', `/api/financeiro/contas/${ID_INEXISTENTE}/baixas/${ID_INEXISTENTE}/estornos`, { token: tokenVendedorA, body })).status, 403)
    assert.equal((await chamar('POST', `/api/financeiro/contas/${ID_INEXISTENTE}/baixas/${ID_INEXISTENTE}/estornos`, { token: tokenTerceiroPapel, body })).status, 403)
  })

  await tSuite.test('financeiro solicita estorno de baixa pequena (abaixo do limite) — conclui na hora, sem aprovação', async (t) => {
    const conta = await criarConta({ valor: 100, valorPago: 0, status: 'aberta' })
    t.after(() => apagarContaDireto(conta.id))
    const baixaId = await darBaixaReal(conta.id, 30) // 30 <= LIMITE_ESTORNO_SEM_APROVACAO (50)

    const r = await chamar('POST', `/api/financeiro/contas/${conta.id}/baixas/${baixaId}/estornos`, {
      token: tokenFinanceiro, body: { motivo_categoria: 'valor_incorreto', motivo_detalhado: 'teste', confirmacao: true },
    })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.equal(r.body.status, 'concluido')
    const { data: baixaDepois } = await supabase.from('baixas_financeiras').select('status').eq('id', baixaId).single()
    assert.equal(baixaDepois.status, 'estornada')
    const contaDepois = await buscarConta(conta.id)
    assert.equal(Number(contaDepois.valor_pago), 0, 'estorno concluído já reverteu o valor_pago')
  })

  await tSuite.test('admin solicita estorno de baixa grande (acima do limite) — fica pendente_aprovacao, baixa NÃO muda ainda', async (t) => {
    const conta = await criarConta({ valor: 200, valorPago: 0, status: 'aberta' })
    t.after(() => apagarContaDireto(conta.id))
    const baixaId = await darBaixaReal(conta.id, 200) // > 50

    const r = await chamar('POST', `/api/financeiro/contas/${conta.id}/baixas/${baixaId}/estornos`, {
      token: tokenAdmin, body: { motivo_categoria: 'valor_incorreto', motivo_detalhado: 'teste', confirmacao: true },
    })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.equal(r.body.status, 'pendente_aprovacao')
    const { data: baixaDepois } = await supabase.from('baixas_financeiras').select('status').eq('id', baixaId).single()
    assert.equal(baixaDepois.status, 'ativa', 'baixa não pode mudar antes da aprovação')
  })

  await tSuite.test('RESTRIÇÃO INTERNA: estornar uma baixa conciliada é rejeitado mesmo pra financeiro', async (t) => {
    const conta = await criarConta({ valor: 100, valorPago: 0, status: 'aberta' })
    t.after(() => apagarContaDireto(conta.id))
    const baixaId = await darBaixaReal(conta.id, 100)
    await supabase.from('baixas_financeiras').update({ conciliado: true }).eq('id', baixaId)

    const r = await chamar('POST', `/api/financeiro/contas/${conta.id}/baixas/${baixaId}/estornos`, {
      token: tokenFinanceiro, body: { motivo_categoria: 'valor_incorreto', motivo_detalhado: 'teste', confirmacao: true },
    })
    assert.equal(r.status, 400)
    assert.match(r.body.erro, /conciliada/)
  })

  await tSuite.test('aprovar/rejeitar estorno: vendedor e papel desconhecido bloqueados (id nem precisa existir)', async () => {
    assert.equal((await chamar('PATCH', `/api/financeiro/estornos/${ID_INEXISTENTE}/aprovar`, { token: tokenVendedorA })).status, 403)
    assert.equal((await chamar('PATCH', `/api/financeiro/estornos/${ID_INEXISTENTE}/rejeitar`, { token: tokenTerceiroPapel, body: { motivo_rejeicao: 'x' } })).status, 403)
  })

  await tSuite.test('financeiro aprova um estorno pendente solicitado por OUTRO usuário — fluxo completo', async (t) => {
    const conta = await criarConta({ valor: 200, valorPago: 0, status: 'aberta' })
    t.after(() => apagarContaDireto(conta.id))
    const baixaId = await darBaixaReal(conta.id, 200)
    const rSolicitar = await chamar('POST', `/api/financeiro/contas/${conta.id}/baixas/${baixaId}/estornos`, {
      token: tokenAdmin, body: { motivo_categoria: 'valor_incorreto', motivo_detalhado: 'teste', confirmacao: true },
    })
    assert.equal(rSolicitar.status, 201)
    const estornoId = rSolicitar.body.estorno_id

    const rAprovar = await chamar('PATCH', `/api/financeiro/estornos/${estornoId}/aprovar`, { token: tokenFinanceiro })
    assert.equal(rAprovar.status, 200, JSON.stringify(rAprovar.body))
    const { data: baixaDepois } = await supabase.from('baixas_financeiras').select('status').eq('id', baixaId).single()
    assert.equal(baixaDepois.status, 'estornada')
  })

  await tSuite.test('RESTRIÇÃO INTERNA CRÍTICA: quem solicitou o estorno NÃO pode aprovar o próprio pedido, mesmo sendo financeiro/admin', async (t) => {
    const conta = await criarConta({ valor: 200, valorPago: 0, status: 'aberta' })
    t.after(() => apagarContaDireto(conta.id))
    const baixaId = await darBaixaReal(conta.id, 200)
    const rSolicitar = await chamar('POST', `/api/financeiro/contas/${conta.id}/baixas/${baixaId}/estornos`, {
      token: tokenFinanceiro, body: { motivo_categoria: 'valor_incorreto', motivo_detalhado: 'teste', confirmacao: true },
    })
    assert.equal(rSolicitar.status, 201)
    const estornoId = rSolicitar.body.estorno_id

    const rAprovarProprio = await chamar('PATCH', `/api/financeiro/estornos/${estornoId}/aprovar`, { token: tokenFinanceiro })
    assert.equal(rAprovarProprio.status, 400, 'o middleware deixou passar (mesmo papel) — quem barra é a RPC')
    assert.match(rAprovarProprio.body.erro, /não pode aprová-lo/)

    // confirma que outro financeiro (papel igual, usuário diferente) consegue
    const rAprovarOutro = await chamar('PATCH', `/api/financeiro/estornos/${estornoId}/aprovar`, { token: tokenAdmin })
    assert.equal(rAprovarOutro.status, 200)
  })

  await tSuite.test('financeiro rejeita um estorno pendente — RESTRIÇÃO INTERNA: quem solicitou não pode rejeitar o próprio', async (t) => {
    const conta = await criarConta({ valor: 200, valorPago: 0, status: 'aberta' })
    t.after(() => apagarContaDireto(conta.id))
    const baixaId = await darBaixaReal(conta.id, 200)
    const rSolicitar = await chamar('POST', `/api/financeiro/contas/${conta.id}/baixas/${baixaId}/estornos`, {
      token: tokenFinanceiro, body: { motivo_categoria: 'valor_incorreto', motivo_detalhado: 'teste', confirmacao: true },
    })
    const estornoId = rSolicitar.body.estorno_id

    const rRejeitarProprio = await chamar('PATCH', `/api/financeiro/estornos/${estornoId}/rejeitar`, { token: tokenFinanceiro, body: { motivo_rejeicao: 'x' } })
    assert.equal(rRejeitarProprio.status, 400)
    assert.match(rRejeitarProprio.body.erro, /não pode rejeitá-lo/)

    const rRejeitarOutro = await chamar('PATCH', `/api/financeiro/estornos/${estornoId}/rejeitar`, { token: tokenAdmin, body: { motivo_rejeicao: 'motivo real' } })
    assert.equal(rRejeitarOutro.status, 200)
    const { data: baixaDepois } = await supabase.from('baixas_financeiras').select('status').eq('id', baixaId).single()
    assert.equal(baixaDepois.status, 'ativa', 'baixa continua ativa — estorno rejeitado nunca a toca')
  })
})

// ATUALIZAÇÃO 2026-09-08: a limitação de ambiente descrita abaixo (parser do
// compat client local não reconhecia a sintaxe de embed do PostgREST com
// apelido + FK nomeada explícita, ex: `solicitado_por:usuarios!estornos_
// financeiros_..._fkey(id, nome)`) FOI corrigida em
// src/lib/localdev/pgCompatClient.js (parseSelect() + resolução de FK por
// introspecção do catálogo, não mais hardcoded). Execução completa (200,
// com os embeds aninhados corretos, inclusive múltiplos apelidos da mesma
// tabela usuarios não colidindo) está provada em
// scripts/tests/collection/pgcompat-embed-fkey-financeiro.test.mjs e
// scripts/tests/unit/pgCompatClient-parseSelect.test.mjs. Os testes abaixo
// continuam existindo aqui porque testam especificamente o GATE de
// autorização (papel) dessas duas rotas — não duplicam a verificação de
// embed, que já está nos arquivos dedicados acima.
test('GET /estornos/pendentes e GET /contas/:contaId/baixas — gate de papel (verificação completa do embed está em pgcompat-embed-fkey-financeiro.test.mjs)', async (tSuite) => {
  await tSuite.test('GET /estornos/pendentes: financeiro autorizado — 200 completo (embed do parser corrigido)', async (t) => {
    const conta = await criarConta({ valor: 200, valorPago: 0, status: 'aberta' })
    t.after(() => apagarContaDireto(conta.id))
    await chamar('PATCH', `/api/financeiro/contas/${conta.id}/baixa`, { token: tokenAdmin, body: { valor_recebido: 200 } })
    const { data: baixa } = await supabase.from('baixas_financeiras').select('id').eq('conta_financeira_id', conta.id).single()
    await chamar('POST', `/api/financeiro/contas/${conta.id}/baixas/${baixa.id}/estornos`, {
      token: tokenAdmin, body: { motivo_categoria: 'valor_incorreto', motivo_detalhado: 'teste', confirmacao: true },
    })

    const r = await chamar('GET', '/api/financeiro/estornos/pendentes', { token: tokenFinanceiro })
    assert.equal(r.status, 200, `gate de papel + parser corrigido: esperava 200; corpo: ${JSON.stringify(r.body)}`)
  })

  await tSuite.test('GET /estornos/pendentes: vendedor continua bloqueado pelo papel (leitura de vendedor não foi alterada nesta etapa)', async () => {
    const r = await chamar('GET', '/api/financeiro/estornos/pendentes', { token: tokenVendedorA })
    assert.equal(r.status, 403)
  })

  await tSuite.test('GET /contas/:contaId/baixas: financeiro não é bloqueado por posse (regra só restringe "vendedor", sem mudança de código) — 200 completo', async (t) => {
    const conta = await criarConta({ vendedorId: idVendedorA, valor: 100, valorPago: 0, status: 'aberta' })
    t.after(() => apagarContaDireto(conta.id))
    const r = await chamar('GET', `/api/financeiro/contas/${conta.id}/baixas`, { token: tokenFinanceiro })
    assert.equal(r.status, 200, `financeiro não é vendedor — a regra de posse não pode bloqueá-lo aqui; corpo: ${JSON.stringify(r.body)}`)
  })

  await tSuite.test('GET /contas/:contaId/baixas: vendedor SEM posse (título de outro vendedor) continua bloqueado — 403 real', async (t) => {
    const conta = await criarConta({ vendedorId: idVendedorA, valor: 100, valorPago: 0, status: 'aberta' }) // dono é vendedor A
    t.after(() => apagarContaDireto(conta.id))
    // "Vendedor sem posse": outro vendedor (id de financeiro reaproveitado só
    // como um segundo id qualquer, com role='vendedor' no token) lendo um
    // título que não é dele.
    const tokenVendedorSemPosse = jwt.sign({ id: idFinanceiro, email: 'vendedor-sem-posse@teste.com', role: 'vendedor' }, process.env.JWT_SECRET)
    const r = await chamar('GET', `/api/financeiro/contas/${conta.id}/baixas`, { token: tokenVendedorSemPosse })
    assert.equal(r.status, 403, 'vendedor sem posse precisa ser bloqueado')
  })
})

test('POST /:id/promessa e /:id/promessa/cancelar — só admin/financeiro', async (tSuite) => {
  await tSuite.test('vendedor e papel desconhecido bloqueados ao criar promessa', async (t) => {
    const conta = await criarConta({ vendedorId: idVendedorA, valor: 100, status: 'aberta' })
    t.after(() => apagarContaDireto(conta.id))
    const amanha = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10)
    const body = { data_prometida: amanha }
    assert.equal((await chamar('POST', `/api/financeiro/${conta.id}/promessa`, { token: tokenVendedorA, body })).status, 403)
    assert.equal((await chamar('POST', `/api/financeiro/${conta.id}/promessa`, { token: tokenTerceiroPapel, body })).status, 403)

    const { data: promessaAtiva } = await supabase.from('collection_promises').select('id').eq('contas_financeiras_id', conta.id).eq('status', 'ativa').maybeSingle()
    assert.equal(promessaAtiva, null, 'nenhuma promessa deveria ter sido criada por uma tentativa negada')
  })

  await tSuite.test('financeiro cria e cancela promessa — fluxo completo autorizado', async (t) => {
    const conta = await criarConta({ valor: 100, status: 'aberta' })
    t.after(() => apagarContaDireto(conta.id))
    const amanha = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10)

    const rCriar = await chamar('POST', `/api/financeiro/${conta.id}/promessa`, { token: tokenFinanceiro, body: { data_prometida: amanha } })
    assert.equal(rCriar.status, 201, JSON.stringify(rCriar.body))

    const rCancelar = await chamar('POST', `/api/financeiro/${conta.id}/promessa/cancelar`, { token: tokenFinanceiro, body: { motivo: 'teste' } })
    assert.equal(rCancelar.status, 200)
  })
})
