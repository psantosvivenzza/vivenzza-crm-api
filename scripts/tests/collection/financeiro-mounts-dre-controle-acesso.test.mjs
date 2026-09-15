// Controle de acesso — COMPLEMENTOS POSTERIORES à decisão de 2026-09-07
// (revisão pedida em 2026-09-08): em src/index.js, 6 routers inteiros
// trocaram o middleware de mount de `adminOnly` pra `adminOuFinanceiro`
// (aging, dashboard-recuperacao, cobrancas, collection-shadow,
// collection-whatsapp, collection-contact-review), e GET /relatorios/dre
// ganhou o mesmo gate dentro de relatorios.js. financeiro-controle-acesso.
// test.mjs já cobre as mutações de src/routes/financeiro.js (baixa/cancelar/
// estorno/promessa) — este arquivo cobre especificamente os 6 mounts + DRE.
//
// ATUALIZAÇÃO 2026-09-08 (política de cobrança aprovada, rodada 2): a
// primeira versão desta suíte tratava POST /api/cobrancas/toggle e POST
// /api/cobrancas/disparar como liberados pra financeiro (mesmo gate
// compartilhado do mount do router). Política aprovada corrigiu isso: essas
// duas são CONFIGURAÇÃO/AÇÃO GLOBAL de automação (afetam a régua inteira,
// não uma conta/cliente específico) — agora só admin, via `adminOnly`
// aplicado direto nessas duas rotas em src/routes/cobrancas.js, além (antes)
// do `adminOuFinanceiro` do mount. Cobrança individual
// (disparar-individual/:pessoaNome) continua admin+financeiro, sem mudança.
//
// Objetivo explícito desta suíte (não confundir "ver o bloco" com
// autorização automática pra qualquer coisa dentro dele): provar que (1)
// financeiro acessa de fato os recursos aprovados, inclusive as escritas
// reais que continuam liberadas pra ele; (2) financeiro recebe 403 nos dois
// endpoints GLOBAIS (toggle/disparar), comprovado por instrumentação — não
// só o status HTTP, mas leitura direta do banco (config não mudou) e espião
// em console.log confirmando que o job `executarReguaCobranca` nunca
// chegou a rodar (suas próprias linhas de log nunca aparecem); (3) admin
// mantém acesso aos dois; (4) vendedor continua bloqueado, leitura e
// escrita, sem exceção; (5) financeiro NÃO ganhou acesso a usuarios/
// campanhas/config fora do escopo do bloco financeiro — inclusive
// contrastando com um mount que SOA parecido mas não mudou
// (collection-shadow-status continua adminOnly, diferente de
// collection-shadow); (6) papel ausente/desconhecido nunca ganha acesso a
// nada aqui.
//
// NENHUM disparo real de WhatsApp em nenhuma hipótese: POST /cobrancas/
// disparar (quando chamado por admin) só é chamado com o kill-switch
// automacoes_config.cobranca_whatsapp_ativa explicitamente forçado pra
// false logo antes (a função retorna cedo, sem consultar contas nem chamar
// a Evolution — ver src/jobs/cobranca-whatsapp.js linha ~128); POST
// /cobrancas/disparar-individual só é chamado com um pessoaNome sintético
// SEM título nenhum, que a própria rota rejeita com 404 antes de montar
// qualquer mensagem ou chamar enviarCobrancaComRoteamento. Ambos provam o
// GATE de autorização sem nenhum efeito colateral de envio.
//
// Rotas reais, montadas com a MESMA cadeia de middleware usada em
// src/index.js, Postgres local exclusivo, dados 100% sintéticos. Nenhum
// usuário real é criado — só linhas de teste na tabela `usuarios` deste
// banco local isolado, no mesmo padrão já usado por
// financeiro-controle-acesso.test.mjs e usuarios-papel-financeiro.test.mjs.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import jwt from 'jsonwebtoken'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste, criarContaDeTeste } from './_setup.mjs'

let supabase, server, porta
let idAdmin, idFinanceiro, idVendedorA, idTerceiroPapel
let tokenAdmin, tokenFinanceiro, tokenVendedorA, tokenTerceiroPapel, tokenSemRole
const contasCriadas = []
const clientesErpCriados = []
const cobrancasWhatsappCriadas = []

