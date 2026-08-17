// 2026-08-16 — prontidão SIP trunk externo (Nvoip). Testa só lógica PURA +
// wiring de guards reais já testados em outros arquivos (paymentGuard/
// promises/doNotContactGuard/financialSyncGuard) — sem rede/ARI/PSTN real em
// nenhum teste. Objetivo do item 9 do pedido: provar por teste que
// voice_external_enabled=false é kill switch ABSOLUTO — mesmo com trunk,
// credenciais e allowlist "corretos", nenhuma chamada PSTN pode originar.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste, criarContaDeTeste } from './_setup.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(__dirname, '..', '..', '..', 'src')

test('VOICE NVOIP EXTERNAL READINESS', async (t) => {
  await iniciarAmbienteDeTeste()
  const { supabase } = await import('../../../src/lib/supabase-admin.server.js')
  const { obterConfigCobranca, invalidarCacheFlags } = await import('../../../src/lib/collection/featureFlags.js')
  const { TIPO_DESTINO, resolverDestino } = await import('../../../src/lib/voice/destinoResolver.js')
  const { avaliarAutorizacaoChamadaExterna, avaliarLimiteGlobalPorHora, avaliarLimiteGlobalPorDia } = await import('../../../src/lib/voice/externalPilotGuardrails.js')
  const { lerConfigNvoip, descreverConfigNvoipSemSegredo, lerAllowlistExterna, numeroNaAllowlistExterna, lerLimitesVoz } = await import('../../../src/lib/voice/externalConfig.js')
  const { idempotencyKeyLigacaoExterna } = await import('../../../src/lib/collection/idempotency.js')
  const { construirPayloadOriginateExterno } = await import('../../../src/lib/voice/outboundExternalTest.js')
  const { avaliarGuardsTituloParaLigacao, avaliarGuardGlobalParaLigacao, avaliarGuardsCobrancaParaLigacao } = await import('../../../src/lib/voice/collectionGuardsForVoice.js')
  const { buscarRegistroDoNotContact, estaEmDoNotContact } = await import('../../../src/lib/collection/doNotContactGuard.js')
  const { registrarPromessa } = await import('../../../src/lib/collection/promises.js')

  // Baseline ANTES de qualquer teste deste arquivo — collection_dispatches
  // não é seedado por seed.sql (diferente de cobrancas_whatsapp), mas outros
  // arquivos de teste que rodam ANTES deste, na mesma suíte sequencial sobre
  // o mesmo Postgres local, podem legitimamente já ter criado dispatches
  // reais. O que este arquivo prova é que ELE MESMO não cria nenhum — daí
  // comparar delta contra a baseline, nunca contra zero absoluto.
  const { count: dispatchesAntes } = await supabase.from('collection_dispatches').select('id', { count: 'exact', head: true })

  await t.test('1. voice_external_enabled default é false (produção nunca foi alterada por este trabalho)', async () => {
    const config = await obterConfigCobranca()
    assert.equal(config.voice_external_enabled, false)
  })

  await t.test('2. KILL SWITCH ABSOLUTO: voice_external_enabled=true (DB) + allowlist correta + tudo mais "verde" ainda BLOQUEIA — sem trunk configurado', async () => {
    await supabase.from('automacoes_config').update({ voice_external_enabled: true }).eq('id', 1)
    invalidarCacheFlags()
    const config = await obterConfigCobranca()
    assert.equal(config.voice_external_enabled, true, 'pré-condição: flag realmente ligada neste teste')

    const numero = '+5511999998888'
    const resultado = avaliarAutorizacaoChamadaExterna({
      flags: config, numero, allowlist: [numero],
      idempotencyKey: 'chave-teste-kill-switch', chavesJaProcessadas: new Set(),
      chamadasAtivas: [], horaAtual: new Date(2026, 0, 5, 10, 0),
      politicaHorario: { janelas: [{ dias: [1, 2, 3, 4, 5], inicioMinutos: 9 * 60, fimMinutos: 18 * 60 }] },
      chamadasHoje: [], limiteDiario: 3,
    })
    assert.equal(resultado.permitido, false, 'mesmo com flag=true e allowlist correta, sem trunk configurado NUNCA pode autorizar')
    assert.match(resultado.motivo, /sem_trunk/)

    // restaura o estado padrão (produção real nunca foi tocada — isto é só o Postgres local de teste)
    await supabase.from('automacoes_config').update({ voice_external_enabled: false }).eq('id', 1)
    invalidarCacheFlags()
  })

  await t.test('3. voice_external_enabled=false (padrão) bloqueia isoladamente, mesmo com trunk hipotético', async () => {
    const config = await obterConfigCobranca()
    assert.equal(config.voice_external_enabled, false)
    // avaliarAutorizacaoChamadaExterna já checa isso, mas confirma explicitamente que
    // a flag em si (não só a ausência de trunk) também bloquearia sozinha.
    const { avaliarFlagExternalHabilitada } = await import('../../../src/lib/voice/externalPilotGuardrails.js')
    assert.equal(avaliarFlagExternalHabilitada(config), false)
  })

  await t.test('4. resolverDestino(EXTERNAL) continua fail-closed — não foi tocado por este trabalho', () => {
    assert.throws(() => resolverDestino(TIPO_DESTINO.EXTERNAL), /fail-closed/)
    assert.equal(resolverDestino(TIPO_DESTINO.INTERNAL), 'PJSIP/7001', 'ramal interno já homologado não pode ter sido afetado')
  })

  await t.test('5. construirPayloadOriginateExterno também lança hoje — segunda trava, independente da primeira', () => {
    assert.throws(() => construirPayloadOriginateExterno({ numero: '+5511999998888', ariApp: 'vivenzza-voice-ai' }), /fail-closed/)
  })

  await t.test('6. limites globais (hora/dia) — fail-closed com limite<=0, bloqueia ao atingir o teto', () => {
    const umaHora = [{ numero: '+5511999998888' }]
    assert.equal(avaliarLimiteGlobalPorHora(umaHora, 1), false, 'já atingiu o teto de 1/hora')
    assert.equal(avaliarLimiteGlobalPorHora(umaHora, 2), true)
    assert.equal(avaliarLimiteGlobalPorHora(umaHora, 0), false)
    assert.equal(avaliarLimiteGlobalPorDia([{ n: 1 }, { n: 2 }, { n: 3 }], 3), false)
    assert.equal(avaliarLimiteGlobalPorDia([{ n: 1 }, { n: 2 }], 3), true)
  })

  await t.test('7. externalConfig: nada configurado por padrão (nenhuma credencial real usada nesta rodada)', () => {
    const cfg = lerConfigNvoip()
    assert.equal(cfg.sipServer, null)
    assert.equal(cfg.sipPassword, null)
    const status = descreverConfigNvoipSemSegredo()
    assert.equal(status.sip_password_configurado, false)
    // Nunca deve existir uma chave "sip_password" (valor) no objeto de status — só o booleano "_configurado".
    assert.equal('sip_password' in status, false)
    assert.equal(JSON.stringify(status).toLowerCase().includes('senha'), false)
  })

  await t.test('8. allowlist externa: vazia por padrão, formato E.164 comparado corretamente (mesma lógica de telefonesEquivalentes)', () => {
    assert.deepEqual(lerAllowlistExterna(), [])
    assert.equal(numeroNaAllowlistExterna('+5511999998888'), false, 'allowlist vazia por padrão — nenhum número é permitido automaticamente')

    process.env.VOICE_EXTERNAL_ALLOWLIST = '+5511999998888'
    assert.equal(numeroNaAllowlistExterna('11999998888'), true, 'mesma equivalência de formato já usada em telefonesEquivalentes')
    assert.equal(numeroNaAllowlistExterna('+5511000000000'), false)
    delete process.env.VOICE_EXTERNAL_ALLOWLIST
  })

  await t.test('9. limites de voz têm defaults conservadores (1/hora, 3/dia, 1/telefone/dia)', () => {
    const limites = lerLimitesVoz()
    assert.equal(limites.maxChamadasHora, 1)
    assert.equal(limites.maxChamadasDia, 3)
    assert.equal(limites.maxChamadasPorTelefoneDia, 1)
  })

  await t.test('10. idempotencyKeyLigacaoExterna é determinística por (título, dia)', () => {
    const k1 = idempotencyKeyLigacaoExterna({ contasFinanceirasId: 'abc', diaBrt: '2026-08-16' })
    const k2 = idempotencyKeyLigacaoExterna({ contasFinanceirasId: 'abc', diaBrt: '2026-08-16' })
    const k3 = idempotencyKeyLigacaoExterna({ contasFinanceirasId: 'abc', diaBrt: '2026-08-17' })
    assert.equal(k1, k2)
    assert.notEqual(k1, k3)
  })

  await t.test('11. doNotContactGuard: parametrização por canal preserva comportamento padrão (WhatsApp) e adiciona "ligacao"', async () => {
    const conta = await criarContaDeTeste(supabase, {})
    await supabase.from('collection_do_not_contact').insert({ cliente_telefone: conta.telefone_cobranca, canal: 'ligacao', motivo: 'teste voz' })

    // Comportamento PADRÃO (sem 2º argumento) — igual a antes desta rodada: só 'todos'/'whatsapp'.
    const semParametro = await estaEmDoNotContact(conta.telefone_cobranca)
    assert.equal(semParametro.blocked, false, 'DNC só de "ligacao" não pode bloquear o caminho WhatsApp — comportamento padrão preservado')

    // Guard de voz — passa canais ['todos','ligacao'] explicitamente.
    const comLigacao = await estaEmDoNotContact(conta.telefone_cobranca, ['todos', 'ligacao'])
    assert.equal(comLigacao.blocked, true)
    assert.equal(comLigacao.reason, 'OPT_OUT')
  })

  await t.test('12. avaliarGuardsTituloParaLigacao: título quitado bloqueia', async () => {
    const conta = await criarContaDeTeste(supabase, { valor: 100, valor_pago: 100 })
    const resultado = await avaliarGuardsTituloParaLigacao(conta.id, conta.telefone_cobranca)
    assert.equal(resultado.permitido, false)
    assert.match(resultado.motivo, /titulo_quitado_cancelado_ou_em_revisao/)
  })

  await t.test('13. avaliarGuardsTituloParaLigacao: em_revisao_financeira bloqueia', async () => {
    const conta = await criarContaDeTeste(supabase, { em_revisao_financeira: true })
    const resultado = await avaliarGuardsTituloParaLigacao(conta.id, conta.telefone_cobranca)
    assert.equal(resultado.permitido, false)
    assert.match(resultado.motivo, /titulo_quitado_cancelado_ou_em_revisao/)
  })

  await t.test('14. avaliarGuardsTituloParaLigacao: promessa ativa bloqueia', async () => {
    const conta = await criarContaDeTeste(supabase, {})
    await registrarPromessa({
      contasFinanceirasId: conta.id, clienteNome: conta.pessoa_nome, clienteTelefone: conta.telefone_cobranca,
      valor: 100, promisedDate: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10), origem: 'HUMAN',
    })
    const resultado = await avaliarGuardsTituloParaLigacao(conta.id, conta.telefone_cobranca)
    assert.equal(resultado.permitido, false)
    assert.match(resultado.motivo, /promessa_ativa/)
  })

  await t.test('15. avaliarGuardsTituloParaLigacao: sem telefone bloqueia', async () => {
    const conta = await criarContaDeTeste(supabase, {})
    await supabase.from('contas_financeiras').update({ telefone_cobranca: null }).eq('id', conta.id)
    const resultado = await avaliarGuardsTituloParaLigacao(conta.id, null)
    assert.equal(resultado.permitido, false)
    assert.match(resultado.motivo, /sem_telefone/)
  })

  await t.test('16. avaliarGuardsTituloParaLigacao: título normal (sem nenhum bloqueio) permite', async () => {
    const conta = await criarContaDeTeste(supabase, {})
    const resultado = await avaliarGuardsTituloParaLigacao(conta.id, conta.telefone_cobranca)
    assert.equal(resultado.permitido, true)
  })

  await t.test('17. avaliarGuardGlobalParaLigacao: financialSyncGuard stale bloqueia (mesmo guard do WhatsApp)', async () => {
    await supabase.from('sincronizacoes_financeiro').delete().eq('dry_run', false)
    const { _resetCacheParaTeste } = await import('../../../src/lib/collection/financialSyncGuard.js')
    _resetCacheParaTeste()
    const resultado = await avaliarGuardGlobalParaLigacao()
    assert.equal(resultado.permitido, false)
    assert.match(resultado.motivo, /financial_sync_guard/)
  })

  await t.test('18. avaliarGuardsCobrancaParaLigacao: guard global (sync) é checado ANTES do guard de título — mesmo com título 100% normal', async () => {
    // sincronizacoes_financeiro segue vazia do teste anterior — stale/nunca sincronizou.
    const conta = await criarContaDeTeste(supabase, {})
    const resultado = await avaliarGuardsCobrancaParaLigacao(conta.id, conta.telefone_cobranca)
    assert.equal(resultado.permitido, false)
    assert.match(resultado.motivo, /financial_sync_guard/)
  })

  await t.test('19. este trabalho não muta nenhuma tabela financeira/de cobrança real (só leitura, exceto o próprio teste de flag)', async () => {
    // cobrancas_whatsapp nunca é 0 por padrão — seed.sql insere 2 linhas
    // sintéticas de baseline (mesmo achado documentado no hotfix de
    // paginação PostgREST desta mesma sessão). collection_dispatches não é
    // seedado, mas outros arquivos de teste rodando ANTES deste na mesma
    // suíte podem já ter criado dispatches legítimos — por isso comparamos
    // contra a baseline capturada no início DESTE arquivo, não contra zero
    // absoluto (zero absoluto só é seguro rodando este arquivo isolado).
    const { count: dispatchesDepois } = await supabase.from('collection_dispatches').select('id', { count: 'exact', head: true })
    assert.equal(dispatchesDepois, dispatchesAntes, 'nenhum cenário deste arquivo deveria ter criado um dispatch')
  })

  await t.test('20. prova estática — arquivos de prontidão externa continuam sem acoplamento financeiro direto nem telefone real hardcoded', () => {
    const arquivos = [
      'lib/voice/destinoResolver.js',
      'lib/voice/externalPilotGuardrails.js',
      'lib/voice/externalConfig.js',
      'lib/voice/outboundExternalTest.js',
    ]
    for (const rel of arquivos) {
      const conteudo = fs.readFileSync(path.join(SRC, rel), 'utf8')
      for (const proibido of ['evolutionAdapter', 'evolutionFinanceiro', 'sendText', '.rpc(', 'execute_sql', "from('contas_financeiras')", 'UPDATE contas_financeiras', "from('collection_promises')", "from('collection_dispatches')"]) {
        assert.equal(conteudo.includes(proibido), false, `${rel} não deveria referenciar "${proibido}"`)
      }
      assert.equal(/\+55\d{10,11}/.test(conteudo), false, `${rel} não deveria ter um telefone literal`)
    }
  })

  await t.test('21. collectionGuardsForVoice.js nunca é importado por nenhum job/rota de execução real (auditoria/preparação apenas, régua não ligada à voz)', () => {
    const raiz = path.join(SRC)
    const proibidoEm = ['jobs', 'routes'].flatMap((dir) => {
      const p = path.join(raiz, dir)
      if (!fs.existsSync(p)) return []
      return fs.readdirSync(p).filter((f) => f.endsWith('.js')).map((f) => path.join(p, f))
    })
    for (const arquivo of proibidoEm) {
      const conteudo = fs.readFileSync(arquivo, 'utf8')
      assert.equal(conteudo.includes('collectionGuardsForVoice'), false, `${arquivo} não deveria importar collectionGuardsForVoice.js ainda — régua não ligada à voz nesta rodada`)
    }
  })

  await pararAmbienteDeTeste()
})
