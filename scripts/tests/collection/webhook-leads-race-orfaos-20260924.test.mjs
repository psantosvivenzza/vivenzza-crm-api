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