before(async () => {
  await iniciarAmbienteDeTeste()
  ;({ supabase } = await import('../../../src/lib/supabase-admin.server.js'))
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-teste'

  const sufixo = Date.now()
  async function criarUsuarioDeTeste(role, rotulo) {
    const { data, error } = await supabase.from('usuarios')
      .insert({ nome: `${rotulo} (teste fmd)`, email: `${rotulo}-${sufixo}@teste-fmd.local`, role, ativo: true })
      .select('id').single()
    if (error) throw error
    return data.id
  }
  idAdmin = await criarUsuarioDeTeste('admin', 'admin')
  idFinanceiro = await criarUsuarioDeTeste('financeiro', 'financeiro')
  idVendedorA = await criarUsuarioDeTeste('vendedor', 'vendedor-a')
  // ACHADO REAL (2026-09-09): usuarios_role_check em produção só aceita
  // admin/vendedor/financeiro — reproduzido fielmente no baseline local
  // desde então. Um INSERT direto com role='gerente' agora FALHA de
  // verdade. O papel "desconhecido" testado aqui é sobre o CLAIM do
  // token — é só isso que auth() lê, nunca reconsulta o banco — não sobre
  // a linha em si, que só existe como âncora de FK. Reaproveita o id de
  // um usuário já válido (idVendedorA), igual tokenSemRole já faz com
  // idAdmin logo abaixo.
  idTerceiroPapel = idVendedorA

  tokenAdmin = jwt.sign({ id: idAdmin, email: 'admin@teste.com', role: 'admin' }, process.env.JWT_SECRET)
  tokenFinanceiro = jwt.sign({ id: idFinanceiro, email: 'financeiro@teste.com', role: 'financeiro' }, process.env.JWT_SECRET)
  tokenVendedorA = jwt.sign({ id: idVendedorA, email: 'a@teste.com', role: 'vendedor' }, process.env.JWT_SECRET)
  tokenTerceiroPapel = jwt.sign({ id: idTerceiroPapel, email: 'terceiro@teste.com', role: 'gerente' }, process.env.JWT_SECRET)
  tokenSemRole = jwt.sign({ id: idAdmin, email: 'sem-role@teste.com' }, process.env.JWT_SECRET) // sem claim "role"

  const express = (await import('express')).default
  const { auth, adminOnly, adminOuFinanceiro } = await import('../../../src/middleware/auth.js')
  const agingRouter = (await import('../../../src/routes/aging.js')).default
  const dashboardRecuperacaoRouter = (await import('../../../src/routes/dashboard-recuperacao.js')).default
  const cobrancasRouter = (await import('../../../src/routes/cobrancas.js')).default
  const collectionShadowReportsRouter = (await import('../../../src/routes/collection-shadow-reports.js')).default
  const collectionWhatsappMonitorRouter = (await import('../../../src/routes/collection-whatsapp-monitor.js')).default
  const collectionContactReviewRouter = (await import('../../../src/routes/collection-contact-review.js')).default
  const relatoriosRouter = (await import('../../../src/routes/relatorios.js')).default
  const usuariosRouter = (await import('../../../src/routes/usuarios.js')).default
  const campanhasRouter = (await import('../../../src/routes/campanhas.js')).default
  const collectionShadowStatusRouter = (await import('../../../src/routes/collection-shadow-status.js')).default

  const app = express()
  app.use(express.json())

  // Montagem IDÊNTICA (mesma ordem de middleware) à de src/index.js pros 6
  // mounts que trocaram pra adminOuFinanceiro em 08/09:
  app.use('/api/financeiro/aging', auth, adminOuFinanceiro, agingRouter)
  app.use('/api/financeiro/dashboard-recuperacao', auth, adminOuFinanceiro, dashboardRecuperacaoRouter)
  app.use('/api/cobrancas', auth, adminOuFinanceiro, cobrancasRouter)
  app.use('/api/collection-shadow', auth, adminOuFinanceiro, collectionShadowReportsRouter)
  app.use('/api/collection-whatsapp', auth, adminOuFinanceiro, collectionWhatsappMonitorRouter)
  app.use('/api/collection-contact-review', auth, adminOuFinanceiro, collectionContactReviewRouter)
  // GET /dre: o gate é DENTRO de relatorios.js (não no mount) — mount real é só `auth`.
  app.use('/api/relatorios', auth, relatoriosRouter)

  // Comparação NEGATIVA — fora do escopo da decisão de 08/09, montados
  // exatamente como em produção, sem alteração nenhuma:
  app.use('/api/usuarios', auth, usuariosRouter) // gate é per-route (adminOnly), não no mount
  app.use('/api/admin/campanhas', auth, adminOnly, campanhasRouter)
  // Mesma "família" de nome que collection-shadow, mas NÃO mudou — continua adminOnly:
  app.use('/api/collection-shadow-status', auth, adminOnly, collectionShadowStatusRouter)

  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  porta = server.address().port
})

