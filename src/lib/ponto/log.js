// Log sanitizado do módulo de ponto — mesmo padrão de
// src/routes/sdr.js (logarFalhaDePersistenciaLocal, PR #74): nunca logar
// err.message/err.detail/err.hint nem o objeto de erro bruto, porque
// mensagens do Postgres/PostgREST podem ecoar de volta dado sensível (foto,
// CPF, senha). Log é sempre texto fixo + etapa fixa (literal do
// código-fonte) + código de erro filtrado por allowlist.
const CODIGO_ERRO_PERMITIDO_RE = /^[A-Z0-9]{2,10}$/

export function logarErroPonto(etapa, codigoErro) {
  const codigoSeguro = typeof codigoErro === 'string' && CODIGO_ERRO_PERMITIDO_RE.test(codigoErro)
    ? codigoErro
    : 'nao_informado'
  console.error(`[ponto] falha (etapa=${etapa}, codigo=${codigoSeguro})`)
}
