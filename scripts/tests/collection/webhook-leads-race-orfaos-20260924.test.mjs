// Investigação dedicada (2026-09-24): 46 leads órfãos/duplicados reais em
// 22-23/09, concentrados em rajadas de poucos segundos do mesmo contato
// (reenvio em lote da Evolution API ao reconectar). Duas causas confirmadas
// por leitura do código, ambas cobertas aqui:
//
// 1) processWhatsappEvent() fazia um SELECT por telefone e, se não achasse
//    nada, um INSERT — sem lock nem constraint único em leads.telefone. Duas
//    chamadas concorrentes pro MESMO telefone achavam as duas "nenhum lead
//    ainda" e criavam duas linhas. Corrigido com criarOuObterLeadWhatsapp()
//    (advisory lock por telefone, ver src/lib/distribuicao.js +
//    supabase/migrations/20260101000074_criar_lead_whatsapp_atomic.sql).
//
// 2) proximoVendedor() não tinha retry — uma falha transiente da RPC virava
//    responsavel_id NULL permanente. Corrigido com retry controlado
//    (chamarRpcComRetry em src/lib/distribuicao.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste, telefoneDeTeste } from './_setup.mjs'

function eventoWhatsapp({ telefoneJid, msgId, texto }) {
  return {
    event: 'messages.upsert',
    data: {
      key: { remoteJid: `${telefoneJid}@s.whatsapp.net`, id: msgId, fromMe: false },
      message: { conversation: texto },
    },
  }
}

async function criarVendedorDeTeste(supabase, overrides = {}) {
  const unico = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const { data, error } = await supabase.from('usuarios').insert({
    nome: `Vendedora Teste Race ${unico}`,
    email: `vendedora-race-${unico}@teste.local`,
    role: 'vendedor',
    ativo: true,
    recebe_leads: true,
    ...overrides,
  }).select().single()
  if (error) throw error
  return data
}