after(async () => {
  server?.close()
  // FK: collection_contact_review_actions.registrado_por → usuarios(id) —
  // apagar antes de apagar os usuários de teste.
  await supabase.from('collection_contact_review_actions').delete().in('registrado_por', [idAdmin, idFinanceiro, idVendedorA, idTerceiroPapel])
  if (cobrancasWhatsappCriadas.length) await supabase.from('cobrancas_whatsapp').delete().in('id', cobrancasWhatsappCriadas)
  if (contasCriadas.length) await supabase.from('contas_financeiras').delete().in('id', contasCriadas)
  if (clientesErpCriados.length) await supabase.from('clientes_erp').delete().in('legacy_id', clientesErpCriados)
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

async function criarContaSimples({ pessoaNome, telefone = null }) {
  const { data, error } = await supabase.from('contas_financeiras').insert({
    tipo: 'receber', descricao: 'Conta de teste — mounts/DRE', valor: 100, valor_pago: 0,
    vencimento: new Date().toISOString().slice(0, 10), status: 'aberta',
    pessoa_nome: pessoaNome, telefone_cobranca: telefone,
  }).select().single()
  if (error) throw error
  contasCriadas.push(data.id)
  return data
}

async function forcarKillSwitchDesligado() {
  const { error } = await supabase.from('automacoes_config').update({ cobranca_whatsapp_ativa: false }).eq('id', 1)
  if (error) throw error
}

// Prova FORTE de que o job executarReguaCobranca() nunca rodou — ausência de
// log não basta sozinha (o job pode ser alterado pra logar menos, ou a
// ausência pode ter outra causa; não é uma trava real). Em vez disso,
// intercepta a PRÓPRIA dependência que o job toca incondicionalmente como
// primeiríssima ação, sem try/catch local: `cobrancaEstaAtiva()`, dentro de
// executarReguaCobranca(), chama `supabase.from('automacoes_config').select(
// ...)` direto (ver src/jobs/cobranca-whatsapp.js linhas 20-23) — ANTES de
// checar horário, limite diário ou sync. Instrumenta essa chamada real pra
// CONTAR e FALHAR (throw síncrono) se for alcançada — não simula um erro de
// negócio comum, propositalmente quebra alto e explícito. `supabase` aqui é
// o MESMO objeto (singleton de módulo, mesmo caminho resolvido) que
// src/jobs/cobranca-whatsapp.js importa — a troca de `.from` afeta a chamada
// real do job, não uma cópia. Se o gate `adminOnly` bloqueou corretamente
// ANTES do handler (comportamento esperado pra financeiro/vendedor/papel
// inválido), o contador fica 0 e nada dispara. Se o gate tivesse um bug e
// deixasse passar, o throw estoura na hora, o catch da rota devolve 500 (não
// 403) E o contador não fica 0 — qualquer um dos dois já reprova o teste.
// Não altera nenhuma regra de negócio: só troca temporariamente uma
// referência de função no cliente, sempre restaurada no finally do chamador.
function instalarTravaJobCobranca() {
  const fromOriginal = supabase.from.bind(supabase)
  let chamadas = 0
  supabase.from = (tabela, ...resto) => {
    if (tabela === 'automacoes_config') {
      chamadas++
      throw new Error('TRAVA DE TESTE: executarReguaCobranca() alcançou automacoes_config — o gate adminOnly deveria ter bloqueado ANTES do handler rodar o job')
    }
    return fromOriginal(tabela, ...resto)
  }
  return {
    chamadas: () => chamadas,
    remover: () => { supabase.from = fromOriginal },
  }
}

test('financeiro acessa os recursos de LEITURA aprovados (os 6 mounts + DRE)', async (tSuite) => {
  await tSuite.test('GET /api/financeiro/aging/resumo e /api/financeiro/aging/', async () => {
    assert.equal((await chamar('GET', '/api/financeiro/aging/resumo', { token: tokenFinanceiro })).status, 200)
    assert.equal((await chamar('GET', '/api/financeiro/aging/', { token: tokenFinanceiro })).status, 200)
  })

  await tSuite.test('GET /api/financeiro/dashboard-recuperacao/', async () => {
    const r = await chamar('GET', '/api/financeiro/dashboard-recuperacao/', { token: tokenFinanceiro })
    assert.equal(r.status, 200, JSON.stringify(r.body))
  })

  await tSuite.test('GET /api/cobrancas/ e /api/cobrancas/status', async () => {
    assert.equal((await chamar('GET', '/api/cobrancas/', { token: tokenFinanceiro })).status, 200)
    assert.equal((await chamar('GET', '/api/cobrancas/status', { token: tokenFinanceiro })).status, 200)
  })

  await tSuite.test('GET /api/collection-shadow/summary', async () => {
    const r = await chamar('GET', '/api/collection-shadow/summary', { token: tokenFinanceiro })
    assert.equal(r.status, 200, JSON.stringify(r.body))
  })

  await tSuite.test('GET /api/collection-whatsapp/instances', async () => {
    const r = await chamar('GET', '/api/collection-whatsapp/instances', { token: tokenFinanceiro })
    assert.equal(r.status, 200, JSON.stringify(r.body))
  })

  await tSuite.test('GET /api/collection-contact-review/', async () => {
    const r = await chamar('GET', '/api/collection-contact-review/', { token: tokenFinanceiro })
    assert.equal(r.status, 200, JSON.stringify(r.body))
  })

  await tSuite.test('GET /api/relatorios/dre?ano=2026 — gate autoriza financeiro (BLOQUEIO DE AMBIENTE conhecido: `nfe`/`nfe_itens` não têm baseline local nem migration versionada — mesmo padrão já documentado pra sdr_conversas/leads.atendimento_humano e pela auditoria NetVision; só existem no Supabase de produção. Não fabricado aqui: fora do escopo desta revisão de acesso. Por isso só provamos o GATE, não o cálculo do DRE)', async () => {
    const r = await chamar('GET', '/api/relatorios/dre?ano=2026', { token: tokenFinanceiro })
    assert.notEqual(r.status, 403, `gate precisa deixar financeiro passar pro handler; veio 403 — corpo: ${JSON.stringify(r.body)}`)
    assert.equal(r.status, 500, JSON.stringify(r.body))
    assert.match(r.body.erro, /nfe/, 'confirma que o 500 é o gap de schema local (tabela nfe), não um erro de autorização')
  })
})

test('financeiro acessa e EXECUTA de fato as escritas liberadas por estes mounts (sem envio real de WhatsApp)', async (tSuite) => {
  await tSuite.test('PATCH /api/financeiro/aging/telefone — atualiza telefone_cobranca em lote', async (t) => {
    const conta = await criarContaSimples({ pessoaNome: `Cliente Aging ${Date.now()}`, telefone: '5551900000001' })
    const r = await chamar('PATCH', '/api/financeiro/aging/telefone', {
      token: tokenFinanceiro, body: { pessoa_nome: conta.pessoa_nome, telefone: '5551999999999' },
    })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    // NÃO afirmamos r.body.titulos_atualizados aqui: BLOQUEIO DE AMBIENTE
    // conhecido — o compat client local (pgCompatClient.js) não implementa a
    // opção `{ count: 'exact' }` no `.update()` (só no `.select()`), então
    // `count` sempre volta undefined localmente, mesmo a escrita tendo
    // funcionado de verdade (contra o Supabase real em produção, `count`
    // funciona normalmente). A prova real e definitiva de que a escrita
    // aconteceu é a leitura direta do banco logo abaixo.
    const { data: depois } = await supabase.from('contas_financeiras').select('telefone_cobranca').eq('id', conta.id).single()
    assert.equal(depois.telefone_cobranca, '5551999999999')
  })

  await tSuite.test('PATCH /api/cobrancas/:id/status — marca cobrança como respondida', async (t) => {
    const { data: registro, error } = await supabase.from('cobrancas_whatsapp').insert({
      cliente_nome: 'Cliente Cobranca Teste', cliente_telefone: '5551900000002', valor: 100,
      vencimento: new Date().toISOString().slice(0, 10), dias_atraso: 5, etapa: 1,
      status: 'enviada', origem: 'manual', data_envio: new Date().toISOString(), mensagem_enviada: 'x',
    }).select().single()
    if (error) throw error
    cobrancasWhatsappCriadas.push(registro.id)

    const r = await chamar('PATCH', `/api/cobrancas/${registro.id}/status`, { token: tokenFinanceiro, body: { status: 'respondida' } })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.status, 'respondida')
  })

  await tSuite.test('POST /api/collection-contact-review/:codigoCliente/acao — insere ação auditável, registrado_por é sempre do token', async (t) => {
    const conta = await criarContaDeTeste(supabase, { pessoa_nome: `Cliente Revisao ${Date.now()}` })
    clientesErpCriados.push(conta.codigo_cliente)

    const r = await chamar('POST', `/api/collection-contact-review/${conta.codigo_cliente}/acao`, {
      token: tokenFinanceiro, body: { acao: 'revisado', motivo: 'teste automatizado' },
    })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    const { data: linha } = await supabase.from('collection_contact_review_actions').select('registrado_por, acao').eq('id', r.body.acao.id).single()
    assert.equal(linha.registrado_por, idFinanceiro, 'registrado_por precisa ser sempre o id do token autenticado, nunca aceito do corpo')
    assert.equal(linha.acao, 'revisado')
  })

  await tSuite.test('POST /api/cobrancas/disparar-individual/:pessoaNome — gate autoriza financeiro; sem título, handler para no 404 ANTES de montar/enviar qualquer mensagem', async () => {
    const nomeInexistente = `Pessoa Sem Titulo Nenhum ${Date.now()}`
    const r = await chamar('POST', `/api/cobrancas/disparar-individual/${encodeURIComponent(nomeInexistente)}`, { token: tokenFinanceiro })
    assert.equal(r.status, 404, 'prova que o gate deixou passar pro handler (não é 403) — o 404 vem da própria lógica de negócio, ANTES de qualquer envio')
    assert.match(r.body.erro, /Nenhum título em aberto/)
  })

})

test('política aprovada (2026-09-08): POST /api/cobrancas/toggle e POST /api/cobrancas/disparar são AÇÃO/CONFIGURAÇÃO GLOBAL — só admin; financeiro é bloqueado, comprovado por instrumentação (não só o status HTTP)', async (tSuite) => {
  await tSuite.test('financeiro: POST /toggle → 403, configuração não muda (leitura direta do banco, não só a resposta HTTP)', async () => {
    await forcarKillSwitchDesligado()
    const antes = await supabase.from('automacoes_config').select('cobranca_whatsapp_ativa').eq('id', 1).single()
    assert.equal(antes.data.cobranca_whatsapp_ativa, false)

    const r = await chamar('POST', '/api/cobrancas/toggle', { token: tokenFinanceiro })
    assert.equal(r.status, 403, JSON.stringify(r.body))

    const depois = await supabase.from('automacoes_config').select('cobranca_whatsapp_ativa').eq('id', 1).single()
    assert.equal(depois.data.cobranca_whatsapp_ativa, false, 'kill-switch precisa continuar exatamente como estava — 403 não pode ter efeito colateral nenhum')
  })

  await tSuite.test('POST /disparar → 403 pra financeiro/vendedor/papel desconhecido/token sem role, e o job executarReguaCobranca NUNCA roda — comprovado travando a dependência real que ele toca primeiro (não a ausência de log)', async () => {
    await forcarKillSwitchDesligado()
    for (const [rotulo, token] of [
      ['financeiro', tokenFinanceiro],
      ['vendedor', tokenVendedorA],
      ['papel desconhecido (gerente)', tokenTerceiroPapel],
      ['token sem claim "role"', tokenSemRole],
    ]) {
      const trava = instalarTravaJobCobranca()
      let r
      try {
        r = await chamar('POST', '/api/cobrancas/disparar', { token })
      } finally {
        trava.remover()
      }
      assert.equal(r.status, 403, `${rotulo}: esperava 403, veio ${r.status} — corpo: ${JSON.stringify(r.body)}`)
      assert.equal(trava.chamadas(), 0, `${rotulo}: executarReguaCobranca() não podia ter alcançado automacoes_config — o gate precisa bloquear ANTES do handler`)
    }
  })

  await tSuite.test('admin: POST /toggle → 200, liga o kill-switch de verdade (confirmado por leitura direta do banco)', async (t) => {
    await forcarKillSwitchDesligado()
    t.after(forcarKillSwitchDesligado) // restaura pro estado padrão (desligado) pros testes seguintes

    const r = await chamar('POST', '/api/cobrancas/toggle', { token: tokenAdmin })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.cobranca_whatsapp_ativa, true)
    const { data: depois } = await supabase.from('automacoes_config').select('cobranca_whatsapp_ativa').eq('id', 1).single()
    assert.equal(depois.cobranca_whatsapp_ativa, true, 'admin precisa conseguir ligar o kill-switch de verdade')
  })

  await tSuite.test('admin: POST /disparar → 200; kill-switch forçado desligado garante ZERO consulta a conta e ZERO chamada à Evolution', async () => {
    await forcarKillSwitchDesligado()
    const r = await chamar('POST', '/api/cobrancas/disparar', { token: tokenAdmin })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.ativo, false, 'prova (pela própria resposta do job) que a régua saiu no early-return de automacoes_config.cobranca_whatsapp_ativa=false — nunca chegou a consultar contas nem a Evolution')
    assert.equal(r.body.enviadas, 0)
  })
})

