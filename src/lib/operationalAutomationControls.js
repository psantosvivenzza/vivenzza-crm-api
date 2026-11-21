export const operationalKeys = new Set(['financeiro-ia','ligacoes','reativacao-site'])
export async function setOperationalAutomation({db,key,body,checkReady,expectedInstance=null}) {
  if(!operationalKeys.has(key) || typeof body?.ativo!=='boolean' || typeof body?.esperado!=='boolean' || typeof body?.versao!=='string' || !Number.isFinite(Date.parse(body.versao))) throw Object.assign(Error('Informe estado desejado e versão da consulta.'),{status:400})
  if(body.ativo && await checkReady(key)!==true) throw Object.assign(Error('As dependências desta automação não estão prontas. Atualize o diagnóstico.'),{status:409})
  const result=await db.rpc('set_operational_automation',{p_key:key,p_active:body.ativo,p_expected:body.esperado,p_version:body.versao,p_instance:expectedInstance}).abortSignal(AbortSignal.timeout(10000))
  if(result.error) throw Object.assign(Error(result.error.code==='40001'?'A configuração mudou. Atualize antes de alterar.':'A alteração não foi confirmada. Consulte o estado atual.'),{status:['40001','55000'].includes(result.error.code)?409:503})
  if(typeof result.data?.ativo!=='boolean' || !Number.isFinite(Date.parse(result.data?.versao))) throw Object.assign(Error('Resposta de controle inválida. Atualize o diagnóstico.'),{status:503})
  return result.data
}
