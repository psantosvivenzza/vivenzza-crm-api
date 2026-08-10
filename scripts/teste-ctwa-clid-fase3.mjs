// Testes de integração dos 8 casos pedidos na Fase 3 (2026-08-10) pra
// validar o fix de ctwa_clid ANTES de qualquer release. Chama
// processWhatsappEvent() diretamente (exportado de webhook-handler.js) com
// payloads sintéticos no formato real da Evolution API — não é HTTP, é
// chamada direta da função que o endpoint real usa por baixo. Dados
// sintéticos (TESTE APAGAR), limpos ao final. Roda com
// `railway run --service vivenzza-crm-api node scripts/teste-ctwa-clid-fase3.mjs`.
import { supabase } from '../src/lib/supabase-admin.server.js'
import { processWhatsappEvent } from '../src/routes/webhook-handler.js'

let falhas = 0
function check(nome, cond, detalhe) {
  if (cond) console.log(`OK — ${nome}`)
  else { falhas++; console.log(`FALHOU — ${nome}${detalhe ? ' — ' + JSON.stringify(detalhe) : ''}`) }
}

const criados = { leads: [] }
let contadorTel = 900001

function proximoTelefone() { return `5599999${contadorTel++}` }

function payloadTexto(telefone, texto = 'Oi, quero saber mais') {
  return {
    event: 'messages.upsert',
    data: {
      key: { fromMe: false, remoteJid: `${telefone}@s.whatsapp.net`, id: `MSG_${Date.now()}_${Math.random()}` },
      message: { conversation: texto },
    },
  }
}

function payloadComReferral(telefone, { ctwa_clid, headline } = {}) {
  return {
    event: 'messages.upsert',
    data: {
      key: { fromMe: false, remoteJid: `${telefone}@s.whatsapp.net`, id: `MSG_${Date.now()}_${Math.random()}` },
      message: { conversation: 'Oi, vim pelo anúncio' },
      referral: { ctwa_clid, headline, source_id: '120236605624690378' },
    },
  }
}

async function buscarLead(telefone) {
  const semPrefixo = telefone.replace(/^55/, '')
  const { data } = await supabase.from('leads').select('*').eq('telefone', semPrefixo).maybeSingle()
  return data
}

