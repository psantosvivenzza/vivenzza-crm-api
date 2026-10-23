// Diagnóstico fechado: nunca propagar mensagem, host, usuário ou cause do driver.
const CODIGOS = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET',
  'EHOSTUNREACH', 'ENETUNREACH', 'ECONNABORTED', 'EPIPE',
  '28P01', '28000', '3D000', '53300', '57P03', '57P01',
  '08006', '08001', '08004', '42501',
])

export async function validarConexaoPedidos(pool) {
  try {
    await pool.query('SELECT 1')
  } catch (err) {
    // Falha ao fechar não pode mascarar a falha primária nem expor outro erro.
    await pool.end().catch(() => {})
    const codigo = typeof err?.code === 'string' && CODIGOS.has(err.code)
      ? err.code : 'NAO_CLASSIFICADO'
    throw new Error(`Não foi possível conectar ao banco legado (e01). Código: ${codigo}. Verifique o acesso pela máquina na rede do NetVision; não execute sincronização como teste de conexão.`)
  }
  return pool
}
