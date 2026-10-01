// Backfill único (2026-10-01) — parte da unificação de cadastro CRM/ERP pedida pelo Quais.
//
// Hoje 1.978 de 2.080 clientes_erp (os reais, sincronizados do NetVision) não têm
// NENHUM lead vinculado — ou seja, não têm WhatsApp, histórico, tarefa, classificação
// comercial nem território possível de editar, porque tudo isso vive em `leads`.
//
// Este script cria 1 lead pra cada clientes_erp sem vínculo, usando `cliente_erp_id`
// (que referencia clientes_erp.legacy_id) pra linkar. Não toca nos 110 que já têm lead
// (muitos criados manualmente pela equipe, já com `tipo` classificado — não sobrescrever).
//
// Depois deste backfill, TODO clientes_erp tem lead — o que permite directamente:
// (a) classificação/território passarem a viver só em `leads` (fonte única);
// (b) o job de sync do NetVision manter essa garantia pra clientes novos (ver
//     mudança em src/jobs/sync-clientes-legado.js, no mesmo commit).
//
// Rodar uma vez: node scripts/backfill-leads-clientes-erp-unificacao.mjs
// Idempotente: clientes_erp já vinculados são pulados, pode rodar de novo sem duplicar.

import 'dotenv/config'
import { supabase } from '../src/lib/supabase-admin.server.js'
import { normalizarTelefone } from '../src/lib/telefone.js'

const TIPOS_TELEFONE = ['celular', 'fone', 'telefone', 'contato']
const PAGE = 1000
const BATCH_INSERT = 500

function primeiroContato(contatos, tipos) {
  for (const c of contatos ?? []) {
    if (tipos.includes(c?.tipo) && c?.valor) return c.valor
  }
  return null
}

async function clientesErpSemLead() {
  // legacy_ids já vinculados (pagina leads também — 5.801 linhas).
  const vinculados = new Set()
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase
      .from('leads')
      .select('cliente_erp_id')
      .not('cliente_erp_id', 'is', null)
      .range(offset, offset + PAGE - 1)
    if (error) throw error
    for (const r of data) vinculados.add(r.cliente_erp_id)
    if (data.length < PAGE) break
  }

  const semLead = []
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase
      .from('clientes_erp')
      .select('legacy_id, razao_social, nome_fantasia, ativo, endereco, contatos, vendedor_responsavel_usuario_id')
      .range(offset, offset + PAGE - 1)
    if (error) throw error
    for (const c of data) if (!vinculados.has(c.legacy_id)) semLead.push(c)
    if (data.length < PAGE) break
  }
  return semLead
}

function montarLead(c) {
  const nomeBase = c.nome_fantasia || c.razao_social
  const telefoneRaw = primeiroContato(c.contatos, TIPOS_TELEFONE)
  const email = primeiroContato(c.contatos, ['email'])
  return {
    nome: `${c.legacy_id}- ${nomeBase}`,
    empresa: c.razao_social,
    tipo: null, // não advinhar classificação — fica pro time preencher
    etapa: 'fechado', // já é cliente real (vindo do ERP), não prospect de funil
    origem: 'erp_legado',
    telefone: telefoneRaw ? normalizarTelefone(telefoneRaw) : null,
    email: email || null,
    cliente_erp_id: c.legacy_id,
    ativo: c.ativo ?? true,
    cidade: c.endereco?.cidade || null,
    estado: c.endereco?.estado || null,
    responsavel_id: c.vendedor_responsavel_usuario_id || null,
  }
}

async function main() {
  console.log('Levantando clientes_erp sem lead vinculado...')
  const semLead = await clientesErpSemLead()
  console.log(`${semLead.length} clientes_erp sem lead. Criando...`)

  let criados = 0
  for (let i = 0; i < semLead.length; i += BATCH_INSERT) {
    const lote = semLead.slice(i, i + BATCH_INSERT).map(montarLead)
    const { error } = await supabase.from('leads').insert(lote)
    if (error) {
      console.error(`Erro no lote ${i}-${i + lote.length}:`, error.message)
      throw error
    }
    criados += lote.length
    console.log(`  ${criados}/${semLead.length} criados...`)
  }

  console.log(`Concluído. ${criados} leads criados, vinculando clientes_erp que não tinham lead.`)
}

main().catch(err => {
  console.error('Backfill falhou:', err)
  process.exit(1)
})