async function main() {
  // ─── CASO 1: Lead novo + ctwa_clid presente ─────────────────────────────
  {
    const tel = proximoTelefone()
    await processWhatsappEvent(payloadComReferral(tel, { ctwa_clid: 'CLID_CASO1', headline: 'B2B Regiões' }))
    const lead = await buscarLead(tel)
    if (lead) criados.leads.push(lead.id)
    check('CASO 1 — lead novo criado', !!lead)
    check('CASO 1 — ctwa_clid capturado na criação', lead?.ctwa_clid === 'CLID_CASO1')
    check('CASO 1 — campanha_origem específica (b2b_regioes)', lead?.campanha_origem === 'b2b_regioes')
  }

  // ─── CASO 2: Lead novo + ctwa_clid ausente ──────────────────────────────
  {
    const tel = proximoTelefone()
    await processWhatsappEvent(payloadTexto(tel))
    const lead = await buscarLead(tel)
    if (lead) criados.leads.push(lead.id)
    check('CASO 2 — lead novo criado', !!lead)
    check('CASO 2 — ctwa_clid null (ausente no payload)', lead?.ctwa_clid === null || lead?.ctwa_clid === undefined)
    check('CASO 2 — campanha_origem cai no default genérico', lead?.campanha_origem === 'whatsapp_organico')
  }

  // ─── CASO 3: Lead existente SEM ctwa_clid + novo webhook COM ctwa_clid ──
  {
    const tel = proximoTelefone()
    const { data: leadBase } = await supabase.from('leads').insert({
      nome: 'TESTE APAGAR - Caso 3', telefone: tel.replace(/^55/, ''), etapa: 'novo',
      origem: 'whatsapp', campanha_origem: 'whatsapp_organico', ctwa_clid: null,
    }).select().single()
    criados.leads.push(leadBase.id)

    await processWhatsappEvent(payloadComReferral(tel, { ctwa_clid: 'CLID_CASO3', headline: 'Lista Brasil' }))
    const lead = await buscarLead(tel)
    check('CASO 3 — ctwa_clid preenchido retroativamente', lead?.ctwa_clid === 'CLID_CASO3')
    check('CASO 3 — campanha_origem atualizada (estava no default genérico)', lead?.campanha_origem === 'lista_brasil')
  }

  // ─── CASO 4: Lead existente COM ctwa_clid + webhook "duplicado" (clid diferente) ──
  {
    const tel = proximoTelefone()
    const { data: leadBase } = await supabase.from('leads').insert({
      nome: 'TESTE APAGAR - Caso 4', telefone: tel.replace(/^55/, ''), etapa: 'novo',
      origem: 'whatsapp', campanha_origem: 'b2b_regioes', ctwa_clid: 'CLID_ORIGINAL',
    }).select().single()
    criados.leads.push(leadBase.id)

    await processWhatsappEvent(payloadComReferral(tel, { ctwa_clid: 'CLID_NOVO_NAO_DEVERIA_ENTRAR', headline: 'Lista Brasil' }))
    const lead = await buscarLead(tel)
    check('CASO 4 — ctwa_clid original preservado (nunca sobrescrito)', lead?.ctwa_clid === 'CLID_ORIGINAL')
    check('CASO 4 — campanha_origem original preservada', lead?.campanha_origem === 'b2b_regioes')
  }

  // ─── CASO 5: Lead existente com campanha ESPECÍFICA + webhook com origem GENÉRICA ──
  {
    const tel = proximoTelefone()
    const { data: leadBase } = await supabase.from('leads').insert({
      nome: 'TESTE APAGAR - Caso 5', telefone: tel.replace(/^55/, ''), etapa: 'novo',
      origem: 'whatsapp', campanha_origem: 'meta_b2b_landing_distribuidores', ctwa_clid: null,
    }).select().single()
    criados.leads.push(leadBase.id)

    // headline que NÃO bate com nenhum padrão específico (b2b/regiao/lista/brasil/cidadesrs)
    // -> detectarCampanhaOrigem cai no título bruto ("Promoção Especial"), que é genérico.
    await processWhatsappEvent(payloadComReferral(tel, { ctwa_clid: 'CLID_CASO5', headline: 'Promoção Especial' }))
    const lead = await buscarLead(tel)
    check('CASO 5 — ctwa_clid é preenchido mesmo assim (não depende de campanha_origem)', lead?.ctwa_clid === 'CLID_CASO5')
    check('CASO 5 — campanha_origem ESPECÍFICA original NÃO é sobrescrita por valor genérico', lead?.campanha_origem === 'meta_b2b_landing_distribuidores')
  }

  // ─── CASO 6: Payload malformado ──────────────────────────────────────────
  {
    let erro1 = null, erro2 = null, erro3 = null
    try { await processWhatsappEvent({ event: 'messages.upsert', data: null }) } catch (e) { erro1 = e }
    try { await processWhatsappEvent({ event: 'messages.upsert', data: {} }) } catch (e) { erro2 = e }
    try { await processWhatsappEvent({}) } catch (e) { erro3 = e }
    check('CASO 6 — payload com data:null não derruba o processo', erro1 === null, erro1?.message)
    check('CASO 6 — payload com data:{} (sem key/message) não derruba o processo', erro2 === null, erro2?.message)
    check('CASO 6 — payload totalmente vazio não derruba o processo', erro3 === null, erro3?.message)
  }

  // ─── CASO 7: Webhook duplicado/retry (mesmo payload 2x) ──────────────────
  {
    const tel = proximoTelefone()
    const payload = payloadComReferral(tel, { ctwa_clid: 'CLID_CASO7', headline: 'B2B Regiões' })
    await processWhatsappEvent(payload)
    await processWhatsappEvent(payload) // reentrega do MESMO evento

    const { data: leadsEncontrados } = await supabase.from('leads').select('id').eq('telefone', tel.replace(/^55/, ''))
    if (leadsEncontrados?.[0]) criados.leads.push(leadsEncontrados[0].id)
    check('CASO 7 — retry do mesmo evento NÃO cria lead duplicado', leadsEncontrados?.length === 1, leadsEncontrados?.length)

    const { data: msgs } = await supabase.from('whatsapp_mensagens').select('id').eq('evolution_id', payload.data.key.id)
    check('CASO 7 — retry do mesmo evento NÃO duplica a mensagem (upsert por evolution_id)', msgs?.length === 1, msgs?.length)
  }

  // ─── CASO 8: ctwa_clid presente mas campanha NÃO resolvida (fallback) ────
  {
    const tel = proximoTelefone()
    // headline vazio E body vazio E source_id que não bate com nenhum padrão -> cai no fallback 'meta_ads'
    await processWhatsappEvent({
      event: 'messages.upsert',
      data: {
        key: { fromMe: false, remoteJid: `${tel}@s.whatsapp.net`, id: `MSG_${Date.now()}_${Math.random()}` },
        message: { conversation: 'oi' },
        referral: { ctwa_clid: 'CLID_CASO8', headline: '', body: '', source_id: '999999999' },
      },
    })
    const lead = await buscarLead(tel)
    if (lead) criados.leads.push(lead.id)
    check('CASO 8 — ctwa_clid capturado mesmo sem campanha reconhecida', lead?.ctwa_clid === 'CLID_CASO8')
    check('CASO 8 — campanha_origem cai no fallback "meta_ads" (não crasha, não fica vazia)', lead?.campanha_origem === 'meta_ads', lead?.campanha_origem)
  }
}

main()
  .then(async () => {
    for (const id of criados.leads) { try { await supabase.from('whatsapp_mensagens').delete().eq('lead_id', id) } catch {} }
    for (const id of criados.leads) { try { await supabase.from('leads').delete().eq('id', id) } catch {} }
    console.log('\nLimpeza concluída —', criados.leads.length, 'leads sintéticos removidos.')
    console.log(`\n${falhas === 0 ? 'TODOS OS TESTES PASSARAM' : `${falhas} TESTE(S) FALHARAM`}`)
    process.exit(falhas === 0 ? 0 : 1)
  })
  .catch(async err => {
    for (const id of criados.leads) { try { await supabase.from('whatsapp_mensagens').delete().eq('lead_id', id) } catch {} }
    for (const id of criados.leads) { try { await supabase.from('leads').delete().eq('id', id) } catch {} }
    console.error('ERRO FATAL NO TESTE:', err)
    process.exit(1)
  })
