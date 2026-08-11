// FASE B.4 (homologação, 2026-08-11) — prova de que avaliarNbaShadow()
// (nextBestActionShadow.js) responde "qual seria a melhor ação com todos os
// canais disponíveis", SEM que as flags de execução (human_call_alerts/
// ai_voice_calls/ai_whatsapp) silenciem a recomendação — e que, ao mesmo
// tempo, decidirProximaAcao() (execução real) continua 100% obediente às
// mesmas flags, exatamente como antes desta mudança.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste, criarContaDeTeste } from './_setup.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

async function inserirScore(supabase, tabela, contasFinanceirasId, score) {
  const { error } = await supabase.from(tabela).insert({
    contas_financeiras_id: contasFinanceirasId, score, formula_version: 'teste', componentes: {}, explicacao: 'teste',
  })
  if (error) throw error
}

function diasAtras(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10)
}

test('NBA shadow canal-agnóstico: recomendação separada de capacidade de execução', async (t) => {
  const fakeEvolution = await iniciarAmbienteDeTeste()
  const { supabase } = await import('../../../src/lib/supabase-admin.server.js')
  const { avaliarNbaShadow } = await import('../../../src/lib/collection/nextBestActionShadow.js')
  const { decidirProximaAcao } = await import('../../../src/lib/collection/nextBestAction.js')
  const { invalidarCacheFlags } = await import('../../../src/lib/collection/featureFlags.js')

  async function setFlags(flags) {
    await supabase.from('automacoes_config').update(flags).eq('id', 1)
    invalidarCacheFlags()
  }

  // Tabelas collection_dispatches/collection_calls são compartilhadas com os
  // outros arquivos de teste da suíte (mesmo banco local) — contar linhas
  // globais seria falso positivo/negativo dependendo da ordem de execução dos
  // arquivos. Rastreia só os IDs criados NESTE arquivo, como já faz
  // fakeEvolution (isolado por processo, um processo por arquivo de teste).
  const contasCriadasNesteArquivo = []
  async function criarConta(overrides) {
    const conta = await criarContaDeTeste(supabase, overrides)
    contasCriadasNesteArquivo.push(conta.id)
    return conta
  }

  await t.test('1. human_call_alerts=false NÃO impede HUMAN_CALL na recomendação do SHADOW', async () => {
    const conta = await criarConta({ vencimento: diasAtras(35) }) // etapa 7
    await inserirScore(supabase, 'collection_priority_scores', conta.id, 85)
    await inserirScore(supabase, 'collection_recovery_scores', conta.id, 50)
    await setFlags({ human_call_alerts: false, ai_voice_calls: false, ai_whatsapp: false, cobranca_whatsapp_ativa: true })

    const shadow = await avaliarNbaShadow(conta.id)
    assert.equal(shadow.recommended_action, 'HUMAN_CALL', 'com todos os canais conceitualmente disponíveis, etapa>=7 + priority>=80 deveria recomendar HUMAN_CALL mesmo com a flag real desligada')
    assert.equal(shadow.execution_available, false)
    assert.equal(shadow.execution_block_reason, 'HUMAN_CALL_DISABLED')
  })

  await t.test('2. a MESMA flag (human_call_alerts=false) impede HUMAN_CALL na execução real', async () => {
    const conta = await criarConta( { vencimento: diasAtras(35) })
    await inserirScore(supabase, 'collection_priority_scores', conta.id, 85)
    await inserirScore(supabase, 'collection_recovery_scores', conta.id, 50)
    await setFlags({ human_call_alerts: false, ai_voice_calls: false, ai_whatsapp: false, cobranca_whatsapp_ativa: true })

    const real = await decidirProximaAcao(conta.id)
    assert.notEqual(real.acao, 'HUMAN_CALL', 'execução real nunca deveria escolher HUMAN_CALL com a flag desligada — comportamento inalterado por este trabalho')
    assert.equal(real.acao, 'WHATSAPP', 'sem nenhum canal condicional ligado, a execução real cai no fallback WHATSAPP, igual antes desta mudança')
  })

  await t.test('3. ai_voice_calls=false NÃO impede AI_CALL na recomendação do SHADOW', async () => {
    const conta = await criarConta( { vencimento: diasAtras(1) })
    await inserirScore(supabase, 'collection_priority_scores', conta.id, 65)
    await inserirScore(supabase, 'collection_recovery_scores', conta.id, 50)
    const { data: promessa } = await supabase.from('collection_promises').insert({
      contas_financeiras_id: conta.id, cliente_nome: conta.pessoa_nome, cliente_telefone: conta.telefone_cobranca,
      valor: 100, promised_date: diasAtras(1), origem: 'AUTOMATION', status: 'quebrada',
    }).select().single()
    assert.ok(promessa, 'pré-condição: promessa quebrada criada')
    await setFlags({ human_call_alerts: false, ai_voice_calls: false, ai_whatsapp: false, cobranca_whatsapp_ativa: true })

    const shadow = await avaliarNbaShadow(conta.id)
    assert.equal(shadow.recommended_action, 'AI_CALL', 'promessa quebrada + priority>=60 deveria recomendar AI_CALL mesmo com ai_voice_calls real desligada')
    assert.equal(shadow.execution_available, false)
    assert.equal(shadow.execution_block_reason, 'AI_VOICE_DISABLED')
  })

  await t.test('4. ai_voice_calls=false impede execução real de AI_CALL', async () => {
    const conta = await criarConta( { vencimento: diasAtras(1) })
    await inserirScore(supabase, 'collection_priority_scores', conta.id, 65)
    await inserirScore(supabase, 'collection_recovery_scores', conta.id, 50)
    await supabase.from('collection_promises').insert({
      contas_financeiras_id: conta.id, cliente_nome: conta.pessoa_nome, cliente_telefone: conta.telefone_cobranca,
      valor: 100, promised_date: diasAtras(1), origem: 'AUTOMATION', status: 'quebrada',
    })
    await setFlags({ human_call_alerts: false, ai_voice_calls: false, ai_whatsapp: false, cobranca_whatsapp_ativa: true })

    const real = await decidirProximaAcao(conta.id)
    assert.notEqual(real.acao, 'AI_CALL', 'execução real nunca deveria escolher AI_CALL com a flag desligada')
    assert.equal(real.acao, 'WHATSAPP')
  })

  await t.test('5. ai_whatsapp=false NÃO impede AI_WHATSAPP na recomendação do SHADOW', async () => {
    const conta = await criarConta( { vencimento: diasAtras(1) }) // etapa baixa, sem quebra, recovery ok
    await inserirScore(supabase, 'collection_priority_scores', conta.id, 40)
    await inserirScore(supabase, 'collection_recovery_scores', conta.id, 50)
    await setFlags({ human_call_alerts: false, ai_voice_calls: false, ai_whatsapp: false, cobranca_whatsapp_ativa: true })

    const shadow = await avaliarNbaShadow(conta.id)
    assert.equal(shadow.recommended_action, 'AI_WHATSAPP', 'sem nenhum dos 3 primeiros critérios (quebra/human_call/baixa recuperabilidade), o canal-agnóstico deveria recomendar AI_WHATSAPP')
    assert.equal(shadow.execution_available, false)
    assert.equal(shadow.execution_block_reason, 'AI_WHATSAPP_DISABLED')

    const real = await decidirProximaAcao(conta.id)
    assert.equal(real.acao, 'WHATSAPP', 'execução real com ai_whatsapp=false continua caindo no fallback WHATSAPP, como sempre')
  })

  await t.test('6. nenhuma recomendação shadow executa ação (estático + comportamental)', async () => {
    const conteudo = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'lib', 'collection', 'nextBestActionShadow.js'), 'utf8')
    assert.equal(/\.insert\(|\.update\(|\.delete\(|\.upsert\(/.test(conteudo), false, 'nextBestActionShadow.js não deveria conter nenhuma chamada de escrita — só leitura via carregarContextoNba/obterConfigCobranca')

    fakeEvolution.resetar()
    const conta = await criarConta( { vencimento: diasAtras(35) })
    await inserirScore(supabase, 'collection_priority_scores', conta.id, 85)
    await inserirScore(supabase, 'collection_recovery_scores', conta.id, 50)
    await setFlags({ human_call_alerts: false, ai_voice_calls: false, ai_whatsapp: false })

    const [antesDispatch, antesPromessas, antesConfig] = await Promise.all([
      supabase.from('collection_dispatches').select('id', { count: 'exact', head: true }),
      supabase.from('collection_promises').select('id', { count: 'exact', head: true }),
      supabase.from('automacoes_config').select('nba_shadow_mode, score_shadow_mode').eq('id', 1).single(),
    ])

    await avaliarNbaShadow(conta.id)
    await avaliarNbaShadow(conta.id) // chamado 2x — nenhuma escrita cumulativa esperada

    const [depoisDispatch, depoisPromessas, depoisConfig] = await Promise.all([
      supabase.from('collection_dispatches').select('id', { count: 'exact', head: true }),
      supabase.from('collection_promises').select('id', { count: 'exact', head: true }),
      supabase.from('automacoes_config').select('nba_shadow_mode, score_shadow_mode').eq('id', 1).single(),
    ])

    assert.equal(depoisDispatch.count, antesDispatch.count, 'avaliarNbaShadow nunca deveria criar um dispatch')
    assert.equal(depoisPromessas.count, antesPromessas.count, 'avaliarNbaShadow nunca deveria criar/alterar promessas')
    assert.deepEqual(depoisConfig.data, antesConfig.data, 'avaliarNbaShadow nunca deveria mudar flags')
    assert.equal(fakeEvolution.mensagensEnviadas.length, 0, 'avaliarNbaShadow nunca deveria enviar WhatsApp real')
  })

  await t.test('7. cliente pago (saldo zero) continua NO_ACTION no shadow, independente das flags', async () => {
    const conta = await criarConta( { valor: 500, valor_pago: 500 })
    await setFlags({ human_call_alerts: true, ai_voice_calls: true, ai_whatsapp: true })

    const shadow = await avaliarNbaShadow(conta.id)
    assert.equal(shadow.recommended_action, 'NO_ACTION')
    assert.deepEqual(shadow.reason_codes, ['TITULO_QUITADO'])
    assert.equal(shadow.execution_available, true)
    assert.equal(shadow.execution_block_reason, null)

    const real = await decidirProximaAcao(conta.id)
    assert.equal(real.acao, 'NO_ACTION')
  })

  await t.test('8. contestação (em_revisao_financeira=true) continua HUMAN_REVIEW no shadow', async () => {
    const conta = await criarConta( { em_revisao_financeira: true })
    await setFlags({ human_call_alerts: false, ai_voice_calls: false, ai_whatsapp: false })

    const shadow = await avaliarNbaShadow(conta.id)
    assert.equal(shadow.recommended_action, 'HUMAN_REVIEW')
    assert.deepEqual(shadow.reason_codes, ['EM_REVISAO_FINANCEIRA'])
    assert.equal(shadow.execution_available, true, 'HUMAN_REVIEW não depende de canal externo, não deveria ser bloqueada')

    const real = await decidirProximaAcao(conta.id)
    assert.equal(real.acao, 'HUMAN_REVIEW')
  })

  await t.test('9. opt-out (DNC) continua NO_ACTION no shadow', async () => {
    const conta = await criarConta( {})
    await supabase.from('collection_do_not_contact').insert({ cliente_telefone: conta.telefone_cobranca, canal: 'todos', motivo: 'teste' })
    await setFlags({ human_call_alerts: true, ai_voice_calls: true, ai_whatsapp: true })

    const shadow = await avaliarNbaShadow(conta.id)
    assert.equal(shadow.recommended_action, 'NO_ACTION')
    assert.deepEqual(shadow.reason_codes, ['OPT_OUT'])

    const real = await decidirProximaAcao(conta.id)
    assert.equal(real.acao, 'NO_ACTION')
    assert.deepEqual(real.reason_codes, ['OPT_OUT'])
  })

  await t.test('10. nenhuma ação externa em nenhum cenário acima (WhatsApp real, ligação, IA)', async () => {
    // Os 9 subtestes anteriores já cobriram HUMAN_CALL/AI_CALL/AI_WHATSAPP/
    // WHATSAPP/NO_ACTION/HUMAN_REVIEW recomendados pelo shadow — nenhum deles
    // deveria ter deixado rastro de execução real em nenhum momento da suíte.
    assert.equal(fakeEvolution.mensagensEnviadas.length, 0, 'nenhuma mensagem real deveria ter saído durante toda a suíte de canal-agnóstico')
    // Filtra pelas contas criadas NESTE arquivo — collection_dispatches/
    // collection_calls são compartilhadas com outros arquivos da suíte
    // (mesmo banco local), então uma contagem global daria falso positivo
    // dependendo da ordem de execução dos arquivos.
    const { data: dispatches } = await supabase.from('collection_dispatches').select('id').in('contas_financeiras_id', contasCriadasNesteArquivo)
    assert.equal((dispatches ?? []).length, 0, 'nenhum dispatch real deveria existir para as contas usadas nesta suíte')
    const { data: calls } = await supabase.from('collection_calls').select('id').in('contas_financeiras_id', contasCriadasNesteArquivo)
    assert.equal((calls ?? []).length, 0, 'nenhuma ligação (humana ou IA) deveria ter sido registrada como executada')
  })

  await setFlags({ human_call_alerts: false, ai_voice_calls: false, ai_whatsapp: false, nba_shadow_mode: false, score_shadow_mode: false })
  await pararAmbienteDeTeste()
})
