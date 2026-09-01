// 2026-09-01 — pedido "FECHAR CICLO DE VIDA DE PAGAMENTOS E PROMESSAS": prova
// que os dois jobs estão REALMENTE registrados no scheduler, não só que as
// funções existem isoladamente (achado real da tarefa anterior: paymentGuard/
// promises tinham código funcional testável, mas nenhum cron os chamava —
// exatamente o tipo de gap que só uma prova estrutural contra src/index.js
// pega, testar a função isolada não pegaria).
//
// Mesmo padrão de "prova estática" já usado em collectionGuardsForVoice.js
// (auditoria 2026-08-28) — lê o código-fonte real de src/index.js e confirma
// import + cron.schedule apontando pra cada job, sem subir o servidor
// Express inteiro (index.js tem efeitos colaterais globais — app.listen,
// outros crons reais — não é seguro importar em teste).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste } from './_setup.mjs'

const INDEX_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/index.js')

test('scheduler: payment-reconciliation-sweep e promise-expiry-sweep estão registrados em src/index.js', async (t) => {
  // Só o teste 6 precisa de DB (importa os jobs, que importam supabase-admin.server.js
  // no topo do módulo) — os testes 1-5 são puramente estáticos (leitura de texto).
  await iniciarAmbienteDeTeste()
  const codigo = readFileSync(INDEX_PATH, 'utf8')

  await t.test('1. runPaymentReconciliationSweep é importado de payment-reconciliation-sweep.js', () => {
    assert.match(codigo, /import\s*\{\s*runPaymentReconciliationSweep\s*\}\s*from\s*['"]\.\/jobs\/payment-reconciliation-sweep\.js['"]/)
  })

  await t.test('2. runPromiseExpirySweep é importado de promise-expiry-sweep.js', () => {
    assert.match(codigo, /import\s*\{\s*runPromiseExpirySweep\s*\}\s*from\s*['"]\.\/jobs\/promise-expiry-sweep\.js['"]/)
  })

  await t.test('3. existe um cron.schedule(...) cujo corpo chama runPaymentReconciliationSweep()', () => {
    assert.match(codigo, /cron\.schedule\(\s*['"][^'"]+['"]\s*,\s*async\s*\(\)\s*=>\s*\{[\s\S]{0,300}?runPaymentReconciliationSweep\(\)/)
  })

  await t.test('4. existe um cron.schedule(...) cujo corpo chama runPromiseExpirySweep()', () => {
    assert.match(codigo, /cron\.schedule\(\s*['"][^'"]+['"]\s*,\s*async\s*\(\)\s*=>\s*\{[\s\S]{0,300}?runPromiseExpirySweep\(\)/)
  })

  await t.test('5. cada cron chamador está dentro de try/catch (mesmo padrão dos demais crons do arquivo — erro de 1 job nunca derruba o processo)', () => {
    const blocoSweep = codigo.match(/cron\.schedule\(\s*['"][^'"]+['"]\s*,\s*async\s*\(\)\s*=>\s*\{[\s\S]{0,400}?runPaymentReconciliationSweep\(\)[\s\S]{0,200}?\}\)/)
    assert.ok(blocoSweep, 'bloco do cron de payment-reconciliation-sweep não encontrado')
    assert.match(blocoSweep[0], /try\s*\{/)
    assert.match(blocoSweep[0], /catch\s*\(/)

    const blocoPromise = codigo.match(/cron\.schedule\(\s*['"][^'"]+['"]\s*,\s*async\s*\(\)\s*=>\s*\{[\s\S]{0,400}?runPromiseExpirySweep\(\)[\s\S]{0,200}?\}\)/)
    assert.ok(blocoPromise, 'bloco do cron de promise-expiry-sweep não encontrado')
    assert.match(blocoPromise[0], /try\s*\{/)
    assert.match(blocoPromise[0], /catch\s*\(/)
  })

  await t.test('6. os dois jobs em si existem e exportam a função esperada (sem subir index.js)', async () => {
    const { runPaymentReconciliationSweep } = await import('../../../src/jobs/payment-reconciliation-sweep.js')
    const { runPromiseExpirySweep } = await import('../../../src/jobs/promise-expiry-sweep.js')
    assert.equal(typeof runPaymentReconciliationSweep, 'function')
    assert.equal(typeof runPromiseExpirySweep, 'function')
  })

  await pararAmbienteDeTeste()
})
