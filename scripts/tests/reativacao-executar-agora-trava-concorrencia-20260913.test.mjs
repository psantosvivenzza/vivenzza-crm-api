// Achado (auditoria de rate limit/abuso em mutações, 2026-09-13): POST
// /api/reativacao/executar-agora disparava verificarElegiveis() em background
// sem NENHUMA trava de reentrância — um duplo clique no botão "Executar agora",
// um retry de rede do frontend, ou o disparo manual coincidindo com o cron
// diário das 09:00 (mesmo arquivo, mesma função) rodavam duas execuções em
// paralelo. MAX_ENVIOS_POR_DIA e o circuito de entrega (ver comentário do
// incidente de 2026-08-04 em src/routes/reativacao.js) são contados
// por-execução — duas execuções simultâneas dobrariam o volume real de
// mensagens no dia e podiam mandar a mesma mensagem duas vezes pro mesmo lead,
// o mesmo tipo de rajada que já derrubou a taxa de entrega do número comercial
// de ~90% pra ~25% em 2026-08-04.
//
// Fora de escopo desta correção (não tocado): PRs #86/#87 (rate limit em
// auth/ponto), #88-#93 (auth.js/leads.js/contatos.js/pedidos.js/index.js),
// módulo Meu Ponto, módulo Financeiro, arquitetura de JWT, e a lógica de
// negócio de verificarElegiveis em si (ritmo de envio, opt-out, circuito de
// entrega) — só a ausência de trava de reentrância no disparo.
//
// LOCAL_PG_URL precisa existir ANTES de qualquer import de código de produção
// (supabase-admin.server.js decide client real vs. local na primeira
// importação e recusa cair pro Supabase real quando NODE_ENV=test sem
// LOCAL_PG_URL — ver src/lib/supabase-admin.server.js). Imports estáticos são
// hoisted e avaliados antes do corpo deste módulo — por isso reativacao.js
// (que importa supabase-admin.server.js) só pode ser importado dinamicamente,
// depois de setar as env vars abaixo (mesma técnica de _setup.mjs).
import { PG_USER, PG_PASSWORD, PG_PORT, PG_DATABASE } from '../localdb-config.mjs'

process.env.NODE_ENV = 'test'
process.env.LOCAL_PG_URL = `postgres://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${PG_DATABASE}`

import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
const {
  default: reativacaoRouter,
  tentarIniciarExecucao,
  finalizarExecucao,
} = await import('../../src/routes/reativacao.js')

function montarApp() {
  const app = express()
  app.use(express.json())
  // auth/adminOnly são aplicados no mount de src/index.js, fora deste router —
  // não fazem parte do achado (rate limit/abuso), então não são simulados aqui.
  app.use('/api/reativacao', reativacaoRouter)
  return app
}

test('reativacao: trava de reentrância em POST /executar-agora', async (t) => {
  const app = montarApp()
  const server = app.listen(0)
  const base = `http://127.0.0.1:${server.address().port}`

  await t.test('tentarIniciarExecucao()/finalizarExecucao() — a trava em si é exclusiva', () => {
    assert.equal(tentarIniciarExecucao(), true, 'primeira tentativa deve conseguir a trava')
    assert.equal(tentarIniciarExecucao(), false, 'segunda tentativa concorrente deve ser recusada')
    finalizarExecucao()
    assert.equal(tentarIniciarExecucao(), true, 'após liberar, uma nova tentativa deve conseguir a trava')
    finalizarExecucao()
  })

  await t.test('POST /executar-agora responde 409 quando já existe execução em andamento (ex: cron diário already running)', async () => {
    assert.equal(tentarIniciarExecucao(), true, 'simula uma execução já em andamento (manual ou cron)')
    try {
      const res = await fetch(`${base}/api/reativacao/executar-agora`, { method: 'POST' })
      assert.equal(res.status, 409)
      const body = await res.json()
      assert.match(body.erro, /já existe uma execução/i)
    } finally {
      finalizarExecucao()
    }
  })

  await t.test('POST /executar-agora aceita (200) quando a trava está livre, e a segunda chamada concorrente é recusada (409)', async () => {
    const [primeira, segunda] = await Promise.all([
      fetch(`${base}/api/reativacao/executar-agora`, { method: 'POST' }),
      fetch(`${base}/api/reativacao/executar-agora`, { method: 'POST' }),
    ])
    const statuses = [primeira.status, segunda.status].sort()
    // Não depende de qual das duas chega primeiro — exatamente uma é aceita (200)
    // e a outra é recusada (409) porque a primeira já segurou a trava
    // sincronamente antes de qualquer await.
    assert.deepEqual(statuses, [200, 409], 'exatamente uma requisição concorrente deve ser aceita, a outra recusada')

    const aceita = primeira.status === 200 ? primeira : segunda
    const aceitaBody = await aceita.json()
    assert.deepEqual(aceitaBody, { sucesso: true, iniciado: true })
  })

  // Dá tempo do job em background (verificarElegiveis, que falha rápido no
  // schema de teste local por colunas de reativação ausentes no baseline —
  // mesmo tipo de gap de baseline já documentado para outras tabelas nesta
  // auditoria, não uma regressão desta correção) terminar e liberar a trava
  // antes de fechar o servidor.
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(tentarIniciarExecucao(), true, 'trava deve ter sido liberada após a execução em background terminar')
  finalizarExecucao()

  await new Promise((resolve) => server.close(resolve))
})
