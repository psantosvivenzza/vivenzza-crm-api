// 2026-08-17 — bug real corrigido: WhatsApp Financeiro (cobrança/atendimento)
// misturava com o CRM Comercial/Vendas — 16 mensagens confirmadas por
// conteúdo em produção dentro de leads comerciais reais, com vendedor
// atribuído. Contra Postgres local de verdade (leads/whatsapp_mensagens
// agora existem no baseline — ver schema-baseline/004_crm_whatsapp.sql).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste, limparInstanciasDeTeste } from './_setup.mjs'

let supabase, processWhatsappEvent, ehInstanciaFinanceira, _resetCacheInstanciasFinanceirasParaTeste

// Isolamento — achado real rodando a suíte completa: whatsapp_instances tem
// um índice único parcial (só 1 role='principal' com enabled=true por vez,
// migration 20260101000029) que arquivos de teste ANTERIORES na mesma
// suíte podem deixar ocupado, fazendo o INSERT deste arquivo falhar em
// silêncio (o helper original não checava o erro) — o teste então rodava
// como se nenhuma instância financeira estivesse cadastrada. Corrigido: (1)
// limpa ANTES de começar (limparInstanciasDeTeste, já existente,
// reaproveitado — não inventa outro helper), (2) limpa tudo que este
// arquivo cria no final, pra não quebrar o próximo arquivo da suíte
// (whatsapp-global-rate-limit.test.mjs foi exatamente o afetado antes desta
// correção).
const idsLeadsCriados = []
const idsUsuariosCriados = []
const evolutionIdsCriados = []

before(async () => {
  await iniciarAmbienteDeTeste()
  ;({ supabase } = await import('../../../src/lib/supabase-admin.server.js'))
  ;({ processWhatsappEvent } = await import('../../../src/routes/webhook-handler.js'))
  ;({ ehInstanciaFinanceira, _resetCacheInstanciasFinanceirasParaTeste } = await import('../../../src/lib/collection/whatsappInstances.js'))
  await limparInstanciasDeTeste(supabase)
})
after(async () => {
  if (evolutionIdsCriados.length) await supabase.from('whatsapp_mensagens').delete().in('evolution_id', evolutionIdsCriados)
  if (idsLeadsCriados.length) await supabase.from('leads').delete().in('id', idsLeadsCriados)
  if (idsUsuariosCriados.length) await supabase.from('usuarios').delete().in('id', idsUsuariosCriados)
  await limparInstanciasDeTeste(supabase)
  await pararAmbienteDeTeste()
})

let contador = 0
function telefoneUnico() {
  contador++
  return `55519${String(Date.now()).slice(-7)}${String(contador).padStart(2, '0')}`
}

// upsert (não insert simples) — os dois blocos test() de nível superior
// deste arquivo cadastram as mesmas 2 instâncias; sem isso, o 2º bloco bate
// na constraint de unicidade de instance_name deixada pelo 1º.
async function cadastrarInstanciaFinanceira(nome, role = 'principal') {
  const { error } = await supabase.from('whatsapp_instances').upsert(
    { name: nome, instance_name: nome, priority: 1, role, enabled: true },
    { onConflict: 'instance_name' },
  )
  if (error) throw new Error(`cadastrarInstanciaFinanceira(${nome}) falhou: ${error.message}`)
  _resetCacheInstanciasFinanceirasParaTeste()
}

function eventoUpsert({ instance, telefone, texto, fromMe = false, evolutionId }) {
  return {
    event: 'messages.upsert',
    instance,
    data: {
      key: { remoteJid: `${telefone}@s.whatsapp.net`, fromMe, id: evolutionId },
      message: { conversation: texto },
    },
  }
}

test('ehInstanciaFinanceira: identifica instâncias financeiras cadastradas, fail-safe em qualquer outro caso', async (t) => {
  await t.test('4. instância financeira principal segregada (cadastrada em whatsapp_instances)', async () => {
    await cadastrarInstanciaFinanceira('vivenzza-financeiro', 'principal')
    assert.equal(await ehInstanciaFinanceira('vivenzza-financeiro'), true)
  })

  await t.test('5. instância financeira reserva segregada', async () => {
    await cadastrarInstanciaFinanceira('vivenzza-financeiro-reserva-01', 'reserva')
    assert.equal(await ehInstanciaFinanceira('vivenzza-financeiro-reserva-01'), true)
  })

  await t.test('nome desconhecido/comercial nunca é tratado como financeiro', async () => {
    assert.equal(await ehInstanciaFinanceira('vivenzza'), false)
    assert.equal(await ehInstanciaFinanceira('qualquer-outra-coisa'), false)
  })

  await t.test('fail-safe: nulo/vazio nunca é tratado como financeiro (segue caminho comercial de sempre)', async () => {
    assert.equal(await ehInstanciaFinanceira(null), false)
    assert.equal(await ehInstanciaFinanceira(undefined), false)
    assert.equal(await ehInstanciaFinanceira(''), false)
  })
})

