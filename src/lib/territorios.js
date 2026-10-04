import { supabase } from './supabase-admin.server.js'

// Território de distribuidor (cidades de atendimento) — compartilhado entre
// leads.js (prospects no funil) e erp.js (clientes_erp, o cadastro real e
// principal, sincronizado do NetVision). Um registro em distribuidor_cidades
// pertence a um lead OU a um cliente_erp, nunca os dois (constraint
// chk_distribuidor_cidades_dono no banco). A regra de negócio — só 1
// distribuidor ativo por cidade/UF — é a mesma pros dois donos, por isso
// fica centralizada aqui em vez de duplicada.

function dono({ leadId, clienteErpId }) {
  if (leadId && clienteErpId) throw new Error('definirDono: informe leadId OU clienteErpId, nunca os dois')
  if (!leadId && !clienteErpId) throw new Error('definirDono: informe leadId ou clienteErpId')
  return leadId ? { coluna: 'lead_id', valor: leadId } : { coluna: 'cliente_erp_id', valor: clienteErpId }
}

export async function buscarCidadesAtendimento(ownerRef) {
  const { coluna, valor } = dono(ownerRef)
  const { data, error } = await supabase
    .from('distribuidor_cidades')
    .select('id, cidade, estado')
    .eq(coluna, valor)
    .eq('ativo', true)
    .order('estado')
    .order('cidade')
  if (error) throw error
  return data ?? []
}

export async function liberarCidades(ownerRef) {
  const { coluna, valor } = dono(ownerRef)
  const { error } = await supabase
    .from('distribuidor_cidades')
    .update({ ativo: false, atualizado_em: new Date().toISOString() })
    .eq(coluna, valor)
    .eq('ativo', true)
  if (error) throw error
}

// Substitui o conjunto de cidades ativas de um distribuidor (lead ou
// cliente_erp) pelo novo conjunto enviado no form. Lança erro com código
// 'TERRITORIO_OCUPADO' se alguma cidade já tiver distribuidor ativo
// diferente deste dono.
export async function definirCidadesAtendimento(ownerRef, cidadesNovas) {
  const { coluna, valor } = dono(ownerRef)
  const normalizadas = (cidadesNovas ?? [])
    .map((c) => ({ cidade: String(c.cidade ?? '').trim(), estado: String(c.estado ?? '').trim().toUpperCase() }))
    .filter((c) => c.cidade && c.estado)

  // Checa conflito ANTES de mexer em qualquer linha, pra dar erro claro em vez
  // de deixar a constraint do banco estourar no meio da operação.
  for (const c of normalizadas) {
    const { data: ocupante, error } = await supabase
      .from('distribuidor_cidades')
      .select(`
        lead_id, cliente_erp_id,
        leads!distribuidor_cidades_lead_id_fkey(nome, empresa),
        clientes_erp!distribuidor_cidades_cliente_erp_id_fkey(razao_social, nome_fantasia)
      `)
      .eq('estado', c.estado)
      .ilike('cidade', c.cidade)
      .eq('ativo', true)
      .maybeSingle()
    if (error) throw error
    if (ocupante && ocupante[coluna] !== valor) {
      const nomeOcupante = ocupante.leads?.empresa || ocupante.leads?.nome
        || ocupante.clientes_erp?.nome_fantasia || ocupante.clientes_erp?.razao_social || 'outro distribuidor'
      const erro = new Error(`A cidade ${c.cidade}/${c.estado} já tem distribuidor ativo: ${nomeOcupante}.`)
      erro.code = 'TERRITORIO_OCUPADO'
      throw erro
    }
  }

  await liberarCidades(ownerRef)

  if (normalizadas.length) {
    // Insert simples (não upsert): a unicidade real é uma expressão parcial
    // (estado, lower(cidade)) WHERE ativo = true, que o onConflict do client
    // não sabe mirar. Já liberamos as linhas antigas deste dono acima e já
    // validamos que nenhum OUTRO dono tem a cidade ativa, então um insert
    // direto é seguro; se mesmo assim colidir, a constraint do banco barra.
    const { error } = await supabase
      .from('distribuidor_cidades')
      .insert(normalizadas.map((c) => ({ [coluna]: valor, cidade: c.cidade, estado: c.estado, ativo: true })))
    if (error) {
      if (error.code === '23505') {
        const erro = new Error('Uma das cidades selecionadas já tem distribuidor ativo (conflito ao salvar).')
        erro.code = 'TERRITORIO_OCUPADO'
        throw erro
      }
      throw error
    }
  }

  return buscarCidadesAtendimento(ownerRef)
}

// Mapa completo de cidades cobertas (usado por GET /api/leads/territorios) —
// une as duas origens (leads e clientes_erp) num resultado só, pra vendedora
// não precisar saber de onde vem cada distribuidor.
export async function listarTerritorios({ cidade, estado } = {}) {
  let query = supabase
    .from('distribuidor_cidades')
    .select(`
      cidade, estado, lead_id, cliente_erp_id,
      leads!distribuidor_cidades_lead_id_fkey(id, nome, empresa, ativo),
      clientes_erp!distribuidor_cidades_cliente_erp_id_fkey(id, razao_social, nome_fantasia, ativo)
    `)
    .eq('ativo', true)
    .order('estado')
    .order('cidade')

  if (estado) query = query.eq('estado', String(estado).toUpperCase())
  if (cidade) query = query.ilike('cidade', String(cidade).trim())

  const { data, error } = await query
  if (error) throw error

  return (data ?? []).map((t) => {
    const origemLead = Boolean(t.lead_id)
    const distribuidor = origemLead
      ? { id: t.leads?.id, nome: t.leads?.nome, empresa: t.leads?.empresa, origem: 'lead' }
      : { id: t.clientes_erp?.id, nome: t.clientes_erp?.razao_social, empresa: t.clientes_erp?.nome_fantasia || t.clientes_erp?.razao_social, origem: 'cliente_erp' }
    return { cidade: t.cidade, estado: t.estado, distribuidor }
  })
}
