// Execução pontual LOCAL; não instala cron nem habilita envio/sync/IA.
// Simula por padrão. --apply importa somente fornecedores novos.
import dotenv from 'dotenv'
import pg from 'pg'
import { createClient } from '@supabase/supabase-js'
import { configE01 } from '../src/lib/e01Host.js'
import { planejarTransportadoras } from '../src/lib/fretes/importar-transportadoras.js'

dotenv.config({ path: process.env.VIVENZZA_ENV_FILE || '.env', quiet: true })
const url = process.env.SUPABASE_URL
if (!url || !URL.canParse(url) || new URL(url).hostname !== 'vkncsyhugotyfwmxpzgq.supabase.co') throw Error('Alvo diferente da Vivenzza recusado')
if (process.argv.includes('--apply') && !process.argv.includes('--indice-confirmado')) throw Error('Confirme o indice normalizado no banco antes de aplicar (--indice-confirmado)')
const db = createClient(url, process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
const client = new pg.Client({ ...await configE01(), connectionTimeoutMillis:5000, statement_timeout:10000, query_timeout:12000 })
try {
  await client.connect()
  await client.query('BEGIN READ ONLY')
  await client.query('SET LOCAL statement_timeout = 10000')
  const { rows } = await client.query(`SELECT "CodigoPessoa","CGC_CPF","Nome","NomeFantasia","InscricaoEstadual","Inativo","Celular","Fone","e_mail","Endereco","Numero","Complemento","Bairro","Cidade","Estado","CEP" FROM "Pessoas" WHERE "Transportador"=1 ORDER BY "CodigoPessoa" LIMIT 10001`)
  if (rows.length > 10000) throw Error('Origem excede limite de segurança')
  const existentes = []
  for (let offset=0; ; offset+=1000) {
    const r = await db.from('fornecedores').select('id,cnpj').order('id').range(offset,offset+999).abortSignal(AbortSignal.timeout(20000))
    if(r.error) throw Error(`Leitura CRM: ${r.error.code}`)
    existentes.push(...r.data)
    if(r.data.length<1000) break
    if(offset>=100000) throw Error('CRM excede limite de segurança')
  }
  const plano = planejarTransportadoras(rows, existentes)
  const aplicar = process.argv.includes('--apply')
  let criados=0, concorrentes=0
  if(aplicar) {
    // A constraint normalizada, aplicada antes desta execução, impede corrida
    // inclusive contra outro escritor que grave o CNPJ com máscara.
    for(const row of plano.novos) {
      const r=await db.from('fornecedores').insert(row).select('id').abortSignal(AbortSignal.timeout(20000))
      if(r.error?.code==='23505') { concorrentes++; continue }
      if(r.error) throw Error(`Importação interrompida: ${r.error.code}; criados=${criados}`)
      criados+=r.data.length
    }
  }
  console.log(JSON.stringify({ modo:aplicar?'apply':'dry-run', ...plano.resumo, criados, concorrentes, atualizados:0, envios:0 }))
} catch(e) {
  console.error(JSON.stringify({ erro:e.code || e.message, detalhes_sensiveis_omitidos:true }))
  process.exitCode=1
} finally { await client.query('ROLLBACK').catch(()=>{}); await client.end().catch(()=>{}) }
