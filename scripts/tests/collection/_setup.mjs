// Helper compartilhado pelos testes de integração do motor de cobrança v2.
// Aponta o processo inteiro para o Postgres local (LOCAL_PG_URL) e para o Fake
// Evolution (EVOLUTION_API_URL) ANTES de qualquer import de código de produção
// — supabase-admin.server.js decide client real vs. local na primeira
// importação, então a env var precisa existir antes do primeiro `import`.
import { PG_USER, PG_PASSWORD, PG_PORT, PG_DATABASE } from '../../localdb-config.mjs'
import { criarFakeEvolution } from '../fakes/fakeEvolution.js'

process.env.LOCAL_PG_URL = `postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${PG_DATABASE}`
process.env.EVOLUTION_API_KEY = 'fake-key-teste'
process.env.FINANCEIRO_WHATSAPP_INSTANCE = 'teste-financeiro-01'
process.env.AI_PROVIDER = 'mock'

let fakeEvolutionInstance = null

export async function iniciarAmbienteDeTeste() {
  if (!fakeEvolutionInstance) {
    fakeEvolutionInstance = await criarFakeEvolution().iniciar()
    process.env.EVOLUTION_API_URL = fakeEvolutionInstance.url
  }
  return fakeEvolutionInstance
}

export async function pararAmbienteDeTeste() {
  if (fakeEvolutionInstance) {
    await fakeEvolutionInstance.parar()
    fakeEvolutionInstance = null
  }
}

let contador = 0
// Telefone de teste único por chamada — evita colisão entre testes que rodam
// em paralelo/sequência sem depender de limpeza total do banco a cada teste.
export function telefoneDeTeste() {
  contador++
  return `5551988${String(Date.now()).slice(-6)}${String(contador).padStart(2, '0')}`
}

export async function criarContaDeTeste(supabase, overrides = {}) {
  const telefone = overrides.telefone_cobranca || telefoneDeTeste()

  // FASE B.5 (homologação, 2026-08-11) — por padrão, toda conta de teste
  // representa um cliente ATIVO real no ERP (cria a linha correspondente em
  // clientes_erp com o mesmo legacy_id/codigo_cliente). Sem isso, o gate de
  // status do cliente no NBA shadow (clienteErpStatus.js) classificaria TODA
  // conta de teste como DESCONHECIDO e forçaria HUMAN_REVIEW, quebrando
  // qualquer teste que espere uma recomendação de canal normal. Passe
  // `codigo_cliente: null` explicitamente pra testar o caso "sem vínculo
  // (DESCONHECIDO)"; passe `clienteErpAtivo: false` pra testar "INATIVO".
  let codigoCliente = overrides.codigo_cliente
  if (codigoCliente === undefined) {
    codigoCliente = `TESTE-${Date.now()}-${contador}`
    const { error: erroCliente } = await supabase.from('clientes_erp').insert({
      legacy_id: codigoCliente,
      razao_social: overrides.pessoa_nome || `Cliente Teste ${codigoCliente}`,
      ativo: overrides.clienteErpAtivo ?? true,
    })
    if (erroCliente) throw erroCliente
  }

  const { data, error } = await supabase.from('contas_financeiras').insert({
    tipo: 'receber',
    pessoa_nome: overrides.pessoa_nome || `Teste Automatizado ${telefone}`,
    valor: overrides.valor ?? 500,
    valor_pago: overrides.valor_pago ?? 0,
    vencimento: overrides.vencimento || new Date().toISOString().slice(0, 10),
    status: overrides.status || 'vencida',
    telefone_cobranca: telefone,
    em_revisao_financeira: overrides.em_revisao_financeira ?? false,
    codigo_cliente: codigoCliente,
  }).select().single()
  if (error) throw error
  return data
}

export async function limparInstanciasDeTeste(supabase) {
  // collection_dispatch_attempts.whatsapp_instance_id referencia
  // whatsapp_instances sem ON DELETE CASCADE — apagar attempts primeiro é
  // necessário, senão o DELETE abaixo falha com violação de FK (23503) e,
  // como o compat client nunca lança (retorna {error}), uma chamada sem
  // checar o retorno mascarava esse erro silenciosamente até este debug.
  await supabase.from('collection_dispatch_attempts').delete().neq('id', '00000000-0000-0000-0000-000000000000')
  const { error } = await supabase.from('whatsapp_instances').delete().neq('instance_name', '__nunca_existe__')
  if (error) throw new Error(`limparInstanciasDeTeste falhou: ${error.message}`)
}
