import { supabase } from '../supabase-admin.server.js'
import { candidatosTelefone, telefonesEquivalentes } from '../telefone.js'
import { checked, FRETE_INSTANCE } from './worker.js'
import { decidirRespostaFrete, interpretarPerguntaFrete, decidirInteracaoAutomaticaFrete, pedidoHumanoExplicitoFrete,guardFrete,parRepetidoFrete } from './assistant.js'
import { extrairPropostaTextualFrete } from './proposal.js'
import { validarProposta } from './domain.js'
import {extrairProgressoFrete,solicitarPendenciasFrete,confirmouTaxasFrete} from './progress.js'
import {preservarAnexoFrete,preservarAnexoPendenteFrete} from './attachments.js'
import {completarLocalFormularioFrete} from './form.js'

async function capturarPropostaTextual(db,consulta,texto){
 if(consulta.ia_pausada&&!String(consulta.atualizado_por||'').startsWith('assistente_frete_'))return false
 const proposta=extrairPropostaTextualFrete(texto)
 if(!proposta)return false
 const actor=consulta.atualizado_por
 for(let attempt=0;attempt<2;attempt++){
  try{
   if(attempt)consulta=await checked(db.from('frete_consultas').select('*').eq('id',consulta.id).single())
   if(consulta.completa||consulta.valor_total!=null||consulta.protocolo||!consulta.updated_at||consulta.status==='encerrada'||consulta.atualizado_por!==actor)return false
   const cotacao=await checked(db.from('frete_cotacoes').select('status').eq('id',consulta.cotacao_id).single())
   if(cotacao.status!=='aberta')return false
   const campos=validarProposta({valor_total:proposta.valor_total,prazo_dias:consulta.prazo_dias,validade:consulta.validade,protocolo:proposta.protocolo||'',observacoes:'',completa:false,ia_pausada:true})
   campos.observacoes=consulta.observacoes
   campos.validade=consulta.validade
   campos.versao=consulta.updated_at
   await checked(db.rpc('frete_salvar_proposta',{p_cotacao_id:consulta.cotacao_id,p_consulta_id:consulta.id,p_campos:campos,p_actor:'assistente_frete_proposta_textual'}))
   return true
  }catch{
   if(attempt){
    console.error('[fretes] proposta textual pendente: conferir histórico; gravação não confirmada')
    await checked(db.from('frete_consultas').update({ia_pausada:true,status:'revisao'}).eq('id',consulta.id).eq('completa',false).neq('status','encerrada'))
    return true
   }
  }
 }
}

