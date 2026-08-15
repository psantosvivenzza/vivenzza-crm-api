// 2026-08-15 — effective_legacy_action / blocked_reason no nba_shadow_log.
// legacy_action (já existia) é a régua ANTES dos guards reais de
// elegibilidade — comparar isso direto com nba_suggested_action é injusto,
// porque o NBA SEMPRE passa pelos mesmos guards (carregarContextoNba,
// nextBestAction.js:105-149) antes de sugerir uma ação. effective_legacy_action
// é a régua DEPOIS desses guards — a métrica operacionalmente justa.
//
// Não duplica regra: effective_legacy_action é derivado do MESMO
// contexto.encerrado que decidirProximaAcao() já usa (nextBestAction.js) —
// se um guard mudar de comportamento lá, muda aqui automaticamente, sem
// precisar editar collection-shadow.js.
//
// "pago" e "cancelado" (cenários 3/4) não têm como ser provados de ponta a
// ponta via runCollectionShadow(): a própria query de elegibilidade do
// shadow (shadowReadRepository.js:18, status IN aberta/vencida/pago_parcial)
// já exclui título cancelado, e o loop de collection-shadow.js já pula saldo
// <= 0 ANTES de chegar no bloco de NBA (nunca grava nba_shadow_log pra esses
// casos — sempre foi assim, não mudou nesta PR). Testados direto contra
// carregarContextoNba(), a mesma função que alimentaria effective_legacy_action
// se a conta chegasse até lá.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste, criarContaDeTeste } from './_setup.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function hojeISO() {
  return new Date().toISOString().slice(0, 10)
}

