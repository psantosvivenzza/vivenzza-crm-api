// FASE B.4 (homologação, 2026-08-11) — investigação do gap clientes_erp.ativo
// (documentado desde a FASE B.1.2 como MUST_FIX_BEFORE_AUTOMATED_ACTIONS, não
// bloqueante para shadow). Investigação read-only em produção confirmou uma
// chave de junção já existente e confiável — NÃO inventada aqui:
//
//   contas_financeiras.codigo_cliente = clientes_erp.legacy_id
//
// Evidência (produção, vkncsyhugotyfwmxpzgq, 2026-08-11, queries read-only):
//   - clientes_erp.legacy_id: 2.034/2.034 linhas preenchidas e ÚNICAS.
//   - contas_financeiras.codigo_cliente: preenchido em 17.630/23.286 (75,7%)
//     dos títulos; quando preenchido, o JOIN com clientes_erp.legacy_id bate
//     em 100% dos casos (17.630/17.630) — amostra manual confirmou
//     pessoa_nome sempre igual a razao_social do cliente encontrado.
//   - Dos 17.630 títulos com match, 100 (0,57%) pertencem a um cliente com
//     ativo=false.
//   - Nos 50 clientes já usados nas rodadas B.1.1/B.1.2/B.3: 50/50 têm match,
//     0/50 estão inativos (esta amostra específica não expõe o gap, mas a
//     carteira completa tem 100 casos reais).
//
// PROPOSTA, NÃO IMPLANTADA: este módulo é só a consulta — decidirProximaAcao()
// e avaliarNbaShadow() NÃO o chamam ainda. Quando uma automação real for
// autorizada a considerar isso, a regra correta é: sem codigo_cliente OU sem
// linha correspondente em clientes_erp → DESCONHECIDO (nunca tratar como
// ativo por omissão); com match e ativo=false → bloquear ação automática.
import { supabase } from '../supabase-admin.server.js'

export const STATUS_CLIENTE_ERP = Object.freeze({
  ATIVO: 'ATIVO',
  INATIVO: 'INATIVO',
  // Sem codigo_cliente ou sem match em clientes_erp — 24,3% dos títulos hoje.
  // Deliberadamente NUNCA tratado como "ativo" por padrão.
  DESCONHECIDO: 'DESCONHECIDO',
})

export async function statusClienteErpPara(contasFinanceirasId) {
  const { data: conta, error } = await supabase
    .from('contas_financeiras')
    .select('codigo_cliente')
    .eq('id', contasFinanceirasId)
    .single()
  if (error) throw error
  if (!conta.codigo_cliente) return { status: STATUS_CLIENTE_ERP.DESCONHECIDO, clienteErpId: null }

  const { data: cliente, error: erroCliente } = await supabase
    .from('clientes_erp')
    .select('id, ativo')
    .eq('legacy_id', conta.codigo_cliente)
    .maybeSingle()
  if (erroCliente) throw erroCliente
  if (!cliente) return { status: STATUS_CLIENTE_ERP.DESCONHECIDO, clienteErpId: null }

  return {
    status: cliente.ativo ? STATUS_CLIENTE_ERP.ATIVO : STATUS_CLIENTE_ERP.INATIVO,
    clienteErpId: cliente.id,
  }
}