test('vendedor continua bloqueado (403) em TODA operação destes mounts — leitura e escrita, sem exceção', async (tSuite) => {
  await tSuite.test('leituras: aging, dashboard-recuperacao, cobrancas, collection-shadow, collection-whatsapp, collection-contact-review, DRE', async () => {
    for (const path of [
      '/api/financeiro/aging/resumo',
      '/api/financeiro/dashboard-recuperacao/',
      '/api/cobrancas/',
      '/api/cobrancas/status',
      '/api/collection-shadow/summary',
      '/api/collection-whatsapp/instances',
      '/api/collection-contact-review/',
      '/api/relatorios/dre?ano=2026',
    ]) {
      const r = await chamar('GET', path, { token: tokenVendedorA })
      assert.equal(r.status, 403, `esperava 403 pra vendedor em GET ${path}, veio ${r.status}`)
    }
  })

  await tSuite.test('PATCH /api/financeiro/aging/telefone — bloqueado, nada muda', async () => {
    const conta = await criarContaSimples({ pessoaNome: `Cliente Aging Vend ${Date.now()}`, telefone: '5551900000003' })
    const r = await chamar('PATCH', '/api/financeiro/aging/telefone', { token: tokenVendedorA, body: { pessoa_nome: conta.pessoa_nome, telefone: '5551900000099' } })
    assert.equal(r.status, 403)
    const { data: depois } = await supabase.from('contas_financeiras').select('telefone_cobranca').eq('id', conta.id).single()
    assert.equal(depois.telefone_cobranca, '5551900000003', 'telefone não pode ter mudado')
  })

  await tSuite.test('POST /api/cobrancas/toggle — bloqueado, kill-switch não muda', async () => {
    await forcarKillSwitchDesligado()
    const r = await chamar('POST', '/api/cobrancas/toggle', { token: tokenVendedorA })
    assert.equal(r.status, 403)
    const { data: depois } = await supabase.from('automacoes_config').select('cobranca_whatsapp_ativa').eq('id', 1).single()
    assert.equal(depois.cobranca_whatsapp_ativa, false, 'kill-switch não pode ter mudado')
  })

  await tSuite.test('POST /api/cobrancas/disparar e /disparar-individual/:x — bloqueados ANTES do handler (nem precisa existir cliente/config)', async () => {
    assert.equal((await chamar('POST', '/api/cobrancas/disparar', { token: tokenVendedorA })).status, 403)
    assert.equal((await chamar('POST', `/api/cobrancas/disparar-individual/${encodeURIComponent('Qualquer Nome')}`, { token: tokenVendedorA })).status, 403)
  })

  await tSuite.test('PATCH /api/cobrancas/:id/status — bloqueado (id nem precisa existir, gate roda antes)', async () => {
    const r = await chamar('PATCH', '/api/cobrancas/00000000-0000-0000-0000-000000000000/status', { token: tokenVendedorA, body: { status: 'respondida' } })
    assert.equal(r.status, 403)
  })

  await tSuite.test('POST /api/collection-contact-review/:codigoCliente/acao — bloqueado, nenhuma linha inserida', async () => {
    const conta = await criarContaDeTeste(supabase, { pessoa_nome: `Cliente Revisao Vend ${Date.now()}` })
    clientesErpCriados.push(conta.codigo_cliente)
    const r = await chamar('POST', `/api/collection-contact-review/${conta.codigo_cliente}/acao`, { token: tokenVendedorA, body: { acao: 'revisado' } })
    assert.equal(r.status, 403)
    const { data: linhas } = await supabase.from('collection_contact_review_actions').select('id').eq('codigo_cliente', conta.codigo_cliente)
    assert.equal(linhas.length, 0)
  })
})

