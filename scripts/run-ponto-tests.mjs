// npm run test:ponto — roda cada arquivo de teste do módulo "Meu Ponto" como
// processo `node` separado, um de cada vez (mesmo motivo de
// run-collection-tests.mjs: estado compartilhado no Postgres de teste,
// singleton ponto_config incluso). Usa o cluster isolado descrito em
// scripts/tests/ponto/_config.mjs — nunca o banco local compartilhado do
// resto do repo, nunca produção.
import { execFileSync } from 'child_process'
import { readdirSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dir = path.join(__dirname, 'tests', 'ponto')
const arquivos = readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort()

console.log(`[test:ponto] ${arquivos.length} arquivo(s) de teste, execução sequencial (1 processo por vez):\n`)

let falhou = false
for (const arquivo of arquivos) {
  console.log(`\n=== ${arquivo} ===`)
  try {
    // --experimental-test-module-mocks: usado só por
    // auditoria-adversarial-equipamento-http.test.mjs, para sobrescrever
    // EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA como `true` SÓ dentro daquele
    // processo isolado (nunca no arquivo real em disco), e assim exercitar
    // o código real da rota HTTP que fica atrás do gate. Passar a flag pra
    // todos os arquivos é inofensivo — ela só habilita uma API que os
    // outros arquivos nunca chamam.
    execFileSync('node', ['--experimental-test-module-mocks', '--test', path.join(dir, arquivo)], {
      stdio: 'inherit',
      env: { ...process.env, NODE_ENV: 'test' },
    })
  } catch {
    falhou = true
  }
}

process.exit(falhou ? 1 : 0)
