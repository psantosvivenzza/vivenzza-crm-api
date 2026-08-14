/**
 * PREVIEW read-only — o que SERIA feito com os 48 títulos financeiros
 * duplicados, sem aplicar nada. Usa a mesma classificação de
 * analise-duplicados-financeiro.mjs e enriquece com: referências em
 * cobrancas_whatsapp (pra saber qual registro tem histórico de cobrança de
 * verdade) e um veredito de impacto se o não-canônico for arquivado.
 *
 * NÃO desativa, NÃO exclui, NÃO altera nada. Gera dois artefatos:
 *   - PREVIEW_DUPLICADOS_CLAROS.md — os 23 com canônico claro, ação
 *     recomendada, pronta pra revisão humana antes de aplicar.
 *   - REVISAO_DUPLICADOS_AMBIGUOS.md — os 25 ambíguos, formato legível sem
 *     precisar rodar SQL, pra decisão humana.
 *
 *   node scripts/preview-duplicados-financeiro.mjs
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY)

function normalizar(legacyId) {
  const m = legacyId?.match(/^(?:cr|[0-9]{3})-(\d+)-(\d+)$/)
  return m ? `${m[1]}-${m[2]}` : null
}
function prefixo(legacyId) { const m = legacyId.match(/^(cr|[0-9]{3})-/); return m ? m[1] : '?' }
const fmt = (v) => Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

async function main() {
  const crm = []
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase.from('contas_financeiras')
      .select('id, legacy_id, pessoa_nome, valor, valor_pago, status, vencimento, created_at, origem_lancamento, sincronizado_legado_em, codigo_cliente, em_revisao_financeira')
      .eq('tipo', 'receber').range(offset, offset + 999)
    if (error) throw error
    crm.push(...data)
    if (data.length < 1000) break
  }

  const grupos = new Map()
  for (const c of crm) {
    const n = normalizar(c.legacy_id)
    if (!n) continue
    if (!grupos.has(n)) grupos.set(n, [])
    grupos.get(n).push(c)
  }
  const duplicados = [...grupos.entries()].filter(([, rows]) => rows.length > 1)

  const todosIds = duplicados.flatMap(([, rows]) => rows.map((r) => r.id))
  const cobrancasPorConta = new Map()
  for (let i = 0; i < todosIds.length; i += 200) {
    const lote = todosIds.slice(i, i + 200)
    const { data, error } = await supabase.from('cobrancas_whatsapp').select('id, contas_financeiras_id, status, data_envio').in('contas_financeiras_id', lote)
    if (error) throw error
    for (const c of data) {
      if (!cobrancasPorConta.has(c.contas_financeiras_id)) cobrancasPorConta.set(c.contas_financeiras_id, [])
      cobrancasPorConta.get(c.contas_financeiras_id).push(c)
    }
  }

  const claros = [], ambiguos = [], naoDuplicados = []
  for (const [tituloNorm, rows] of duplicados) {
    const linhas = rows.map((c) => ({
      id: c.id, legacy_id: c.legacy_id, prefixo: prefixo(c.legacy_id), pessoa_nome: c.pessoa_nome,
      valor: Number(c.valor), valor_pago: Number(c.valor_pago), status: c.status, vencimento: c.vencimento,
      created_at: c.created_at, origem_lancamento: c.origem_lancamento, sincronizado_legado_em: c.sincronizado_legado_em,
      codigo_cliente: c.codigo_cliente, cobrancas: cobrancasPorConta.get(c.id) || [],
    }))
    const valores = new Set(linhas.map((l) => l.valor.toFixed(2)))
    if (valores.size !== 1) { naoDuplicados.push({ tituloNorm, linhas }); continue }

    const completude = (l) => (l.codigo_cliente ? 1 : 0) + (l.origem_lancamento ? 1 : 0) + (l.sincronizado_legado_em ? 1 : 0)
    const maisCompleto = linhas.reduce((a, b) => (completude(b) > completude(a) ? b : a))
    const maisRecente = linhas.reduce((a, b) => (new Date(b.sincronizado_legado_em || b.created_at) > new Date(a.sincronizado_legado_em || a.created_at) ? b : a))
    const comCobranca = linhas.filter((l) => l.cobrancas.length > 0)

    if (maisCompleto.id === maisRecente.id) {
      const canonico = maisCompleto
      const sombra = linhas.find((l) => l.id !== canonico.id)
      claros.push({ tituloNorm, canonico, sombra, comCobranca, linhas })
    } else {
      ambiguos.push({ tituloNorm, linhas, maisCompleto, maisRecente, comCobranca })
    }
  }

  console.log(`Claros: ${claros.length} | Ambiguos: ${ambiguos.length} | Nao-duplicados (valores diferentes): ${naoDuplicados.length}`)

  let mdClaros = '# Preview — 23 duplicados com candidato canônico claro\n\n'
  mdClaros += `Gerado ${new Date().toISOString()}. **NADA foi aplicado** — isto é só o preview da ação recomendada.\n\n`
  mdClaros += 'Critério: o registro mais completo (tem código de cliente, origem de lançamento e data de última sincronização) '
  mdClaros += 'é também o mais recentemente sincronizado — sem conflito entre os dois sinais.\n\n---\n\n'
  for (const { tituloNorm, canonico, sombra, comCobranca } of claros) {
    mdClaros += `## Título ${tituloNorm}\n\n`
    mdClaros += `**Ação recomendada**: manter \`${canonico.legacy_id}\` (canônico), arquivar/desativar \`${sombra.legacy_id}\` (sombra).\n\n`
    mdClaros += '| | Canônico (manter) | Sombra (candidato a arquivar) |\n|---|---|---|\n'
    mdClaros += `| legacy_id | \`${canonico.legacy_id}\` | \`${sombra.legacy_id}\` |\n`
    mdClaros += `| id | \`${canonico.id}\` | \`${sombra.id}\` |\n`
    mdClaros += `| pessoa | ${canonico.pessoa_nome} | ${sombra.pessoa_nome} |\n`
    mdClaros += `| valor | R$ ${fmt(canonico.valor)} | R$ ${fmt(sombra.valor)} |\n`
    mdClaros += `| valor_pago | R$ ${fmt(canonico.valor_pago)} | R$ ${fmt(sombra.valor_pago)} |\n`
    mdClaros += `| status | ${canonico.status} | ${sombra.status} |\n`
    mdClaros += `| vencimento | ${canonico.vencimento} | ${sombra.vencimento} |\n`
    mdClaros += `| criado_em | ${canonico.created_at} | ${sombra.created_at} |\n`
    mdClaros += `| origem_lancamento | ${canonico.origem_lancamento || '(nulo)'} | ${sombra.origem_lancamento || '(nulo)'} |\n`
    mdClaros += `| codigo_cliente | ${canonico.codigo_cliente || '(nulo)'} | ${sombra.codigo_cliente || '(nulo)'} |\n`
    mdClaros += `| cobranças WhatsApp | ${canonico.cobrancas.length} | ${sombra.cobrancas.length} |\n\n`
    if (comCobranca.some((l) => l.id === sombra.id)) {
      mdClaros += `AVISO: o registro SOMBRA tem histórico de cobrança (${sombra.cobrancas.length} envio(s)) — arquivar sem preservar esse histórico perderia rastreabilidade. Recomendo migrar as referências de cobrancas_whatsapp pro canônico antes de arquivar, não só desativar.\n\n`
    } else {
      mdClaros += 'Impacto se a sombra for arquivada: nenhuma cobrança referencia esse registro — impacto conhecido é zero.\n\n'
    }
    mdClaros += '---\n\n'
  }
  fs.writeFileSync('PREVIEW_DUPLICADOS_CLAROS.md', mdClaros)

  let mdAmb = '# Revisão humana — 25 duplicados ambíguos\n\n'
  mdAmb += `Gerado ${new Date().toISOString()}. **NADA foi aplicado.** Nestes casos o registro mais completo e o mais `
  mdAmb += 'recentemente sincronizado são linhas DIFERENTES — não dá pra decidir automaticamente. Escolha manualmente qual manter.\n\n---\n\n'
  for (const { tituloNorm, linhas, maisCompleto, maisRecente, comCobranca } of ambiguos) {
    mdAmb += `## Título ${tituloNorm}\n\n`
    mdAmb += `Mais completo: \`${maisCompleto.legacy_id}\` — Mais recente: \`${maisRecente.legacy_id}\`\n\n`
    mdAmb += '| legacy_id | pessoa | valor | valor_pago | status | criado_em | origem | cobranças |\n|---|---|---|---|---|---|---|---|\n'
    for (const l of linhas) {
      mdAmb += `| \`${l.legacy_id}\` | ${l.pessoa_nome} | R$ ${fmt(l.valor)} | R$ ${fmt(l.valor_pago)} | ${l.status} | ${l.created_at} | ${l.origem_lancamento || '(nulo)'} | ${l.cobrancas.length} |\n`
    }
    mdAmb += '\n'
    if (comCobranca.length) mdAmb += `AVISO: tem histórico de cobrança em: ${comCobranca.map((l) => `\`${l.legacy_id}\``).join(', ')} — considerar isso na escolha.\n\n`
    mdAmb += '**Decisão**: (preencher) manter `_____`, arquivar `_____`\n\n---\n\n'
  }
  fs.writeFileSync('REVISAO_DUPLICADOS_AMBIGUOS.md', mdAmb)

  console.log('\nArquivos gerados: PREVIEW_DUPLICADOS_CLAROS.md, REVISAO_DUPLICADOS_AMBIGUOS.md')
  if (naoDuplicados.length) console.log(`\nAVISO: ${naoDuplicados.length} grupo(s) tinham valores diferentes — nao tratados como duplicata, nao incluidos nos arquivos.`)
}

main().catch((err) => { console.error('ERRO:', err.message); process.exit(1) })
