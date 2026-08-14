/**
 * Auditoria READ-ONLY — DOMÍNIO CLIENTES.
 * NetVision `Pessoas` (Cliente=1) vs Vivenzza `clientes_erp`.
 *
 * Match exato: Pessoas.CodigoPessoa == clientes_erp.legacy_id (mesmo código,
 * confirmado por amostra — ex. "000493" nos dois lados pra mesma pessoa).
 *
 *   node scripts/audit-netvision-clientes.mjs [--json=out.json]
 */
import 'dotenv/config'
import { config as loadCrmEnv } from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
loadCrmEnv({ path: path.resolve(__dirname, '../../vivenzza-crm-api/.env') })

function argValor(nome, padrao) {
  const pref = `--${nome}=`
  const achado = process.argv.find((a) => a.startsWith(pref))
  return achado ? achado.slice(pref.length) : padrao
}
const SAIDA_JSON = argValor('json', null)

async function buscarNetVision() {
  const pool = new pg.Pool({ host: process.env.E01_HOST, port: process.env.E01_PORT, user: process.env.E01_USER, password: process.env.E01_PASSWORD, database: process.env.E01_DATABASE })
  try {
    const { rows } = await pool.query(`SELECT trim("CodigoPessoa") as codigo, "Nome", "Inativo", "CGC_CPF", "Fone", "Celular", "e_mail" FROM "Pessoas" WHERE "Cliente" = 1`)
    return rows
  } finally {
    await pool.end()
  }
}

async function buscarVivenzza() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY)
  const linhas = []
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase.from('clientes_erp').select('legacy_id, razao_social, ativo, cnpj_cpf, contatos').range(offset, offset + 999)
    if (error) throw error
    linhas.push(...data)
    if (data.length < 1000) break
  }
  return linhas
}

async function main() {
  console.log('[audit:netvision:clientes] Pessoas(Cliente=1) x clientes_erp — match exato por código\n')
  const [nv, vv] = await Promise.all([buscarNetVision(), buscarVivenzza()])

  const nvMap = new Map(nv.map((r) => [r.codigo, r]))
  const vvMap = new Map(vv.map((r) => [r.legacy_id, r]))

  const missingInVivenzza = [...nvMap.keys()].filter((k) => !vvMap.has(k))
  const extraInVivenzza = [...vvMap.keys()].filter((k) => !nvMap.has(k))

  console.log(`  NetVision (Pessoas, Cliente=1): ${nv.length}`)
  console.log(`  Vivenzza (clientes_erp): ${vv.length}`)
  console.log(`  MISSING_IN_VIVENZZA (existe no NetVision, falta no Vivenzza): ${missingInVivenzza.length}`)
  for (const k of missingInVivenzza.slice(0, 20)) console.log(`    ${k}  ${nvMap.get(k).Nome}`)
  console.log(`  EXTRA_IN_VIVENZZA (existe no Vivenzza, falta no NetVision): ${extraInVivenzza.length}`)
  for (const k of extraInVivenzza.slice(0, 20)) console.log(`    ${k}  ${vvMap.get(k).razao_social}`)

  const pct = (n, total) => total ? `${((n / total) * 100).toFixed(1)}%` : 'n/a'
  console.log(`\n  Coverage (Vivenzza sobre NetVision): ${pct(nv.length - missingInVivenzza.length, nv.length)}`)

  const resultado = {
    n_netvision: nv.length, n_vivenzza: vv.length,
    missing_in_vivenzza: missingInVivenzza.map((k) => ({ codigo: k, nome: nvMap.get(k).Nome })),
    extra_in_vivenzza: extraInVivenzza.map((k) => ({ legacy_id: k, razao_social: vvMap.get(k).razao_social })),
  }
  if (SAIDA_JSON) { fs.writeFileSync(SAIDA_JSON, JSON.stringify(resultado, null, 2)); console.log(`\n  JSON salvo em ${SAIDA_JSON}`) }
  process.exit(0)
}

main().catch((err) => { console.error('[audit:netvision:clientes] ERRO:', err.message); process.exit(2) })
