// IA WhatsApp MVP — contexto permitido pro assistente, carregado 100%
// DETERMINISTICAMENTE pelo backend (não é o LLM que escolhe o que consultar
// nesta primeira versão — decisão deliberada de simplificação/segurança:
// ver nota em replySuggestion.js). Reaproveita as mesmas fontes de verdade já
// usadas pelo motor de cobrança v2 (paymentGuard.js/promises.js) — nenhuma
// query nova além da política de negociação.
import { supabase } from '../../supabase-admin.server.js'
import { promessaAtivaPara } from '../promises.js'
import { tituloEstaQuitado } from '../paymentGuard.js'

export async function politicaAtivaNegociacao() {
  const { data, error } = await supabase
    .from('negotiation_policies')
    .select('*')
    .eq('ativo', true)
    .order('criado_em', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data
}

export async function carregarContextoCliente({ contasFinanceirasId }) {
  const [tituloResult, promessaAtiva, quitado, politica] = await Promise.all([
    supabase.from('contas_financeiras').select('id, pessoa_nome, valor, valor_pago, vencimento, status').eq('id', contasFinanceirasId).maybeSingle(),
    promessaAtivaPara(contasFinanceirasId),
    tituloEstaQuitado(contasFinanceirasId),
    politicaAtivaNegociacao(),
  ])
  if (tituloResult.error) throw tituloResult.error

  const t = tituloResult.data
  const titulo = t
    ? { id: t.id, pessoaNome: t.pessoa_nome, valor: Number(t.valor || 0), valorPago: Number(t.valor_pago || 0), saldo: Number(t.valor || 0) - Number(t.valor_pago || 0), vencimento: t.vencimento, status: t.status }
    : null

  return { titulo, promessaAtiva, quitado, politica }
}
