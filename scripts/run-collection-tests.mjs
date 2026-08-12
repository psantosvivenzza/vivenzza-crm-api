// npm run test:collection — roda cada arquivo de teste como um processo `node`
// SEPARADO, um de cada vez (nunca em paralelo). Necessário porque vários testes
// manipulam estado global compartilhado no Postgres local (a linha singleton
// automacoes_config id=1, a tabela inteira whatsapp_instances) — `node --test`
// com múltiplos arquivos paraleliza por padrão mesmo com --test-concurrency=1
// (a flag não garantiu isolamento completo entre arquivos nesta versão do
// Node), então a serialização é garantida aqui no nível de processo do SO.
//
// NODE_ENV=test é passado explicitamente pro ambiente de cada processo filho
// — segunda barreira, independente de _setup.mjs também definir isso; nenhum
// dos dois pontos deve ser a ÚNICA garantia.
import { execFileSync } from 'child_process'
import { readdirSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dir = path.join(__dirname, 'tests', 'collection')
const arquivos = readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort()

console.log(`[test:collection] ${arquivos.length} arquivo(s) de teste, execução sequencial (1 processo por vez):\n`)

let falhou = false
for (const arquivo of arquivos) {
  console.log(`\n=== ${arquivo} ===`)
  try {
    execFileSync('node', ['--test', path.join(dir, arquivo)], {
      stdio: 'inherit',
      env: { ...process.env, NODE_ENV: 'test' },
    })
  } catch {
    falhou = true
  }
}

process.exit(falhou ? 1 : 0)
