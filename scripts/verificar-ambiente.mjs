/**
 * Diagnóstico de ambiente — roda antes de qualquer sincronização.
 *
 *   node scripts/verificar-ambiente.mjs
 *
 * Confere as duas pernas de que o sync depende, uma de cada vez, e diz
 * exatamente o que fazer quando alguma falha. Sem isso, um erro de chave do
 * Supabase aparece como "Unregistered API key" no meio de um log e passa
 * semanas despercebido — foi o que aconteceu com o sync de pedidos.
 *
 * Só leitura. Não altera nada em lugar nenhum.
 */
import 'dotenv/config'
import pg from 'pg'

let falhou = false
const linha = () => console.log('  ' + '-'.repeat(56))

console.log('\n============================================================')
console.log('  DIAGNOSTICO DO AMBIENTE DE SINCRONIZACAO')
console.log('============================================================\n')

// ── 1. NetVision (rede local) ───────────────────────────────────────────────
console.log('[1/2] NetVision (banco e01)')
linha()
const faltandoE01 = ['E01_HOST', 'E01_PORT', 'E01_USER', 'E01_DATABASE'].filter((v) => !process.env[v])
if (faltandoE01.length) {
  falhou = true
  console.log(`  FALHOU: faltam variaveis no .env: ${faltandoE01.join(', ')}`)
} else {
  console.log(`  Destino: ${process.env.E01_HOST}:${process.env.E01_PORT}/${process.env.E01_DATABASE}`)
  const client = new pg.Client({
    host: process.env.E01_HOST, port: process.env.E01_PORT, user: process.env.E01_USER,
    password: process.env.E01_PASSWORD, database: process.env.E01_DATABASE,
    connectionTimeoutMillis: 8000,
  })
  try {
    await client.connect()
    const { rows } = await client.query('SELECT COUNT(*) AS n FROM "CR_Duplicatas"')
    console.log(`  OK - conectado. ${rows[0].n} titulos em CR_Duplicatas.`)
    await client.end()
  } catch (err) {
    falhou = true
    console.log(`  FALHOU: ${err.message}`)
    console.log('')
    console.log('  O QUE FAZER:')
    console.log('  - Este script so funciona na maquina do escritorio, na mesma')
    console.log('    rede do servidor NetVision.')
    console.log('  - Se o sync de pedidos funciona nesta maquina, o acesso existe.')
    await client.end().catch(() => {})
  }
}

// ── 2. Supabase (internet) ──────────────────────────────────────────────────
console.log('\n[2/2] Supabase (banco do CRM)')
linha()
const url = process.env.SUPABASE_URL
const chave = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url) {
  falhou = true
  console.log('  FALHOU: SUPABASE_URL nao esta no .env')
} else if (!chave) {
  falhou = true
  console.log('  FALHOU: nenhuma chave secreta no .env')
  console.log('  Preencha SUPABASE_SECRET_KEY (ou SUPABASE_SERVICE_ROLE_KEY).')
} else {
  console.log(`  Projeto: ${url}`)
  console.log(`  Chave...: ${chave.slice(0, 12)}... (${chave.length} caracteres)`)
  try {
    const { supabase } = await import('../src/lib/supabase-admin.server.js')
    const { error } = await supabase.from('automacoes_config').select('id').limit(1)
    if (error) throw new Error(error.message)
    console.log('  OK - chave valida, leitura confirmada.')
  } catch (err) {
    falhou = true
    const msg = String(err.message || err)
    console.log(`  FALHOU: ${msg}`)
    console.log('')
    if (/unregistered|invalid api key|jwt|apikey/i.test(msg)) {
      console.log('  DIAGNOSTICO: a chave do .env nao e mais aceita pelo Supabase.')
      console.log('  Provavelmente foi rotacionada e o .env local ficou pra tras.')
      console.log('')
      console.log('  O QUE FAZER (2 minutos):')
      console.log('  1. Abra https://supabase.com/dashboard')
      console.log('  2. Projeto vkncsyhugotyfwmxpzgq -> Project Settings -> API Keys')
      console.log('  3. Copie a chave SECRETA (comeca com sb_secret_)')
      console.log('  4. Abra o arquivo .env desta pasta no Bloco de Notas')
      console.log('  5. Substitua o valor de SUPABASE_SECRET_KEY pela chave copiada')
      console.log('  6. Salve e rode este diagnostico de novo')
      console.log('')
      console.log('  IMPORTANTE: o sync de PEDIDOS usa a mesma chave e tambem esta')
      console.log('  parado por causa disso (veja logs/sync-pedidos.log). Corrigir')
      console.log('  aqui conserta os dois.')
    }
  }
}

console.log('')
console.log('============================================================')
if (falhou) {
  console.log('  RESULTADO: tem coisa pra resolver antes de sincronizar.')
  console.log('============================================================\n')
  // Sem process.exit(): o cliente do Supabase deixa conexao aberta e o
  // encerramento abrupto faz o Node no Windows cuspir "Assertion failed ...
  // UV_HANDLE_CLOSING" DEPOIS do resultado — assusta sem motivo nenhum.
  process.exitCode = 1
} else {
  console.log('  RESULTADO: tudo certo. Pode sincronizar.')
  console.log('============================================================\n')
  process.exitCode = 0
}