test('effective_legacy_action: régua depois dos guards reais, comparação justa com o NBA', async (t) => {
  await iniciarAmbienteDeTeste()
  const { supabase } = await import('../../../src/lib/supabase-admin.server.js')
  const { runCollectionShadow } = await import('../../../src/jobs/collection-shadow.js')
  const { carregarContextoNba, decidirProximaAcao } = await import('../../../src/lib/collection/nextBestAction.js')
  const { registrarPromessa } = await import('../../../src/lib/collection/promises.js')
  const { invalidarCacheFlags } = await import('../../../src/lib/collection/featureFlags.js')

  async function setFlags(flags) {
    await supabase.from('automacoes_config').update(flags).eq('id', 1)
    invalidarCacheFlags()
  }

  async function rodarShadowPara(contaId) {
    await setFlags({ nba_shadow_mode: true, score_shadow_mode: false, shadow_max_customers: 1000 })
    await runCollectionShadow()
    const { data } = await supabase.from('nba_shadow_log').select('*').eq('contas_financeiras_id', contaId).order('criado_em', { ascending: false }).limit(1).maybeSingle()
    await setFlags({ nba_shadow_mode: false, score_shadow_mode: false, shadow_max_customers: 50 })
    return data
  }

  // Tabelas collection_dispatches/cobrancas_whatsapp são compartilhadas com
  // os outros arquivos de teste da suíte (mesmo banco local, nunca resetado
  // entre arquivos — ver scripts/run-collection-tests.mjs) — contar linhas
  // GLOBAIS no cenário 9/10 seria falso positivo dependendo da ordem de
  // execução. Rastreia só os IDs criados NESTE arquivo.
  const contasCriadasNesteArquivo = []
  async function criarConta(overrides) {
    const conta = await criarContaDeTeste(supabase, overrides)
    contasCriadasNesteArquivo.push(conta.id)
    return conta
  }

  await t.test('1. título normal: legacy_action=WHATSAPP, effective_legacy_action=WHATSAPP, blocked_reason=null', async () => {
    const conta = await criarConta({ vencimento: hojeISO(), status: 'vencida' }) // etapa 2
    const log = await rodarShadowPara(conta.id)
    assert.ok(log, 'deveria ter gravado a decisão NBA')
    assert.equal(log.legacy_action, 'WHATSAPP')
    assert.equal(log.effective_legacy_action, 'WHATSAPP')
    assert.equal(log.blocked_reason, null)
  })

  await t.test('2. em revisão financeira: legacy_action=WHATSAPP, effective_legacy_action=NO_ACTION, blocked_reason=EM_REVISAO_FINANCEIRA', async () => {
    const conta = await criarConta({ vencimento: hojeISO(), status: 'vencida', em_revisao_financeira: true })
    const log = await rodarShadowPara(conta.id)
    assert.ok(log)
    assert.equal(log.legacy_action, 'WHATSAPP', 'legacy_action continua pré-guards — não muda com esta PR')
    assert.equal(log.effective_legacy_action, 'NO_ACTION')
    assert.equal(log.blocked_reason, 'EM_REVISAO_FINANCEIRA')
    assert.equal(log.nba_suggested_action, 'HUMAN_REVIEW', 'NBA já chegava nisso antes — agora effective_legacy_action confirma que é o mesmo guard, não modelagem divergente')
  })

  await t.test('3. pago (saldo<=0): guard chain resolveria effective_legacy_action=NO_ACTION/TITULO_QUITADO — verificado direto em carregarContextoNba (nunca chega a nba_shadow_log, filtrado antes, sem mudança desta PR)', async () => {
    const conta = await criarConta({ vencimento: hojeISO(), status: 'vencida', valor: 500, valor_pago: 500 })
    const contexto = await carregarContextoNba(conta.id)
    assert.ok(contexto.encerrado)
    assert.equal(contexto.encerrado.acao, 'NO_ACTION')
    assert.deepEqual(contexto.encerrado.reason_codes, ['TITULO_QUITADO'])

    await setFlags({ nba_shadow_mode: true, score_shadow_mode: false, shadow_max_customers: 1000 })
    await runCollectionShadow()
    const { data: log } = await supabase.from('nba_shadow_log').select('id').eq('contas_financeiras_id', conta.id).maybeSingle()
    assert.equal(log, null, 'título quitado nunca é elegível no shadow — comportamento pré-existente, não mudou aqui')
    await setFlags({ nba_shadow_mode: false, score_shadow_mode: false, shadow_max_customers: 50 })
  })

  await t.test('4. cancelado: guard chain resolveria effective_legacy_action=NO_ACTION/TITULO_CANCELADO — verificado direto em carregarContextoNba (status cancelada nunca é elegível no shadow, sem mudança desta PR)', async () => {
    const conta = await criarConta({ vencimento: hojeISO(), status: 'vencida' })
    await supabase.from('contas_financeiras').update({ status: 'cancelada' }).eq('id', conta.id)
    const contexto = await carregarContextoNba(conta.id)
    assert.ok(contexto.encerrado)
    assert.equal(contexto.encerrado.acao, 'NO_ACTION')
    assert.deepEqual(contexto.encerrado.reason_codes, ['TITULO_CANCELADO'])

    await setFlags({ nba_shadow_mode: true, score_shadow_mode: false, shadow_max_customers: 1000 })
    await runCollectionShadow()
    const { data: log } = await supabase.from('nba_shadow_log').select('id').eq('contas_financeiras_id', conta.id).maybeSingle()
    assert.equal(log, null, 'título cancelada não passa em status IN (aberta,vencida,pago_parcial) da query de elegibilidade — comportamento pré-existente')
    await setFlags({ nba_shadow_mode: false, score_shadow_mode: false, shadow_max_customers: 50 })
  })

  await t.test('5. promessa ativa: effective_legacy_action=WAIT_PROMISE, blocked_reason=PROMESSA_ATIVA', async () => {
    const conta = await criarConta({ vencimento: hojeISO(), status: 'vencida' })
    await registrarPromessa({
      contasFinanceirasId: conta.id, clienteNome: conta.pessoa_nome, clienteTelefone: conta.telefone_cobranca,
      valor: 500, promisedDate: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10), origem: 'HUMAN',
    })
    const log = await rodarShadowPara(conta.id)
    assert.ok(log)
    assert.equal(log.legacy_action, 'WHATSAPP')
    assert.equal(log.effective_legacy_action, 'WAIT_PROMISE')
    assert.equal(log.blocked_reason, 'PROMESSA_ATIVA')
  })

  await t.test('6. DNC (opt-out): effective_legacy_action=NO_ACTION, blocked_reason=OPT_OUT', async () => {
    const conta = await criarConta({ vencimento: hojeISO(), status: 'vencida' })
    await supabase.from('collection_do_not_contact').insert({ cliente_telefone: conta.telefone_cobranca, canal: 'todos', motivo: 'teste' })
    const log = await rodarShadowPara(conta.id)
    assert.ok(log)
    assert.equal(log.legacy_action, 'WHATSAPP')
    assert.equal(log.effective_legacy_action, 'NO_ACTION')
    assert.equal(log.blocked_reason, 'OPT_OUT')
  })

  await t.test('7. financialSyncGuard stale não altera effective_legacy_action individual — collection-shadow.js nunca importa financialSyncGuard.js (garantia estrutural, não só de runtime)', async () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../src/jobs/collection-shadow.js'), 'utf8')
    assert.ok(!/financialSyncGuard|verificarFrescorSync/.test(src), 'shadow não pode depender do gate de frescor do sync — é global/operacional, não decisão por cliente')
  })

  await t.test('8. rate limit não altera effective_legacy_action individual — collection-shadow.js nunca importa globalSendLimit.js', async () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../src/jobs/collection-shadow.js'), 'utf8')
    assert.ok(!/globalSendLimit|verificarLimiteGlobalEnvio/.test(src), 'shadow não pode depender do teto global de envio — é operacional, não decisão por cliente')
  })

  await t.test('9. shadow continua criando 0 dispatches / 10. enviando 0 WhatsApps mesmo processando os 6 cenários acima', async () => {
    const { data: dispatches } = await supabase.from('collection_dispatches').select('id').in('contas_financeiras_id', contasCriadasNesteArquivo)
    const { data: envios } = await supabase.from('cobrancas_whatsapp').select('id').in('contas_financeiras_id', contasCriadasNesteArquivo)
    assert.equal(dispatches?.length ?? 0, 0, 'nenhum dos títulos deste arquivo deveria ter gerado um collection_dispatches')
    assert.equal(envios?.length ?? 0, 0, 'nenhum dos títulos deste arquivo deveria ter gerado um cobrancas_whatsapp')
  })

  await t.test('11. cobrança real permanece byte-a-byte igual: decidirProximaAcao(id) sem o novo 2º argumento continua idêntico a antes desta PR', async () => {
    const conta = await criarConta({ vencimento: hojeISO(), status: 'vencida', em_revisao_financeira: true })

    // Caminho ANTIGO (chamada real, sem contexto injetado — o único jeito que
    // decidirProximaAcao() era chamada em produção antes desta PR).
    const semInjecao = await decidirProximaAcao(conta.id)

    // Caminho NOVO usado só pelo shadow (contexto pré-carregado e injetado).
    const contexto = await carregarContextoNba(conta.id)
    const comInjecao = await decidirProximaAcao(conta.id, { contexto })

    assert.deepEqual(semInjecao, comInjecao, 'passar o contexto pré-carregado não pode mudar o resultado — mesma árvore de decisão, mesmos guards')
    assert.equal(semInjecao.acao, 'HUMAN_REVIEW')
  })

  await pararAmbienteDeTeste()
})