export async function handleFreteInbound({ instanceName, telefone, texto, evolutionId, fromMe, mediaTipo,mediaMessage,referencedEvolutionId }, { db = supabase, installed = process.env.FRETE_MODULO_INSTALADO === 'true', assistantEnabled = process.env.FRETE_IA_ATIVA === 'true', interpret = interpretarPerguntaFrete,attachment=preservarAnexoFrete,pendingAttachment=preservarAnexoPendenteFrete } = {}) {
  if (!installed || instanceName !== FRETE_INSTANCE) return false
  if (typeof telefone !== 'string' || !telefone) return false
  const candidatos = candidatosTelefone(telefone)
  const suppliers = await checked(db.from('fornecedores').select('id,telefone_cotacao_frete,participa_cotacao_frete,cotacao_frete_consentimento').eq('participa_cotacao_frete', true).in('telefone_cotacao_frete', candidatos))
  const supplierMatches = (suppliers ?? []).filter(s => telefonesEquivalentes(s.telefone_cotacao_frete, telefone))
  let matches = []
  try {
  const consultas = await checked(db.from('frete_consultas').select('*').eq('instance_name', FRETE_INSTANCE).in('status', ['fila', 'enviando', 'aguardando', 'recebida', 'revisao', 'falha']).in('telefone', candidatos))
  matches = (consultas ?? []).filter(c => telefonesEquivalentes(c.telefone, telefone) && !c.aguarda_contato && !c.contato_liberado)
  // Opt-out explícito é respeitado mesmo depois de encerrar a cotação.
  if (!fromMe && decidirRespostaFrete(texto).tipo === 'opt_out') {
    for (const supplier of supplierMatches) await checked(db.from('fornecedores').update({ cotacao_frete_consentimento: false, cotacao_frete_atualizada_por:'opt_out_inbound' }).eq('id', supplier.id))
    for (const c of matches) await checked(db.from('frete_consultas').update({ ia_pausada: true }).eq('id', c.id))
    if (!matches.length) return supplierMatches.length ? { semCotacao: true } : false
  }
  // Sem solicitação aberta, manter a mensagem no histórico financeiro genérico,
  // sem marcar resposta a cobrança nem acionar assistente de frete.
  if (!matches.length) {
    if(!fromMe&&evolutionId&&(consultas??[]).some(c=>telefonesEquivalentes(c.telefone,telefone)&&(c.aguarda_contato||c.contato_liberado))){
      const oldEvent=await checked(db.from('frete_mensagens').select('id').eq('evolution_id',evolutionId).limit(1))
      if(oldEvent?.length)return true
      const saved=await db.from('frete_respostas_pendentes').insert({instance_name:instanceName,telefone,texto:String(texto||(mediaTipo?`[Mídia: ${mediaTipo}]`:'')).slice(0,10000),evolution_id:evolutionId,...(mediaTipo?{anexo_status:mediaMessage?'processando':'revisao'}:{})}).select('id').single()
      if(saved.error&&saved.error.code!=='23505')throw saved.error
      if(!saved.error&&mediaTipo&&mediaMessage)await pendingAttachment(db,saved.data.id,mediaMessage)
      return true
    }
    return supplierMatches.length ? { semCotacao: true } : false
  }
  if (!evolutionId) { // No stable event identity: retain human review without automatic replies.
    for (const c of matches) {
      await checked(db.from('frete_consultas').update({ ia_pausada: true }).eq('id', c.id).neq('status', 'encerrada'))
      await checked(db.from('frete_consultas').update({ status: 'revisao' }).eq('id', c.id).eq('completa', false).neq('status', 'encerrada'))
    }
    return { semCotacao: true }
  }
  const old = await checked(db.from('frete_mensagens').select('id,consulta_id').eq('evolution_id', evolutionId).limit(1))
  if(old?.[0]?.consulta_id&&!matches.some(c=>c.id===old[0].consulta_id))return true
  if(fromMe){
    const own=await checked(db.from('frete_envios').select('consulta_id').eq('provider_id',evolutionId).limit(1))
    if(own?.length&&!matches.some(c=>c.id===own[0].consulta_id))return true
  }
  // Contato reutilizado exige referência inequívoca: não importar preço tardio.
  if (!fromMe && matches.some(c => c.exige_referencia)) {
    const explicit=matches.filter(c=>String(texto||'').toLowerCase().includes(c.cotacao_id.toLowerCase()))
    const sends=referencedEvolutionId?await checked(db.from('frete_envios').select('consulta_id').eq('provider_id',referencedEvolutionId).in('consulta_id',matches.map(c=>c.id))):[]
    const replies=matches.filter(c=>sends?.some(s=>s.consulta_id===c.id))
    const referenced=explicit.length?explicit:replies
    if(referenced.length!==1||(explicit.length&&referencedEvolutionId&&!replies.some(c=>c.id===explicit[0].id))){
      const saved=await db.from('frete_respostas_pendentes').insert({instance_name:instanceName,telefone,texto:String(texto||(mediaTipo?`[Mídia: ${mediaTipo}]`:'')).slice(0,10000),evolution_id:evolutionId,...(mediaTipo?{anexo_status:mediaMessage?'processando':'revisao'}:{})}).select('id').single()
      if(saved.error&&saved.error.code!=='23505')throw saved.error
      for(const c of matches){
        await checked(db.from('frete_consultas').update({ia_pausada:true}).eq('id',c.id).eq('ia_pausada',false).neq('status','encerrada'))
        await checked(db.from('frete_consultas').update({status:'revisao'}).eq('id',c.id).eq('completa',false).neq('status','revisao').neq('status','encerrada'))
      }
      if(!saved.error&&mediaTipo&&mediaMessage)await pendingAttachment(db,saved.data.id,mediaMessage)
      return true
    }
    matches=referenced
  }
  const pause = async (actor) => {
    for (const c of matches) {
      await checked(db.from('frete_consultas').update({ ia_pausada: true,...(actor?{atualizado_por:actor}:{}) }).eq('id', c.id).neq('status', 'encerrada'))
      await checked(db.from('frete_consultas').update({ status: 'revisao' }).eq('id', c.id).eq('completa', false).neq('status', 'encerrada'))
    }
  }
  if (old?.length) {
    if(!fromMe&&!mediaTipo&&!pedidoHumanoExplicitoFrete(texto)&&assistantEnabled&&matches.length===1&&await capturarPropostaTextual(db,matches[0],texto))return true
    const respostas=await checked(db.from('frete_envios').select('id').eq('mensagem_id',old[0].id).limit(1))
    let eco=false
    if(fromMe){const enviados=await checked(db.from('frete_envios').select('provider_id,texto').in('consulta_id',matches.map(c=>c.id)).limit(100));const normalizar=v=>String(v||'').replace(/\s+/gu,' ').trim();eco=enviados?.some(e=>e.provider_id===evolutionId||normalizar(e.texto)===normalizar(texto))}
    const avisoAutomatico=!fromMe&&!mediaTipo&&decidirInteracaoAutomaticaFrete(texto)?.tipo==='aguardar'
    if(!respostas?.length&&!eco&&!avisoAutomatico)await pause(fromMe?'humano_whatsapp':undefined)
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
      const known = await checked(db.from('frete_envios').select('id,texto,provider_id').eq('consulta_id', single.id).order('created_at',{ascending:false}).limit(100))
      const normalizar = v => String(v || '').replace(/\s+/gu, ' ').trim()
      if (!known?.some(e => e.provider_id === evolutionId || normalizar(e.texto) === normalizar(texto))) await pause('humano_whatsapp')
    } else await pause('humano_whatsapp')
    return true
  }
  const decision = decidirRespostaFrete(texto)
  if (decision.tipo === 'opt_out') {
    for (const s of supplierMatches) await checked(db.from('fornecedores').update({ cotacao_frete_consentimento: false, cotacao_frete_atualizada_por:'opt_out_inbound' }).eq('id', s.id))
    await pause(); return true
  }
  if (!single || pedidoHumanoExplicitoFrete(texto)) { await pause(); return true }
  if(mediaTipo){
    if(!mediaMessage){await pause();return true}
    const extraido=await attachment(db,mensagemId,mediaMessage,{readEnabled:assistantEnabled&&!single.ia_pausada&&!single.completa})
    if(!assistantEnabled||single.ia_pausada||single.completa)return true
    if(!extraido){
      await checked(db.rpc('frete_enfileirar_resposta',{p_consulta_id:single.id,p_mensagem_id:mensagemId,p_texto:'Recebi o arquivo, mas não consegui ler os dados com segurança. Pode informar em texto o valor total do frete com todas as taxas, prazo em dias úteis e validade com data? Não estamos confirmando contratação ou coleta.'}));return true
    }
    // OCR é evidência auxiliar, nunca autoriza contratar ou marcar completa.
    texto=extraido
  }
  if(guardFrete(texto)==='revisao'&&!['resposta','aguardar'].includes(decidirInteracaoAutomaticaFrete(texto)?.tipo)){await pause();return true}
  if(!single.ia_pausada&&!single.completa&&assistantEnabled){
    const campos=extrairProgressoFrete(texto)
    let taxasPorContexto=false
    if(!mediaTipo&&/^(?:sim|sim,? todas as taxas inclusas|confirmo)[.!]?$/i.test(String(texto||'').trim())&&single.valor_total!=null&&single.prazo_dias!=null&&single.validade){
      const ultimas=await checked(db.from('frete_envios').select('texto,status,provider_id').eq('consulta_id',single.id).order('created_at',{ascending:false}).limit(1))
      if(confirmouTaxasFrete(texto,single,ultimas?.[0])){campos.taxas_inclusas=true;taxasPorContexto=true}
    }
    if(Object.keys(campos).length){
      if(mediaTipo){delete campos.taxas_inclusas;campos.origem_anexo=true}
      let snapshot=single,atual=null
      for(let tentativa=0;tentativa<2;tentativa++){
        atual=await checked(db.rpc('frete_registrar_progresso',{p_consulta_id:single.id,p_mensagem_id:mensagemId,p_versao:snapshot.updated_at,p_campos:campos}))
        if(atual)break
        snapshot=await checked(db.from('frete_consultas').select('*').eq('id',single.id).single())
        if(snapshot.ia_pausada||snapshot.completa||![single.atualizado_por,'assistente_frete_progresso'].includes(snapshot.atualizado_por))return true
        if(taxasPorContexto&&(Number(snapshot.valor_total)!==Number(single.valor_total)||Number(snapshot.prazo_dias)!==Number(single.prazo_dias)||Date.parse(snapshot.validade)!==Date.parse(single.validade)))return true
      }
      if(!atual)return true // CAS/handoff concorrente: não continuar com snapshot antigo.
      const pendencias=solicitarPendenciasFrete(atual)
      if(!atual.completa&&!atual.ia_pausada&&pendencias)await checked(db.rpc('frete_enfileirar_resposta',{p_consulta_id:single.id,p_mensagem_id:mensagemId,p_texto:pendencias}))
      return true
    }
  }
  if(mediaTipo){
    await checked(db.rpc('frete_enfileirar_resposta',{p_consulta_id:single.id,p_mensagem_id:mensagemId,p_texto:'O arquivo foi preservado, mas preciso confirmar os dados em texto: valor TOTAL do frete com todas as taxas, prazo em dias úteis e validade (dd/mm/aaaa). Pode informar? Sem contratação ou agendamento de coleta.'}));return true
  }
  if(!mediaTipo&&assistantEnabled&&single.ia_pausada&&await capturarPropostaTextual(db,single,texto))return true
  if (single.ia_pausada || single.completa || !assistantEnabled) return true
  const cotacao = await checked(db.from('frete_cotacoes').select('*').eq('id', single.cotacao_id).single())
  if (cotacao.status !== 'aberta') return true
  let dadosFormulario=cotacao.dados
  if(/cidade|municipio/i.test(String(texto||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'')))try{dadosFormulario=await completarLocalFormularioFrete(db,cotacao.dados)}catch{await pause();return true}
  const resposta = await interpret(texto, dadosFormulario)
  if(resposta.tipo==='aguardar')return true
  if(resposta.tipo==='proposta'){
    const pendencias=solicitarPendenciasFrete(single)
    if(pendencias)await checked(db.rpc('frete_enfileirar_resposta',{p_consulta_id:single.id,p_mensagem_id:mensagemId,p_texto:pendencias}))
    return true
  }
  if (resposta.tipo === 'opt_out') {
    for (const s of supplierMatches) await checked(db.from('fornecedores').update({ cotacao_frete_consentimento: false, cotacao_frete_atualizada_por:'opt_out_inbound' }).eq('id', s.id))
  }
  if (resposta.tipo !== 'resposta') { await pause(); return true }
  // IDs diferentes não autorizam loop bot-bot com a mesma pergunta/resposta.
  const automatic=decidirInteracaoAutomaticaFrete(texto,dadosFormulario)
  if(automatic?.tipo==='resposta'){
    const replies=await checked(db.from('frete_envios').select('mensagem_id,texto,status,provider_id,attempted_at,created_at').eq('consulta_id',single.id).order('created_at',{ascending:false}).limit(100))
    const history=await checked(db.from('frete_mensagens').select('id,texto,created_at').eq('consulta_id',single.id).order('created_at',{ascending:false}).limit(100))
    if(parRepetidoFrete(texto,resposta.texto,replies,history)){await pause();return true}
  }
  await checked(db.rpc('frete_enfileirar_resposta', { p_consulta_id: single.id, p_mensagem_id: mensagemId, p_texto: resposta.texto }))
  return true
  } catch (error) {
    error.freteTransportadora = supplierMatches.length > 0 || matches.length > 0
    throw error
  }
}