test('webhook-handler.js: rajada concorrente do mesmo contato — sem duplicar lead, sem órfão, sem perder mensagem', async (t) => {
  await iniciarAmbienteDeTeste()
  const { supabase } = await import('../../../src/lib/supabase-admin.server.js')
  const { processWhatsappEvent } = await import('../../../src/routes/webhook-handler.js')

  await t.test('1. N mensagens concorrentes do MESMO telefone novo criam exatamente 1 lead, com vendedor atribuído', async () => {
    await criarVendedorDeTeste(supabase)

    const telefoneJid = telefoneDeTeste()
    const N = 8
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        processWhatsappEvent(eventoWhatsapp({ telefoneJid, msgId: `race-msg-${telefoneJid}-${i}`, texto: `mensagem ${i} da rajada` }))
      )
    )

    const semPrefixo = telefoneJid.replace(/^55/, '')
    const { data: leadsCriados } = await supabase.from('leads').select('id, responsavel_id').eq('telefone', semPrefixo)
    assert.equal(leadsCriados.length, 1, `esperava exatamente 1 lead pro telefone da rajada, achou ${leadsCriados.length} — duplicação sob concorrência`)
    assert.ok(leadsCriados[0].responsavel_id, 'lead não pode ficar órfão (responsavel_id NULL) havendo vendedor ativo elegível')

    const { data: mensagensGravadas } = await supabase.from('whatsapp_mensagens').select('id, lead_id').eq('telefone', telefoneJid)
    assert.equal(mensagensGravadas.length, N, 'nenhuma mensagem da rajada pode ser perdida, mesmo com a corrida de criação de lead')
    for (const m of mensagensGravadas) {
      assert.equal(m.lead_id, leadsCriados[0].id, 'toda mensagem da rajada deve apontar pro mesmo lead único (nunca pro duplicado que não deveria existir)')
    }
  })

  await t.test('2. rajada mista (telefone repetido + telefones novos distintos) nunca mistura leads entre contatos diferentes', async () => {
    await criarVendedorDeTeste(supabase)

    const telefoneA = telefoneDeTeste()
    const telefoneB = telefoneDeTeste()
    const eventos = []
    for (let i = 0; i < 5; i++) eventos.push(eventoWhatsapp({ telefoneJid: telefoneA, msgId: `mix-a-${telefoneA}-${i}`, texto: `A${i}` }))
    for (let i = 0; i < 5; i++) eventos.push(eventoWhatsapp({ telefoneJid: telefoneB, msgId: `mix-b-${telefoneB}-${i}`, texto: `B${i}` }))
    await Promise.all(eventos.map((e) => processWhatsappEvent(e)))

    const { data: leadsA } = await supabase.from('leads').select('id').eq('telefone', telefoneA.replace(/^55/, ''))
    const { data: leadsB } = await supabase.from('leads').select('id').eq('telefone', telefoneB.replace(/^55/, ''))
    assert.equal(leadsA.length, 1, 'telefone A deveria ter exatamente 1 lead')
    assert.equal(leadsB.length, 1, 'telefone B deveria ter exatamente 1 lead')
    assert.notEqual(leadsA[0].id, leadsB[0].id, 'contatos diferentes nunca podem cair no mesmo lead')
  })

  await t.test('3. mesmo se criar/obter lead falhar completamente (RPC sempre quebrada), a mensagem do WhatsApp nunca é perdida', async () => {
    const rpcOriginal = supabase.rpc
    supabase.rpc = async (fnName, params) => {
      if (fnName === 'criar_lead_whatsapp_atomic') {
        return { data: null, error: { message: 'sempre falha (simulado)', code: 'ECONNRESET' } }
      }
      return rpcOriginal(fnName, params)
    }
    try {
      const telefoneJid = telefoneDeTeste()
      await processWhatsappEvent(eventoWhatsapp({ telefoneJid, msgId: `falha-total-${telefoneJid}`, texto: 'oi' }))

      const { data: leadsCriados } = await supabase.from('leads').select('id').eq('telefone', telefoneJid.replace(/^55/, ''))
      assert.equal(leadsCriados.length, 0, 'nenhum lead deveria ter sido criado quando a RPC falha em todas as tentativas')

      const { data: mensagensGravadas } = await supabase.from('whatsapp_mensagens').select('id, lead_id').eq('telefone', telefoneJid)
      assert.equal(mensagensGravadas.length, 1, 'a mensagem tem que ser salva mesmo quando a criação do lead falha por completo')
      assert.equal(mensagensGravadas[0].lead_id, null)
    } finally {
      supabase.rpc = rpcOriginal
    }
  })

  await pararAmbienteDeTeste()
})

test('distribuicao.js: retry controlado da RPC proximo_vendedor_atomic', async (t) => {
  await iniciarAmbienteDeTeste()
  const { supabase } = await import('../../../src/lib/supabase-admin.server.js')
  const { proximoVendedor } = await import('../../../src/lib/distribuicao.js')

  await t.test('1. tenta de novo depois de falhas transientes e consegue um vendedor na 3ª tentativa', async () => {
    await criarVendedorDeTeste(supabase)

    const rpcOriginal = supabase.rpc
    let chamadas = 0
    supabase.rpc = async (fnName, params) => {
      if (fnName !== 'proximo_vendedor_atomic') return rpcOriginal(fnName, params)
      chamadas++
      if (chamadas < 3) return { data: null, error: { message: 'conexão indisponível (simulado)', code: 'ECONNRESET' } }
      return rpcOriginal(fnName, params)
    }
    try {
      const vendedor = await proximoVendedor()
      assert.ok(vendedor?.id, 'deveria ter conseguido um vendedor depois das tentativas de retry')
      assert.equal(chamadas, 3, 'deveria ter tentado 3 vezes (2 falhas transientes + 1 sucesso)')
    } finally {
      supabase.rpc = rpcOriginal
    }
  })

  await t.test('2. esgota as tentativas configuradas e devolve null sem lançar (nunca derruba o webhook)', async () => {
    const rpcOriginal = supabase.rpc
    let chamadas = 0
    supabase.rpc = async (fnName, params) => {
      if (fnName !== 'proximo_vendedor_atomic') return rpcOriginal(fnName, params)
      chamadas++
      return { data: null, error: { message: 'sempre falha (simulado)', code: 'ECONNRESET' } }
    }
    try {
      const vendedor = await proximoVendedor()
      assert.equal(vendedor, null)
      assert.equal(chamadas, 3, 'deveria ter esgotado as 3 tentativas configuradas, nem uma a mais')
    } finally {
      supabase.rpc = rpcOriginal
    }
  })

  await pararAmbienteDeTeste()
})