test('financeiro NÃO administra usuários, campanhas ou configurações fora do escopo do bloco financeiro', async (tSuite) => {
  await tSuite.test('GET/POST /api/usuarios — bloqueado (gate é per-route adminOnly, não muda com o papel financeiro)', async () => {
    assert.equal((await chamar('GET', '/api/usuarios', { token: tokenFinanceiro })).status, 403)
    const r = await chamar('POST', '/api/usuarios', {
      token: tokenFinanceiro, body: { nome: 'X', email: `financeiro-tentou-${Date.now()}@teste-fmd.local`, senha: 'senha123456', role: 'admin' },
    })
    assert.equal(r.status, 403)
  })

  await tSuite.test('PATCH /api/usuarios/:id — financeiro não consegue alterar papel de outro usuário (nem o próprio)', async () => {
    const antes = await supabase.from('usuarios').select('role').eq('id', idVendedorA).single()
    assert.equal(antes.data.role, 'vendedor')
    const r = await chamar('PATCH', `/api/usuarios/${idVendedorA}`, { token: tokenFinanceiro, body: { role: 'admin' } })
    assert.equal(r.status, 403)
    const depois = await supabase.from('usuarios').select('role').eq('id', idVendedorA).single()
    assert.equal(depois.data.role, 'vendedor')

    const rProprio = await chamar('PATCH', `/api/usuarios/${idFinanceiro}`, { token: tokenFinanceiro, body: { role: 'admin' } })
    assert.equal(rProprio.status, 403, 'financeiro também não pode se auto-elevar')
  })

  await tSuite.test('GET /api/admin/campanhas — bloqueado (mount adminOnly, fora do bloco financeiro)', async () => {
    const r = await chamar('GET', '/api/admin/campanhas', { token: tokenFinanceiro })
    assert.equal(r.status, 403)
  })

  await tSuite.test('GET /api/collection-shadow-status — bloqueado; CONTRASTE deliberado com /api/collection-shadow (que financeiro acessa) — nome parecido, decisão diferente, mount não mudou', async () => {
    const r = await chamar('GET', '/api/collection-shadow-status', { token: tokenFinanceiro })
    assert.equal(r.status, 403, 'collection-shadow-status continua adminOnly — a troca de mount foi só nos 6 routers explicitamente decididos em 08/09')
  })
})

