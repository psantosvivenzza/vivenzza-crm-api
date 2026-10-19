import { supabase } from '../supabase-admin.server.js'
import { candidatosTelefone, telefonesEquivalentes } from '../telefone.js'
import { checked, FRETE_INSTANCE } from './worker.js'
import { decidirRespostaFrete, interpretarPerguntaFrete, decidirInteracaoAutomaticaFrete, pedidoHumanoExplicitoFrete } from './assistant.js'

export async function handleFreteInbound({ instanceName, telefone, texto, evolutionId, fromMe, mediaTipo }, { db = supabase, installed = process.env.FRETE_MODULO_INSTALADO === 'true', assistantEnabled = process.env.FRETE_IA_ATIVA === 'true', interpret = interpretarPerguntaFrete } = {}) {
  if (!installed || instanceName !== FRETE_INSTANCE) return false
  if (typeof telefone !== 'string' || !telefone) return false
  const candidatos = candidatosTelefone(telefone)
  const suppliers = await checked(db.from('fornecedores').select('id,telefone_cotacao_frete,participa_cotacao_frete,cotacao_frete_consentimento').eq('participa_cotacao_frete', true).in('telefone_cotacao_frete', candidatos))
  const supplierMatches = (suppliers ?? []).filter(s => telefonesEquivalentes(s.telefone_cotacao_frete, telefone))
  let matches = []
  try {
  const consultas = await checked(db.from('frete_consultas').select('*').eq('instance_name', FRETE_INSTANCE).in('status', ['fila', 'enviando', 'aguardando', 'recebida', 'revisao', 'falha']).in('telefone', candidatos))
  matches = (consultas ?? []).filter(c => telefonesEquivalentes(c.telefone, telefone))
  // Opt-out explícito é respeitado mesmo depois de encerrar a cotação.
  if (!fromMe && decidirRespostaFrete(texto).tipo === 'opt_out') {
    for (const supplier of supplierMatches) await checked(db.from('fornecedores').update({ cotacao_frete_consentimento: false, cotacao_frete_atualizada_por:'opt_out_inbound' }).eq('id', supplier.id))
    for (const c of matches) await checked(db.from('frete_consultas').update({ ia_pausada: true }).eq('id', c.id))
    if (!matches.length) return supplierMatches.length ? { semCotacao: true } : false
  }
  // Sem solicitação aberta, manter a mensagem no histórico financeiro genérico,
  // sem marcar resposta a cobrança nem acionar assistente de frete.
  if (!matches.length) return supplierMatches.length ? { semCotacao: true } : false
  if (!evolutionId) { // No stable event identity: retain human review without automatic replies.
    for (const c of matches) {
      await checked(db.from('frete_consultas').update({ ia_pausada: true }).eq('id', c.id).neq('status', 'encerrada'))
      await checked(db.from('frete_consultas').update({ status: 'revisao' }).eq('id', c.id).eq('completa', false).neq('status', 'encerrada'))
    }
    return { semCotacao: true }
  }
  const pause = async () => {
    for (const c of matches) {
      await checked(db.from('frete_consultas').update({ ia_pausada: true }).eq('id', c.id).neq('status', 'encerrada'))
      await checked(db.from('frete_consultas').update({ status: 'revisao' }).eq('id', c.id).eq('completa', false).neq('status', 'encerrada'))
    }
  }
  const old = await checked(db.from('frete_mensagens').select('id').eq('evolution_id', evolutionId).limit(1))
  if (old?.length) {
    const respostas=await checked(db.from('frete_envios').select('id').eq('mensagem_id',old[0].id).limit(1))
    let eco=false
    if(fromMe){const enviados=await checked(db.from('frete_envios').select('provider_id,texto').in('consulta_id',matches.map(c=>c.id)).limit(100));const normalizar=v=>String(v||'').replace(/\s+/gu,' ').trim();eco=enviados?.some(e=>e.provider_id===evolutionId||normalizar(e.texto)===normalizar(texto))}
    const avisoAutomatico=!fromMe&&!mediaTipo&&decidirInteracaoAutomaticaFrete(texto)?.tipo==='aguardar'
    if(!respostas?.length&&!eco&&!avisoAutomatico)await pause()
    return true
  }
  if (matches.length > 1) {
    const referenced = matches.filter(c => String(texto || '').toLowerCase().includes(c.cotacao_id.toLowerCase()))
    if (referenced.length === 1) matches = referenced
  }
  const single = matches.length === 1 ? matches[0] : null
  let inserted = false, mensagemId = null
  for (const c of matches) {
    const insert = await db.from('frete_mensagens').insert({ cotacao_id: c.cotacao_id, consulta_id: c.id, direcao: fromMe ? 'saida' : 'entrada', texto: String(texto || (mediaTipo ? `[Mídia: ${mediaTipo}]` : '')).slice(0, 10000), evolution_id: single ? evolutionId : `${evolutionId}:${c.id}` }).select('id').single()
    if (insert.error && insert.error.code !== '23505') throw insert.error
    if (!insert.error) { inserted = true; mensagemId = insert.data.id }
  }
  if (!inserted) return true
  if (fromMe) {
    if (single) {
      const known = await checked(db.from('frete_envios').select('id,texto,provider_id').eq('consulta_id', single.id).limit(20))
      const normalizar = v => String(v || '').replace(/\s+/gu, ' ').trim()
      if (!known?.some(e => e.provider_id === evolutionId || normalizar(e.texto) === normalizar(texto))) await pause()
    } else await pause()
    return true
  }
  const decision = decidirRespostaFrete(texto)
  if (decision.tipo === 'opt_out') {
    for (const s of supplierMatches) await checked(db.from('fornecedores').update({ cotacao_frete_consentimento: false, cotacao_frete_atualizada_por:'opt_out_inbound' }).eq('id', s.id))
    await pause(); return true
  }
  if (!single || mediaTipo || pedidoHumanoExplicitoFrete(texto)) { await pause(); return true }
  if (single.ia_pausada || single.completa || !assistantEnabled) return true
  const cotacao = await checked(db.from('frete_cotacoes').select('*').eq('id', single.cotacao_id).single())
  if (cotacao.status !== 'aberta') return true
  const resposta = await interpret(texto, cotacao.dados)
  if(resposta.tipo==='aguardar')return true
  if (resposta.tipo === 'opt_out') {
    for (const s of supplierMatches) await checked(db.from('fornecedores').update({ cotacao_frete_consentimento: false, cotacao_frete_atualizada_por:'opt_out_inbound' }).eq('id', s.id))
  }
  if (resposta.tipo !== 'resposta') { await pause(); return true }
  // IDs diferentes não autorizam loop bot-bot com a mesma pergunta/resposta.
  const automatic=decidirInteracaoAutomaticaFrete(texto,cotacao.dados)
  if(automatic?.tipo==='resposta'){
    const replies=await checked(db.from('frete_envios').select('mensagem_id,texto').eq('consulta_id',single.id).order('created_at',{ascending:false}).limit(100))
    const history=await checked(db.from('frete_mensagens').select('id,texto').eq('consulta_id',single.id).order('created_at',{ascending:false}).limit(100))
    const normalized=v=>String(v||'').replace(/\s+/gu,' ').trim()
    if((replies??[]).some(e=>e.mensagem_id&&normalized(e.texto)===normalized(resposta.texto)&&(history??[]).some(m=>m.id===e.mensagem_id&&normalized(m.texto)===normalized(texto)))){await pause();return true}
  }
  await checked(db.rpc('frete_enfileirar_resposta', { p_consulta_id: single.id, p_mensagem_id: mensagemId, p_texto: resposta.texto }))
  return true
  } catch (error) {
    error.freteTransportadora = supplierMatches.length > 0 || matches.length > 0
    throw error
  }
}
