// Fixtures devem falhar no ponto da preparação, não deixar um erro de banco
// se transformar em uma asserção enganosa sobre o comportamento de produção.
export async function exigirSucessoFixture(operacao, consulta) {
  const resultado = await consulta
  if (!resultado || typeof resultado !== 'object' || !('error' in resultado)) {
    throw new Error(`Fixture ${operacao}: resultado sem contrato { error }`)
  }
  if (resultado.error) {
    const erro = resultado.error
    throw new Error(`Fixture ${operacao} falhou${erro.code ? ` [${erro.code}]` : ''}: ${erro.message || 'erro sem mensagem'}`, { cause: erro })
  }
  return resultado
}
