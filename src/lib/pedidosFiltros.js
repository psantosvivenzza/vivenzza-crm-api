// Shared by the order list and its summary: identical selection and seller scope.
function dateBoundary(value, end=false) {
  if (!value) return null
  if (typeof value !== 'string') throw Object.assign(Error('Informe uma data válida.'),{status:400})
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    const stamp=new Date(value),day=new Date(value.slice(0,10)+'T00:00:00Z')
    if(!Number.isFinite(stamp.getTime())||!Number.isFinite(day.getTime())||day.toISOString().slice(0,10)!==value.slice(0,10))throw Object.assign(Error('Informe uma data válida.'),{status:400})
    return stamp.toISOString()
  }
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value))throw Object.assign(Error('Informe uma data válida.'),{status:400})
  const day=new Date(value+'T00:00:00Z')
  if(!Number.isFinite(day.getTime())||day.toISOString().slice(0,10)!==value)throw Object.assign(Error('Informe uma data válida.'),{status:400})
  if(end)day.setUTCDate(day.getUTCDate()+1)
  return day.toISOString().slice(0,10)+'T03:00:00.000Z'
}
export function aplicarFiltrosPedidos(q, query={}, user={}, now=new Date()) {
  for(const field of ['status','lead_id','cliente_erp_id','sistema_origem','vendedor_id'])if(query[field] && typeof query[field]!=='string')throw Object.assign(Error('Filtro inválido.'),{status:400})
  for(const field of ['status','lead_id','cliente_erp_id','sistema_origem'])if(query[field])q=q.eq(field,query[field])
  const start=dateBoundary(query.periodo_de),end=dateBoundary(query.periodo_ate,true)
  if(start)q=q.gte('criado_em',start)
  if(end)q=/^\d{4}-\d{2}-\d{2}$/.test(query.periodo_ate)?q.lt('criado_em',end):q.lte('criado_em',end)
  if(start&&end&&(start>end||(start===end&&/^\d{4}-\d{2}-\d{2}$/.test(query.periodo_ate))))throw Object.assign(Error('O período final deve ser igual ou posterior ao inicial.'),{status:400})
  if(query.sem_vinculo==='true')q=q.eq('precisa_vinculo_cliente',true)
  if(query.com_erro==='true')q=q.not('erro_sincronizacao','is',null)
  if(query.com_conflito==='true')q=q.eq('conflito_sincronizacao',true)
  if(query.importados_hoje==='true'){
    const day=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(now)
    q=q.gte('sincronizado_em',dateBoundary(day))
  }
  const seller=user.role==='vendedor'?user.id:query.vendedor_id
  if(seller)q=q.eq('vendedor_id',seller)
  return q
}

