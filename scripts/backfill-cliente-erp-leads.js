import 'dotenv/config'
import { supabase } from '../src/lib/supabase.js'
import { construirMapaTelefonesClientesErp, encontrarClienteNoMapa } from '../src/lib/clienteErpMatch.js'

// Rodar uma vez: node scripts/backfill-cliente-erp-leads.js
// Vincula leads existentes a clientes_erp por telefone (retroativo).
async function main() {
  const mapa = await construirMapaTelefonesClientesErp()
  console.log(`[backfill] mapa de telefones montado: ${mapa.size} números de clientes_erp`)

  // Supabase limita a 1000 linhas por resposta — pagina até esgotar.
  const leads = []
  const PAGE = 1000
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase
      .from('leads')
      .select('id, nome, telefone')
      .is('cliente_erp_id', null)
      .not('telefone', 'is', null)
      .range(offset, offset + PAGE - 1)

    if (error) throw error
    leads.push(...data)
    if (data.length < PAGE) break
  }
  console.log(`[backfill] ${leads.length} leads sem cliente_erp_id pra checar`)

  let casados = 0
  for (const lead of leads) {
    const cliente = encontrarClienteNoMapa(mapa, lead.telefone)
    if (!cliente) continue

    const { error: errUpdate } = await supabase
      .from('leads')
      .update({ cliente_erp_id: cliente.legacy_id })
      .eq('id', lead.id)

    if (errUpdate) {
      console.error(`[backfill] erro ao vincular lead ${lead.id}:`, errUpdate.message)
      continue
    }
    casados++
    console.log(`[backfill] ${lead.nome} → ${cliente.legacy_id} (${cliente.razao_social})`)
  }

  console.log(`[backfill] concluído: ${casados}/${leads.length} leads vinculados`)
}

main().catch(err => {
  console.error('[backfill] ERRO:', err.message)
  process.exit(1)
})