test('papel ausente/desconhecido não ganha acesso a nenhum destes mounts', async (tSuite) => {
  for (const [rotulo, token] of [['papel desconhecido (gerente)', tokenTerceiroPapel], ['token sem claim "role"', tokenSemRole]]) {
    await tSuite.test(`${rotulo}: bloqueado em leitura (aging) e escrita (toggle, disparar, acao) e no DRE`, async () => {
      assert.equal((await chamar('GET', '/api/financeiro/aging/resumo', { token })).status, 403)
      assert.equal((await chamar('GET', '/api/relatorios/dre?ano=2026', { token })).status, 403)
      assert.equal((await chamar('POST', '/api/cobrancas/toggle', { token })).status, 403)
      assert.equal((await chamar('POST', '/api/cobrancas/disparar', { token })).status, 403)
      assert.equal((await chamar('POST', `/api/cobrancas/disparar-individual/${encodeURIComponent('Qualquer')}`, { token })).status, 403)
      assert.equal((await chamar('POST', '/api/collection-contact-review/QUALQUER-CODIGO/acao', { token, body: { acao: 'revisado' } })).status, 403)
    })
  }

  await tSuite.test('kill-switch continua desligado no fim da suíte (nenhum teste deixou "ligado" pra trás)', async () => {
    const { data } = await supabase.from('automacoes_config').select('cobranca_whatsapp_ativa').eq('id', 1).single()
    assert.equal(data.cobranca_whatsapp_ativa, false)
  })
})