// Prova adicional pedida explicitamente pra fechar a PR#128: os testes acima já
// provam ausência de duplicação/órfão, mas só com 1 vendedora no rodízio (o
// caso trivial em que não há disputa de "pra quem vai o próximo lead"). Este
// bloco usa 3 vendedoras sintéticas (mesma cardinalidade real de Ana/Taís/
// Nicole — ver docs sobre o rodízio) pra provar que, mesmo com múltiplas
// candidatas elegíveis disputando o mesmo lock de rodízio (distribuicao_leads
// id=1) sob concorrência real, o resultado continua sendo exatamente 1 lead
// e 1 responsável por contato — nunca 2 leads pro mesmo telefone, nunca 2
// vendedoras "donas" do mesmo lead, nunca um responsavel_id perdido apesar de
// vendedoras ativas existirem. Cobre também o lado "nenhuma notificação/
// tarefa duplicada": confirmado por leitura de código (webhook-handler.js)
// que este fluxo não cria linha em `tarefas` nem em `notifications` — a prova
// aqui é negativa e explícita (zero linhas), não a ausência de um teste.
test('rateio entre vendedoras: 3 vendedoras sintéticas, corrida concorrente nunca duplica lead/responsável nem gera tarefa/notificação', async (t) => {
  await iniciarAmbienteDeTeste()
  const { supabase } = await import('../../../src/lib/supabase-admin.server.js')
  const { processWhatsappEvent } = await import('../../../src/routes/webhook-handler.js')

  await t.test('1. rajada concorrente de contatos DISTINTOS com 3 vendedoras elegíveis: 1 lead por telefone, sempre com responsável, rodízio realmente gira (não trava numa só)', async () => {
    await Promise.all([
      criarVendedorDeTeste(supabase, { nome: 'Vendedora Race Ana' }),
      criarVendedorDeTeste(supabase, { nome: 'Vendedora Race Tais' }),
      criarVendedorDeTeste(supabase, { nome: 'Vendedora Race Nicole' }),
    ])

    const N = 9
    const telefones = Array.from({ length: N }, () => telefoneDeTeste())
    await Promise.all(
      telefones.map((telefoneJid, i) =>
        processWhatsappEvent(eventoWhatsapp({ telefoneJid, msgId: `rateio-3vend-${telefoneJid}-${i}`, texto: `contato ${i}` }))
      )
    )

    const semPrefixos = telefones.map((tel) => tel.replace(/^55/, ''))
    const { data: leadsCriados } = await supabase.from('leads').select('id, telefone, responsavel_id').in('telefone', semPrefixos)

    assert.equal(leadsCriados.length, N, `esperava exatamente 1 lead por telefone (${N} contatos distintos), achou ${leadsCriados.length} — duplicação sob concorrência`)
    const telefonesVistos = new Set(leadsCriados.map((l) => l.telefone))
    assert.equal(telefonesVistos.size, N, 'cada telefone só pode aparecer em exatamente 1 lead')
    for (const lead of leadsCriados) {
      assert.ok(lead.responsavel_id, `lead ${lead.id} não pode ficar órfão (responsavel_id NULL) havendo vendedoras ativas elegíveis`)
    }

    // Rodízio realmente girando sob concorrência: com 3+ vendedoras elegíveis
    // e 9 contatos concorrentes, uma trava/condição de corrida no avanço
    // circular (distribuicao_leads.id=1) se manifestaria como "todo mundo caiu
    // na mesma vendedora" — >=2 responsavel_id distintos já descarta esse bug
    // (não exigimos fairness exata de 3-a-3 porque o pool de vendedoras ativas
    // no banco de teste compartilhado pode ter sobra de outros arquivos da
    // suíte, rodados no mesmo processo Postgres — ver run-collection-tests.mjs).
    const responsaveisDistintos = new Set(leadsCriados.map((l) => l.responsavel_id))
    assert.ok(responsaveisDistintos.size >= 2, `rodízio deveria distribuir entre múltiplas vendedoras sob concorrência, mas todos os ${N} leads caíram em ${responsaveisDistintos.size} vendedora(s) só — indício de trava no avanço circular`)

    // Nenhum efeito colateral duplicado (nem sequer criado) em tabelas
    // dependentes de lead_id — escopado só aos leads deste teste.
    const leadIds = leadsCriados.map((l) => l.id)
    const { data: tarefasCriadas } = await supabase.from('tarefas').select('id').in('lead_id', leadIds)
    assert.equal(tarefasCriadas?.length ?? 0, 0, 'criação de lead via webhook não deveria gerar nenhuma tarefa automática (e muito menos duplicada) sob concorrência')

    const { data: notificacoesCriadas } = await supabase.from('notifications').select('id').in('conversation_id', leadIds)
    assert.equal(notificacoesCriadas?.length ?? 0, 0, 'criação de lead via webhook não deveria gerar nenhuma notificação automática (e muito menos duplicada) sob concorrência')
  })

  await t.test('2. rajada concorrente do MESMO telefone com 3 vendedoras elegíveis: continua 1 lead, 1 responsável só, zero tarefa/notificação', async () => {
    await Promise.all([
      criarVendedorDeTeste(supabase, { nome: 'Vendedora Race Ana 2' }),
      criarVendedorDeTeste(supabase, { nome: 'Vendedora Race Tais 2' }),
      criarVendedorDeTeste(supabase, { nome: 'Vendedora Race Nicole 2' }),
    ])

    const telefoneJid = telefoneDeTeste()
    const N = 6
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        processWhatsappEvent(eventoWhatsapp({ telefoneJid, msgId: `rateio-3vend-mesmo-tel-${telefoneJid}-${i}`, texto: `msg ${i}` }))
      )
    )

    const semPrefixo = telefoneJid.replace(/^55/, '')
    const { data: leadsCriados } = await supabase.from('leads').select('id, responsavel_id').eq('telefone', semPrefixo)
    assert.equal(leadsCriados.length, 1, `esperava exatamente 1 lead mesmo com 3 vendedoras elegíveis disputando e ${N} eventos concorrentes do mesmo telefone, achou ${leadsCriados.length}`)
    assert.ok(leadsCriados[0].responsavel_id, 'lead não pode ficar órfão havendo vendedoras ativas elegíveis')

    const { data: tarefasCriadas } = await supabase.from('tarefas').select('id').eq('lead_id', leadsCriados[0].id)
    assert.equal(tarefasCriadas?.length ?? 0, 0, 'nenhuma tarefa (única ou duplicada) deveria ter sido criada por este fluxo')

    const { data: notificacoesCriadas } = await supabase.from('notifications').select('id').eq('conversation_id', leadsCriados[0].id)
    assert.equal(notificacoesCriadas?.length ?? 0, 0, 'nenhuma notificação (única ou duplicada) deveria ter sido criada por este fluxo')
  })

  await pararAmbienteDeTeste()
})
