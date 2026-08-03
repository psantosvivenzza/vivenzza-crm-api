// Carga (03/08): puxa da NetVision (e01) o representante comercial e o
// endereço completo (com complemento) de cada cliente, e atualiza só esses
// campos em clientes_erp (Supabase) — preserva o resto do cadastro já correto.
//
// Ajuste 03/08 (v2): o .env deste projeto já migrou pro sistema novo de API
// keys do Supabase — SUPABASE_SERVICE_ROLE_KEY e SUPABASE_ANON_KEY estão
// vazias; quem tem valor real agora é SUPABASE_SECRET_KEY (substituta da
// service role) e SUPABASE_PUBLISHABLE_KEY (substituta da anon key).
//
// Ajuste 03/08 (v3): adicionado log de progresso a cada 100 registros —
// o script processa ~2000 clientes com 1 select+1 update sequenciais cada
// no Supabase (rede), o que pode levar vários minutos e parecia "travado"
// sem nenhum feedback visual.
import 'dotenv/config'
import pg from 'pg'
import { createClient } from '@supabase/supabase-js'

const e01 = new pg.Client({
  host: process.env.E01_HOST, port: process.env.E01_PORT, user: process.env.E01_USER,
  password: process.env.E01_PASSWORD, database: process.env.E01_DATABASE,
})
await e01.connect()
console.log('Conectado na NetVision (e01). Buscando clientes...')

const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(process.env.SUPABASE_URL, supabaseKey)

const { rows } = await e01.query(`
  SELECT
    TRIM(c."CodigoCliente") AS codigo_cliente,
    TRIM(c."Representante") AS rep_codigo,
    r."Nome" AS rep_nome,
    p."Endereco" AS logradouro,
    p."Numero" AS numero,
    p."Complemento" AS complemento,
    p."Bairro" AS bairro,
    p."Cidade" AS cidade,
    p."Estado" AS estado,
    p."CEP" AS cep
  FROM "Clientes" c
  LEFT JOIN "EN_Representantes" r ON TRIM(r."Representante") = TRIM(c."Representante") AND TRIM(c."Representante") <> ''
  LEFT JOIN "Pessoas" p ON TRIM(p."CodigoPessoa") = TRIM(c."CodigoCliente")
`)
console.log(`${rows.length} clientes encontrados na NetVision. Iniciando atualização no Supabase...`)

let atualizados = 0, semCorrespondencia = 0, erros = 0, processados = 0
const inicio = Date.now()

for (const row of rows) {
  processados++
  const legacyId = row.codigo_cliente
  if (!legacyId) continue

  const { data: atual, error: erroBusca } = await supabase
    .from('clientes_erp').select('id, endereco').eq('legacy_id', legacyId).maybeSingle()
  if (erroBusca) { erros++; continue }
  if (!atual) { semCorrespondencia++; continue }

  const enderecoAtual = atual.endereco || {}
  const complementoNovo = (row.complemento || '').trim()
  const enderecoMerged = { ...enderecoAtual, complemento: complementoNovo || enderecoAtual.complemento || null }

  const update = { endereco: enderecoMerged }
  if (row.rep_nome) update.vendedor_responsavel = row.rep_nome

  const { error: erroUpdate } = await supabase.from('clientes_erp').update(update).eq('id', atual.id)
  if (erroUpdate) erros++; else atualizados++

  if (processados % 100 === 0 || processados === rows.length) {
    const segs = Math.round((Date.now() - inicio) / 1000)
    console.log(`... ${processados}/${rows.length} processados (${segs}s) — atualizados: ${atualizados}, sem correspondência: ${semCorrespondencia}, erros: ${erros}`)
  }
}
console.log('CONCLUÍDO — Atualizados:', atualizados, 'Sem correspondencia:', semCorrespondencia, 'Erros:', erros)
await e01.end()
