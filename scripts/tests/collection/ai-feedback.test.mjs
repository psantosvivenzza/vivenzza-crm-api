// IA WhatsApp MVP — feedback supervisionado (approved/edited/discarded).
// suggested_reply original NUNCA é sobrescrito; feedback nunca envia
// WhatsApp, nunca cria cobrança, nunca altera financeiro — só registra a
// decisão do operador.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import http from 'http'
import { fileURLToPath } from 'url'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste, criarContaDeTeste } from './_setup.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(__dirname, '..', '..', '..', 'src')

process.env.AI_PROVIDER = 'mock'

test('Feedback supervisionado: approved/edited/discarded (código real, Postgres local)', async (t) => {
  await iniciarAmbienteDeTeste()
  const { supabase } = await import('../../../src/lib/supabase-admin.server.js')
  const { sugerirRespostaCliente } = await import('../../../src/lib/collection/ai/replySuggestion.js')
  const { registrarFeedback, buscarSugestao } = await import('../../../src/lib/collection/ai/shadowSuggestions.js')

  async function novaSugestao(mensagem) {
    const conta = await criarContaDeTeste(supabase)
    return sugerirRespostaCliente({ contasFinanceirasId: conta.id, clienteTelefone: conta.telefone_cobranca, mensagemCliente: mensagem })
  }

  await t.test('A. approved -> feedback_status=approved, feedback_by/feedback_at gravados, final_reply_operator null', async () => {
    const sugestao = await novaSugestao('quero pagar')
    const atualizado = await registrarFeedback(sugestao.id, { action: 'approved', feedbackBy: null })

    assert.equal(atualizado.feedback_status, 'approved')
    assert.ok(atualizado.feedback_at)
    assert.equal(atualizado.final_reply_operator, null)
    assert.equal(atualizado.suggested_reply, sugestao.suggested_reply, 'suggested_reply original preservado')
  })

  await t.test('B. edited -> suggested_reply original preservado, final_reply_operator = texto do operador', async () => {
    const sugestao = await novaSugestao('manda o pix')
    const textoOriginal = sugestao.suggested_reply
    const atualizado = await registrarFeedback(sugestao.id, { action: 'edited', finalReply: 'Segue o PIX corrigido pelo operador.', feedbackBy: null })

    assert.equal(atualizado.feedback_status, 'edited')
    assert.equal(atualizado.suggested_reply, textoOriginal, 'original NUNCA é sobrescrito')
    assert.equal(atualizado.final_reply_operator, 'Segue o PIX corrigido pelo operador.')
  })

  await t.test('C. discarded -> feedback_status=discarded, sugestão original continua intacta (nunca apagada)', async () => {
    const sugestao = await novaSugestao('esse valor está errado')
    const atualizado = await registrarFeedback(sugestao.id, { action: 'discarded', feedbackBy: null })

    assert.equal(atualizado.feedback_status, 'discarded')
    assert.equal(atualizado.final_reply_operator, null)
    const releida = await buscarSugestao(sugestao.id)
    assert.ok(releida, 'sugestão original nunca deveria ser apagada')
    assert.equal(releida.intent, 'CONTESTA_VALOR')
  })

  await t.test('D. edited sem final_reply -> rejeitado', async () => {
    const sugestao = await novaSugestao('já paguei')
    await assert.rejects(() => registrarFeedback(sugestao.id, { action: 'edited', finalReply: '', feedbackBy: null }))
    await assert.rejects(() => registrarFeedback(sugestao.id, { action: 'edited', feedbackBy: null }))
  })

  await t.test('E. action inválida -> rejeitado', async () => {
    const sugestao = await novaSugestao('quero falar com alguém')
    await assert.rejects(() => registrarFeedback(sugestao.id, { action: 'aprovado_errado', feedbackBy: null }))
  })

  await t.test('F. Feedback nunca cria dispatch/cobrança/promessa real, nem em approved nem em edited', async () => {
    const conta = await criarContaDeTeste(supabase)
    const sugestao = await sugerirRespostaCliente({ contasFinanceirasId: conta.id, clienteTelefone: conta.telefone_cobranca, mensagemCliente: 'vou pagar sexta' })
    await registrarFeedback(sugestao.id, { action: 'edited', finalReply: 'Combinado, aguardamos até sexta.', feedbackBy: null })

    const { data: dispatches } = await supabase.from('collection_dispatches').select('id').eq('contas_financeiras_id', conta.id)
    const { data: promessasReais } = await supabase.from('collection_promises').select('id').eq('contas_financeiras_id', conta.id)
    const { data: cobrancasLegado } = await supabase.from('cobrancas_whatsapp').select('id').eq('contas_financeiras_id', conta.id)
    assert.equal(dispatches.length, 0)
    assert.equal(promessasReais.length, 0)
    assert.equal(cobrancasLegado.length, 0)
  })

  await pararAmbienteDeTeste()
})

test('Feedback: rota HTTP exige autenticação (servidor local mínimo, mesma cadeia auth+adminOnly da produção)', async (t) => {
  process.env.API_SECRET_KEY = 'chave-de-teste-feedback-http'
  const express = (await import('express')).default
  const { auth, adminOnly } = await import('../../../src/middleware/auth.js')
  const aiSuggestionsRouter = (await import('../../../src/routes/ai-suggestions.js')).default

  const app = express()
  app.use(express.json())
  app.use('/api/ai-suggestions', auth, adminOnly, aiSuggestionsRouter)

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const porta = server.address().port

  function post(pathname, { headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null
      const req = http.request({ host: '127.0.0.1', port: porta, path: pathname, method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
        let chunks = ''
        res.on('data', (c) => { chunks += c })
        res.on('end', () => resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null }))
      })
      req.on('error', reject)
      if (data) req.write(data)
      req.end()
    })
  }

  await t.test('G. Sem Authorization -> 401', async () => {
    const r = await post('/api/ai-suggestions/00000000-0000-0000-0000-000000000000/feedback', { body: { action: 'approved' } })
    assert.equal(r.status, 401)
  })

  await t.test('H. Authorization inválida -> 401', async () => {
    const r = await post('/api/ai-suggestions/00000000-0000-0000-0000-000000000000/feedback', { headers: { authorization: 'Bearer token-errado' }, body: { action: 'approved' } })
    assert.equal(r.status, 401)
  })

  await t.test('I. Authorization válida, sugestão inexistente -> 404 (nunca 500 mascarando auth)', async () => {
    const r = await post('/api/ai-suggestions/00000000-0000-0000-0000-000000000000/feedback', { headers: { authorization: 'Bearer chave-de-teste-feedback-http' }, body: { action: 'approved' } })
    assert.equal(r.status, 404)
  })

  await new Promise((resolve) => server.close(resolve))
  delete process.env.API_SECRET_KEY
})

test('IA feedback: prova estática — sem Evolution, sem SQL arbitrário, sem mutação financeira', () => {
  const arquivos = ['routes/ai-suggestions.js', 'lib/collection/ai/shadowSuggestions.js']
  for (const rel of arquivos) {
    const conteudo = fs.readFileSync(path.join(SRC, rel), 'utf8')
    for (const proibido of ['evolutionAdapter', 'evolutionFinanceiro', 'sendText', '.rpc(', 'execute_sql', "from('contas_financeiras')", "from('collection_promises')", "from('collection_dispatches')"]) {
      assert.equal(conteudo.includes(proibido), false, `${rel} não deveria referenciar "${proibido}"`)
    }
  }
})
