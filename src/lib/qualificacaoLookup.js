// Consultas externas da qualificação. Todas FALHAM ABERTO: se a fonte estiver
// fora do ar, o resultado é 'desconhecido' e a conversa segue (nunca trava a Lara).
import { soDigitos, cnpjValido } from './qualificacaoLead.js'

const TIMEOUT_MS = 4000

// Situação cadastral na Receita via BrasilAPI (gratuita). Não é consulta de
// crédito (Serasa/SPC): só diz se o CNPJ existe e está ATIVO.
export async function situacaoCnpj(cnpj, fetchImpl = fetch) {
  const c = soDigitos(cnpj)
  if (!cnpjValido(c)) return { valido: false, status: 'desconhecido' }
  try {
    const r = await fetchImpl(`https://brasilapi.com.br/api/cnpj/v1/${c}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (r.status === 404) return { valido: true, status: 'inativo', motivo: 'nao_encontrado' }
    if (!r.ok) return { valido: true, status: 'desconhecido' }
    const j = await r.json()
    const ativa = String(j.descricao_situacao_cadastral ?? '').toUpperCase() === 'ATIVA'
    return { valido: true, status: ativa ? 'ativo' : 'inativo', motivo: ativa ? null : j.descricao_situacao_cadastral }
  } catch {
    return { valido: true, status: 'desconhecido' }
  }
}

// Débito vencido conosco: o CNPJ é de um cliente do ERP com título 'vencida'?
export async function inadimplenteNoErp(supabase, cnpj) {
  const c = soDigitos(cnpj)
  if (c.length !== 14) return false
  try {
    const formatado = c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5')
    const { data: clientes } = await supabase
      .from('clientes_erp').select('legacy_id,cnpj_cpf')
      .in('cnpj_cpf', [c, formatado]).limit(20)
    const ids = (clientes ?? []).filter((x) => x.legacy_id).map((x) => x.legacy_id)
    if (!ids.length) return false
    const { count } = await supabase
      .from('contas_financeiras').select('id', { count: 'exact', head: true })
      .eq('tipo', 'receber').eq('status', 'vencida').in('codigo_cliente', ids)
    return (count ?? 0) > 0
  } catch {
    return false
  }
}

export async function carregarTerritorio(supabase) {
  try {
    const { data } = await supabase.from('distribuidor_cidades').select('cidade,estado').eq('ativo', true)
    return data ?? []
  } catch {
    return []
  }
}
