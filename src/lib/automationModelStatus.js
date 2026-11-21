// Diagnostic only. Never returns provider bodies, headers or credential values.
export function describeAutomationModel(result) {
  if (result?.status === 'fulfilled') {
    const models = result.value?.data?.data
    const ready = Array.isArray(models) && models.some(model => model?.id === 'claude-sonnet-4-6')
    return ready
      ? { pronto: true, codigo: null, motivo: null }
      : { pronto: false, codigo: 'modelo_nao_confirmado', motivo: 'O modelo de IA necessário não foi confirmado no provedor.' }
  }
  const status = result?.reason?.response?.status
  if (status === 401 || status === 403) return {
    pronto: false, codigo: 'credencial_ia_recusada',
    motivo: 'O provedor recusou o acesso à IA. O responsável precisa revisar a credencial para retomar as respostas.',
  }
  if (status === 429) return {
    pronto: false, codigo: 'limite_provedor_ia', motivo: 'O provedor de IA está limitando o acesso. As respostas automáticas não estão prontas.',
  }
  return { pronto: false, codigo: 'ia_nao_verificada', motivo: 'Não foi possível confirmar o acesso à IA. Atualize o diagnóstico e verifique o serviço.' }
}