test('processWhatsappEvent: separação real Financeiro x Comercial', async (t) => {
  await cadastrarInstanciaFinanceira('vivenzza-financeiro', 'principal')
  await cadastrarInstanciaFinanceira('vivenzza-financeiro-reserva-01', 'reserva')

  await t.test('1+8. inbound financeiro NÃO cria lead comercial', async () => {
    const telefone = telefoneUnico()
    const evolutionId = `fin-in-${telefone}`
    evolutionIdsCriados.push(evolutionId)
    await processWhatsappEvent(eventoUpsert({
      instance: 'vivenzza-financeiro', telefone, texto: 'Já paguei, segue comprovante', evolutionId,
    }))
    const { data: leads } = await supabase.from('leads').select('id').eq('telefone', telefone)
    assert.equal(leads.length, 0, 'nenhum lead deveria ser criado a partir de uma mensagem financeira')
  })

  await t.test('2. outbound financeiro (eco da cobrança enviada) NÃO aparece em vendas', async () => {
    const telefone = telefoneUnico()
    evolutionIdsCriados.push(`fin-out-${telefone}`)
    await processWhatsappEvent(eventoUpsert({
      instance: 'vivenzza-financeiro', telefone, texto: 'Olá! Aqui é Jeffeson, do Financeiro Vivenzza...', fromMe: true, evolutionId: `fin-out-${telefone}`,
    }))
    const { data: leads } = await supabase.from('leads').select('id').eq('telefone', telefone)
    assert.equal(leads.length, 0, 'eco de mensagem financeira enviada também não deveria criar lead')
    const { data: msgs } = await supabase.from('whatsapp_mensagens').select('lead_id, instance_name').eq('evolution_id', `fin-out-${telefone}`)
    assert.equal(msgs.length, 1)
    assert.equal(msgs[0].lead_id, null)
    assert.equal(msgs[0].instance_name, 'vivenzza-financeiro')
  })

  await t.test('3. resposta ao financeiro continua financeira (instance_name gravado, lead_id nulo)', async () => {
    const telefone = telefoneUnico()
    evolutionIdsCriados.push(`fin-resp-${telefone}`)
    await processWhatsappEvent(eventoUpsert({
      instance: 'vivenzza-financeiro-reserva-01', telefone, texto: 'Pode confirmar o valor?', evolutionId: `fin-resp-${telefone}`,
    }))
    const { data: msgs } = await supabase.from('whatsapp_mensagens').select('lead_id, instance_name, mensagem').eq('evolution_id', `fin-resp-${telefone}`)
    assert.equal(msgs.length, 1)
    assert.equal(msgs[0].lead_id, null)
    assert.equal(msgs[0].instance_name, 'vivenzza-financeiro-reserva-01')
    assert.equal(msgs[0].mensagem, 'Pode confirmar o valor?')
  })

  await t.test('6. comercial continua normal — instância desconhecida/ausente cria lead exatamente como antes', async () => {
    const telefone = telefoneUnico()
    evolutionIdsCriados.push(`com-${telefone}`)
    await processWhatsappEvent(eventoUpsert({
      instance: 'vivenzza', telefone, texto: 'Oi, quero saber sobre os produtos', evolutionId: `com-${telefone}`,
    }))
    const { data: leads } = await supabase.from('leads').select('id, telefone, origem').eq('telefone', telefone.replace(/^55/, ''))
    assert.equal(leads.length, 1, 'mensagem de instância comercial deveria criar lead normalmente (comportamento preservado)')
    if (leads[0]) idsLeadsCriados.push(leads[0].id)
    assert.equal(leads[0].origem, 'whatsapp')
    const { data: msgs } = await supabase.from('whatsapp_mensagens').select('lead_id, instance_name').eq('evolution_id', `com-${telefone}`)
    assert.equal(msgs[0].lead_id, leads[0].id)
    assert.equal(msgs[0].instance_name, 'vivenzza')
  })

  await t.test('7+9+10+11. mesmo cliente com lead comercial existente: mensagem financeira NÃO se anexa ao lead, NÃO muda etapa, NÃO troca vendedor', async () => {
    const telefone = telefoneUnico()
    const semPrefixo = telefone.replace(/^55/, '')
    const { data: vendedor } = await supabase.from('usuarios').insert({ nome: 'Vendedora Teste', email: `vendedora-${Date.now()}@teste.com`, role: 'vendedor' }).select().single()
    idsUsuariosCriados.push(vendedor.id)
    const { data: leadExistente } = await supabase.from('leads').insert({
      nome: 'Cliente Existente', telefone: semPrefixo, etapa: 'negociacao', origem: 'whatsapp', responsavel_id: vendedor.id,
    }).select().single()
    idsLeadsCriados.push(leadExistente.id)
    evolutionIdsCriados.push(`fin-existente-${telefone}`, `com-existente-${telefone}`)

    // Cliente responde no Financeiro — mesmo telefone do lead comercial já existente
    await processWhatsappEvent(eventoUpsert({
      instance: 'vivenzza-financeiro', telefone, texto: 'Vou pagar amanhã', evolutionId: `fin-existente-${telefone}`,
    }))

    const { data: leadDepois } = await supabase.from('leads').select('etapa, responsavel_id').eq('id', leadExistente.id).single()
    assert.equal(leadDepois.etapa, 'negociacao', 'etapa do pipeline não pode mudar por causa de mensagem financeira')
    assert.equal(leadDepois.responsavel_id, vendedor.id, 'vendedor responsável não pode ser trocado por mensagem financeira')

    const { data: msgFinanceira } = await supabase.from('whatsapp_mensagens').select('lead_id').eq('evolution_id', `fin-existente-${telefone}`)
    assert.equal(msgFinanceira[0].lead_id, null, 'mensagem financeira NUNCA deveria ser anexada ao lead_id do lead comercial, mesmo que o telefone bata')

    // Confirma que uma mensagem COMERCIAL pro mesmo telefone continua se anexando normalmente
    await processWhatsappEvent(eventoUpsert({
      instance: 'vivenzza', telefone, texto: 'Quero fechar o pedido', evolutionId: `com-existente-${telefone}`,
    }))
    const { data: msgComercial } = await supabase.from('whatsapp_mensagens').select('lead_id').eq('evolution_id', `com-existente-${telefone}`)
    assert.equal(msgComercial[0].lead_id, leadExistente.id, 'mensagem comercial pro mesmo cliente continua indo pro lead certo — threads separadas, não cliente duplicado')
  })

  await t.test('12. histórico antigo preservado — mensagem anterior (sem instance_name, formato legado) não é tocada', async () => {
    const evolutionIdAntigo = `legado-${Date.now()}`
    evolutionIdsCriados.push(evolutionIdAntigo)
    await supabase.from('whatsapp_mensagens').insert({ mensagem: 'mensagem antiga do legado', direcao: 'entrada', telefone: '5551900000000', status: 'recebido', evolution_id: evolutionIdAntigo })

    const telefone = telefoneUnico()
    evolutionIdsCriados.push(`nova-${telefone}`)
    await processWhatsappEvent(eventoUpsert({ instance: 'vivenzza-financeiro', telefone, texto: 'nova mensagem', evolutionId: `nova-${telefone}` }))

    const { data: antiga } = await supabase.from('whatsapp_mensagens').select('mensagem, instance_name').eq('evolution_id', evolutionIdAntigo).single()
    assert.equal(antiga.mensagem, 'mensagem antiga do legado', 'mensagem original não pode ser alterada')
    assert.equal(antiga.instance_name, null, 'mensagem legada fica NULL — nunca adivinhamos retroativamente')
  })

  await t.test('13. webhook duplicado (mesmo evolution_id 2x) continua idempotente, inclusive pra mensagem financeira', async () => {
    const telefone = telefoneUnico()
    const evolutionId = `dup-${telefone}`
    evolutionIdsCriados.push(evolutionId)
    await processWhatsappEvent(eventoUpsert({ instance: 'vivenzza-financeiro', telefone, texto: 'teste duplicado', evolutionId }))
    await processWhatsappEvent(eventoUpsert({ instance: 'vivenzza-financeiro', telefone, texto: 'teste duplicado', evolutionId }))
    const { data: msgs } = await supabase.from('whatsapp_mensagens').select('id').eq('evolution_id', evolutionId)
    assert.equal(msgs.length, 1, 'evento duplicado não pode criar uma segunda linha')
  })

  await t.test('14. multi-instância (motor de envio outbound) intocado — ehInstanciaFinanceira não interfere em listarInstancias/seleção', async () => {
    const { listarInstancias } = await import('../../../src/lib/collection/whatsappInstances.js')
    const instancias = await listarInstancias()
    assert.ok(Array.isArray(instancias))
    assert.ok(instancias.some((i) => i.instance_name === 'vivenzza-financeiro'))
  })

  await t.test('prova estática — a inserção em whatsapp_mensagens nunca grava lead_id quando ehFinanceiro (por construção do código, não só por dado de teste)', async () => {
    const fs = await import('fs')
    const conteudo = fs.readFileSync(new URL('../../../src/routes/webhook-handler.js', import.meta.url), 'utf8')
    assert.match(conteudo, /lead_id:\s*ehFinanceiro\s*\?\s*null/, 'a linha de upsert deveria forçar lead_id null explicitamente quando ehFinanceiro')
  })
})
