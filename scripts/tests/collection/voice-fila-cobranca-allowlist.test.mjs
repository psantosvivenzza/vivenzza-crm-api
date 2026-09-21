// ACHADO DA AUDITORIA (f8cb81c9, 2026-09-21): scripts/voice/rodar-fila-cobranca.mjs
// montava `allowlist: [numero]` para cada item da fila — o próprio número
// virava, sozinho, a allowlist usada por avaliarNumeroNaAllowlist(), o que
// tornava o gate sempre verdadeiro (a fila se autoautorizava). Este arquivo
// prova, adversarialmente, que o dispatcher automático agora usa SEMPRE a
// allowlist externa/configurada (VOICE_EXTERNAL_ALLOWLIST) e nunca o próprio
// número — e que qualquer ausência/vazio/malformação/erro de leitura bloqueia
// ANTES de qualquer tentativa de originar. Nenhum teste aqui toca PSTN/Nvoip
// real — resolverAllowlistParaAutorizacao() é pura (dependência injetável) e
// main() nunca é chamado ao importar o script (ver isMain no próprio arquivo).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste } from './_setup.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(__dirname, '..', '..', '..', 'src')
const SCRIPTS_VOICE = path.join(__dirname, '..', '..', 'voice')
const SCRIPT_PATH = path.join(SCRIPTS_VOICE, 'rodar-fila-cobranca.mjs')

test('VOICE FILA COBRANCA — bypass de allowlist (auditoria f8cb81c9)', async (t) => {
  await iniciarAmbienteDeTeste()
  const { resolverAllowlistParaAutorizacao } = await import('../../voice/rodar-fila-cobranca.mjs')
  const { supabase } = await import('../../../src/lib/supabase-admin.server.js')
  const { obterConfigCobranca, invalidarCacheFlags } = await import('../../../src/lib/collection/featureFlags.js')
  const { avaliarAutorizacaoChamadaExterna } = await import('../../../src/lib/voice/externalPilotGuardrails.js')

  function limparEnvAllowlist() {
    delete process.env.VOICE_EXTERNAL_ALLOWLIST
    delete process.env.NVOIP_SIP_SERVER
  }

  await t.test('0. prova estática — script NUNCA mais monta allowlist:[numero] (assinatura exata do bypass)', () => {
    const conteudo = fs.readFileSync(SCRIPT_PATH, 'utf8')
    assert.equal(conteudo.includes('allowlist: [numero]'), false, 'a fila não pode se autoautorizar montando allowlist com o próprio número')
    assert.match(conteudo, /resolverAllowlistParaAutorizacao/, 'o dispatcher deveria usar a função de resolução de allowlist externa')
    assert.match(conteudo, /numeroNaAllowlistExterna/, 'a allowlist usada deveria vir de externalConfig.js (VOICE_EXTERNAL_ALLOWLIST), nunca do próprio número')
  })

  await t.test('1. allowlist AUSENTE (env nunca definida) bloqueia — não autoriza por acaso', () => {
    limparEnvAllowlist()
    const { allowlist, erro } = resolverAllowlistParaAutorizacao('+5511999998888')
    assert.equal(erro, null)
    assert.deepEqual(allowlist, [])
  })

  await t.test('2. allowlist VAZIA (env="") bloqueia', () => {
    process.env.VOICE_EXTERNAL_ALLOWLIST = ''
    const { allowlist, erro } = resolverAllowlistParaAutorizacao('+5511999998888')
    assert.equal(erro, null)
    assert.deepEqual(allowlist, [])
    limparEnvAllowlist()
  })

  await t.test('3. allowlist MALFORMADA (só lixo/vírgulas/espaços, nenhum telefone real) bloqueia', () => {
    process.env.VOICE_EXTERNAL_ALLOWLIST = ' , , abc-nao-e-telefone , ,, +++, '
    const { allowlist, erro } = resolverAllowlistParaAutorizacao('+5511999998888')
    assert.equal(erro, null)
    assert.deepEqual(allowlist, [], 'nenhum entry malformado deveria "casar" com um telefone real por acidente')
    limparEnvAllowlist()
  })

  await t.test('4. número DENTRO da allowlist configurada é reconhecido (equivalência de formato, mesma lógica de telefonesEquivalentes)', () => {
    process.env.VOICE_EXTERNAL_ALLOWLIST = '+5511999998888,+5551988887777'
    const { allowlist, erro } = resolverAllowlistParaAutorizacao('11999998888') // sem +55, mesmo número
    assert.equal(erro, null)
    assert.deepEqual(allowlist, ['11999998888'])
    limparEnvAllowlist()
  })

  await t.test('5. número FORA da allowlist configurada (mesmo com outros números presentes) bloqueia', () => {
    process.env.VOICE_EXTERNAL_ALLOWLIST = '+5511999998888,+5551988887777'
    const { allowlist, erro } = resolverAllowlistParaAutorizacao('+5521000000000')
    assert.equal(erro, null)
    assert.deepEqual(allowlist, [])
    limparEnvAllowlist()
  })

  await t.test('6. AUTO-INCLUSÃO PROIBIDA — número da fila NÃO pode se autoautorizar quando a allowlist real está vazia ou não o contém (regressão direta do bug f8cb81c9)', () => {
    // Cenário do bug real: um número QUALQUER vindo da fila (elegível por
    // critério de cobrança) NUNCA deveria, sozinho, virar allowlist válida.
    limparEnvAllowlist()
    const numeroDaFila = '+5551999900001'
    const semAllowlist = resolverAllowlistParaAutorizacao(numeroDaFila)
    assert.deepEqual(semAllowlist.allowlist, [], 'sem VOICE_EXTERNAL_ALLOWLIST configurada, nenhum número da fila se autoautoriza')

    process.env.VOICE_EXTERNAL_ALLOWLIST = '+5511000000001' // allowlist real configurada, mas NÃO inclui o número da fila
    const comAllowlistDiferente = resolverAllowlistParaAutorizacao(numeroDaFila)
    assert.deepEqual(comAllowlistDiferente.allowlist, [], 'o número da fila não está na allowlist real configurada — não pode passar')
    limparEnvAllowlist()
  })

  await t.test('7. ERRO DE LEITURA/COMPARAÇÃO bloqueia ANTES de qualquer origem (fail-closed, dependência injetada só para este teste)', () => {
    const explosivo = () => { throw new Error('falha simulada de leitura/comparação da allowlist') }
    const { allowlist, erro } = resolverAllowlistParaAutorizacao('+5511999998888', explosivo)
    assert.deepEqual(allowlist, [])
    assert.match(erro, /^erro_leitura_allowlist:/)
  })

  await t.test('8. INTEGRAÇÃO — flag=true + trunk pronto + número FORA da allowlist real: avaliarAutorizacaoChamadaExterna ainda bloqueia (fora_da_allowlist)', async () => {
    process.env.NVOIP_SIP_SERVER = 'app.nvoip.com.br'
    process.env.VOICE_EXTERNAL_ALLOWLIST = '+5511000000001' // não inclui o número testado abaixo
    try {
      await supabase.from('automacoes_config').update({ voice_external_enabled: true }).eq('id', 1)
      invalidarCacheFlags()
      const config = await obterConfigCobranca()
      const numero = '+5551999900001' // número "da fila", de propósito diferente da allowlist configurada
      const { allowlist, erro } = resolverAllowlistParaAutorizacao(numero)
      assert.equal(erro, null)
      const resultado = avaliarAutorizacaoChamadaExterna({
        flags: config, numero, allowlist,
        idempotencyKey: 'chave-teste-fila-fora-allowlist', chavesJaProcessadas: new Set(),
        chamadasAtivas: [], horaAtual: new Date(2026, 0, 5, 10, 0),
        politicaHorario: { janelas: [{ dias: [1, 2, 3, 4, 5], inicioMinutos: 9 * 60, fimMinutos: 18 * 60 }] },
        chamadasHoje: [], limiteDiario: 3,
      })
      assert.equal(resultado.permitido, false)
      assert.match(resultado.motivo, /fora_da_allowlist/)
    } finally {
      limparEnvAllowlist()
      await supabase.from('automacoes_config').update({ voice_external_enabled: false }).eq('id', 1)
      invalidarCacheFlags()
    }
  })

  await t.test('9. INTEGRAÇÃO — flag=true + trunk pronto + número DENTRO da allowlist real: gate de allowlist deixa de bloquear (demais guards decidem)', async () => {
    process.env.NVOIP_SIP_SERVER = 'app.nvoip.com.br'
    const numero = '+5551999900001'
    process.env.VOICE_EXTERNAL_ALLOWLIST = numero // desta vez, configurada de verdade pelo operador
    try {
      await supabase.from('automacoes_config').update({ voice_external_enabled: true }).eq('id', 1)
      invalidarCacheFlags()
      const config = await obterConfigCobranca()
      const { allowlist, erro } = resolverAllowlistParaAutorizacao(numero)
      assert.equal(erro, null)
      assert.deepEqual(allowlist, [numero])
      const resultado = avaliarAutorizacaoChamadaExterna({
        flags: config, numero, allowlist,
        idempotencyKey: 'chave-teste-fila-dentro-allowlist', chavesJaProcessadas: new Set(),
        chamadasAtivas: [], horaAtual: new Date(2026, 0, 5, 10, 0),
        politicaHorario: { janelas: [{ dias: [1, 2, 3, 4, 5], inicioMinutos: 9 * 60, fimMinutos: 18 * 60 }] },
        chamadasHoje: [], limiteDiario: 3,
      })
      assert.equal(resultado.permitido, true, 'com allowlist real configurada corretamente, o gate de allowlist não deveria mais ser o motivo de bloqueio')
      assert.equal(resultado.motivo, null)
    } finally {
      limparEnvAllowlist()
      await supabase.from('automacoes_config').update({ voice_external_enabled: false }).eq('id', 1)
      invalidarCacheFlags()
    }
  })

  await t.test('10. INTEGRAÇÃO — FLAG desabilitada (default) bloqueia mesmo com número corretamente na allowlist real (kill switch independente do fix de allowlist)', async () => {
    const numero = '+5551999900001'
    process.env.VOICE_EXTERNAL_ALLOWLIST = numero
    process.env.NVOIP_SIP_SERVER = 'app.nvoip.com.br'
    try {
      const config = await obterConfigCobranca()
      assert.equal(config.voice_external_enabled, false, 'pré-condição: flag desligada (padrão)')
      const { allowlist } = resolverAllowlistParaAutorizacao(numero)
      const resultado = avaliarAutorizacaoChamadaExterna({
        flags: config, numero, allowlist,
        idempotencyKey: 'chave-teste-fila-flag-desligada', chavesJaProcessadas: new Set(),
        chamadasAtivas: [], horaAtual: new Date(2026, 0, 5, 10, 0),
        politicaHorario: { janelas: [{ dias: [1, 2, 3, 4, 5], inicioMinutos: 9 * 60, fimMinutos: 18 * 60 }] },
        chamadasHoje: [], limiteDiario: 3,
      })
      assert.equal(resultado.permitido, false)
      assert.match(resultado.motivo, /flag_desabilitada/)
    } finally {
      limparEnvAllowlist()
    }
  })

  await t.test('11. INTEGRAÇÃO — TRUNK não pronto (NVOIP_SIP_SERVER ausente) bloqueia mesmo com flag=true e número na allowlist real', async () => {
    const numero = '+5551999900001'
    process.env.VOICE_EXTERNAL_ALLOWLIST = numero
    delete process.env.NVOIP_SIP_SERVER // garante trunk "não pronto" independente do que rodou antes
    try {
      await supabase.from('automacoes_config').update({ voice_external_enabled: true }).eq('id', 1)
      invalidarCacheFlags()
      const config = await obterConfigCobranca()
      const { allowlist } = resolverAllowlistParaAutorizacao(numero)
      const resultado = avaliarAutorizacaoChamadaExterna({
        flags: config, numero, allowlist,
        idempotencyKey: 'chave-teste-fila-sem-trunk', chavesJaProcessadas: new Set(),
        chamadasAtivas: [], horaAtual: new Date(2026, 0, 5, 10, 0),
        politicaHorario: { janelas: [{ dias: [1, 2, 3, 4, 5], inicioMinutos: 9 * 60, fimMinutos: 18 * 60 }] },
        chamadasHoje: [], limiteDiario: 3,
      })
      assert.equal(resultado.permitido, false)
      assert.match(resultado.motivo, /sem_trunk/)
    } finally {
      limparEnvAllowlist()
      await supabase.from('automacoes_config').update({ voice_external_enabled: false }).eq('id', 1)
      invalidarCacheFlags()
    }
  })

  await t.test('12. prova estática — erro de leitura da FILA (query da view) continua fail-closed: process.exitCode=1 e return, nunca segue adiante', () => {
    const conteudo = fs.readFileSync(SCRIPT_PATH, 'utf8')
    assert.match(
      conteudo,
      /if\s*\(\s*error\s*\)\s*\{\s*\n\s*console\.error\(`\[fila-cobranca\] ERRO ao ler a fila:[^]*?\n\s*process\.exitCode = 1\s*\n\s*return\s*\n\s*\}/,
      'erro ao ler vw_fila_ligacao_cobranca precisa continuar interrompendo a execução (fail-closed), nunca virar "fila vazia" ou seguir para originar'
    )
  })

  await t.test('13. prova estática — erro de leitura de HISTÓRICO POR TELEFONE (buscarEstadoChamadasExternas) continua PULANDO o item, nunca originando', () => {
    const conteudo = fs.readFileSync(SCRIPT_PATH, 'utf8')
    assert.match(
      conteudo,
      /try\s*\{\s*\n\s*estado = await buscarEstadoChamadasExternas\(\{ numero \}\)\s*\n\s*\} catch \(err\) \{\s*\n\s*log\(`PULADO/,
      'erro ao ler o histórico de um telefone precisa continuar pulando esse item (bloqueadas++, continue), nunca prosseguindo para autorização/origem'
    )
  })

  await t.test('14. prova estática — resolverAllowlistParaAutorizacao roda ANTES de avaliarAutorizacaoChamadaExterna no loop principal (ordem importa: nunca originar sem resolver allowlist primeiro)', () => {
    const conteudo = fs.readFileSync(SCRIPT_PATH, 'utf8')
    const idxResolver = conteudo.indexOf('resolverAllowlistParaAutorizacao(numero)')
    const idxAutorizacao = conteudo.indexOf('avaliarAutorizacaoChamadaExterna({')
    assert.ok(idxResolver > 0 && idxAutorizacao > 0, 'ambas as chamadas precisam existir no arquivo')
    assert.ok(idxResolver < idxAutorizacao, 'a resolução da allowlist precisa acontecer antes da chamada de autorização')
  })

  await t.test('15. INTERNAL preservado — este script nunca importa/menciona outboundInternalTest.js nem PJSIP/7001 (dispatcher é só de chamada EXTERNA)', () => {
    const conteudo = fs.readFileSync(SCRIPT_PATH, 'utf8')
    assert.equal(conteudo.includes('outboundInternalTest'), false)
    assert.equal(conteudo.includes('PJSIP/7001'), false)
  })

  await t.test('16. scripts de teste manual preservados — trigger-external-test.mjs e trigger-outbound-test.mjs continuam existindo e intocados (só rodar-fila-cobranca.mjs foi corrigido)', () => {
    for (const nome of ['trigger-external-test.mjs', 'trigger-outbound-test.mjs']) {
      const p = path.join(SCRIPTS_VOICE, nome)
      assert.ok(fs.existsSync(p), `${nome} deveria continuar existindo`)
    }
    const triggerExternal = fs.readFileSync(path.join(SCRIPTS_VOICE, 'trigger-external-test.mjs'), 'utf8')
    assert.match(triggerExternal, /numeroNaAllowlistExterna/, 'o script de teste manual já usava a allowlist real — não deveria ter sido tocado')
  })

  await t.test('17. main() nunca executa ao importar o módulo (script seguro de importar em teste — sem tocar Supabase real/ARI/PSTN)', () => {
    const conteudo = fs.readFileSync(SCRIPT_PATH, 'utf8')
    assert.match(conteudo, /const isMain = process\.argv\[1\]/, 'guard de execução direta (isMain) precisa existir para o import deste teste ser seguro')
  })

  // ACHADO DA AUDITORIA (21/09/2026, ativação controlada): collectionGuardsForVoice.js
  // (título quitado/promessa ativa/DNC) existia, testado, mas nenhum job real o
  // chamava — vw_fila_ligacao_cobranca é só a primeira peneira e não repete, no
  // banco, DNC (canal ligacao/todos) nem promessas feitas fora de uma ligação
  // (collection_promises, alimentada também por WhatsApp/humano). Os testes 18+
  // provam que o dispatcher automático agora chama esses guards também.
  await t.test('18. prova estática — rodar-fila-cobranca.mjs agora importa e chama collectionGuardsForVoice.js', () => {
    const conteudo = fs.readFileSync(SCRIPT_PATH, 'utf8')
    assert.match(conteudo, /from '.*collectionGuardsForVoice\.js'/, 'o dispatcher precisa importar os guards de cobrança já testados')
    assert.match(conteudo, /avaliarGuardsTituloParaLigacao/)
    assert.match(conteudo, /avaliarGuardGlobalParaLigacao/)
  })

  await t.test('19. prova estática — guard GLOBAL (financialSyncGuard) roda em main() ANTES de qualquer discagem real, mas DEPOIS do dry-run (dry-run continua só visualização, nunca disca, e não deveria abortar por causa de um guard que só protege discagem de verdade)', () => {
    const conteudo = fs.readFileSync(SCRIPT_PATH, 'utf8')
    const idxLeituraFila = conteudo.indexOf("from('vw_fila_ligacao_cobranca')")
    const idxDryRun = conteudo.indexOf('DRY RUN - nenhuma ligação foi feita')
    const idxGuardGlobal = conteudo.indexOf('avaliarGuardGlobalParaLigacao()')
    const idxAriCheck = conteudo.indexOf("ARI_USER/ARI_PASSWORD não configurados")
    assert.ok(idxLeituraFila > 0 && idxDryRun > 0 && idxGuardGlobal > 0 && idxAriCheck > 0, 'todos precisam existir no arquivo')
    assert.ok(idxLeituraFila < idxDryRun, 'a fila precisa ser lida e exibida mesmo em dry-run')
    assert.ok(idxDryRun < idxGuardGlobal, 'o guard global de sync só deveria ser checado depois do dry-run (dry-run nunca disca, não precisa ser bloqueado por ele)')
    assert.ok(idxGuardGlobal < idxAriCheck, 'o guard global de sync precisa ser checado antes de qualquer tentativa de conectar no ARI/discar de verdade')
  })

  await t.test('20. INTEGRAÇÃO — título com saldo quitado (valor_pago cobre o valor) bloqueia via avaliarGuardsCobrancaDoCliente, mesmo que a view ainda não tenha refletido o status', async () => {
    const { avaliarGuardsCobrancaDoCliente } = await import('../../voice/rodar-fila-cobranca.mjs')
    const codigoCliente = `TESTE-QUITADO-${Date.now()}`
    const telefone = '5551999911001'
    const { data: titulo, error } = await supabase.from('contas_financeiras').insert({
      tipo: 'receber', pessoa_nome: 'Cliente Teste Quitado', valor: 500, valor_pago: 500,
      vencimento: new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10),
      status: 'vencida', // status ainda não refletiu o pagamento — exatamente o gap da auditoria
      telefone_cobranca: telefone, em_revisao_financeira: false, codigo_cliente: codigoCliente,
    }).select().single()
    assert.equal(error, null)
    try {
      const resultado = await avaliarGuardsCobrancaDoCliente(codigoCliente, telefone)
      assert.equal(resultado.permitido, false)
      assert.match(resultado.motivo, /titulo_quitado_cancelado_ou_em_revisao/)
    } finally {
      await supabase.from('contas_financeiras').delete().eq('id', titulo.id)
    }
  })

  await t.test('21. INTEGRAÇÃO — promessa ATIVA em collection_promises (ex.: negociada por WhatsApp) bloqueia a ligação, mesmo sem nenhuma ligação de voz anterior', async () => {
    const { avaliarGuardsCobrancaDoCliente } = await import('../../voice/rodar-fila-cobranca.mjs')
    const { registrarPromessa } = await import('../../../src/lib/collection/promises.js')
    const codigoCliente = `TESTE-PROMESSA-${Date.now()}`
    const telefone = '5551999911002'
    const { data: titulo, error } = await supabase.from('contas_financeiras').insert({
      tipo: 'receber', pessoa_nome: 'Cliente Teste Promessa', valor: 500, valor_pago: 0,
      vencimento: new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10),
      status: 'vencida', telefone_cobranca: telefone, em_revisao_financeira: false, codigo_cliente: codigoCliente,
    }).select().single()
    assert.equal(error, null)
    try {
      await registrarPromessa({
        contasFinanceirasId: titulo.id, clienteNome: 'Cliente Teste Promessa', clienteTelefone: telefone,
        valor: 500, promisedDate: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10), origem: 'AI',
      })
      const resultado = await avaliarGuardsCobrancaDoCliente(codigoCliente, telefone)
      assert.equal(resultado.permitido, false)
      assert.match(resultado.motivo, /promessa_ativa/)
    } finally {
      await supabase.from('collection_promises').delete().eq('contas_financeiras_id', titulo.id)
      await supabase.from('contas_financeiras').delete().eq('id', titulo.id)
    }
  })

  await t.test('22. INTEGRAÇÃO — telefone em collection_do_not_contact (canal "ligacao") bloqueia, mesmo com título saudável e sem promessa', async () => {
    const { avaliarGuardsCobrancaDoCliente } = await import('../../voice/rodar-fila-cobranca.mjs')
    const codigoCliente = `TESTE-DNC-${Date.now()}`
    const telefone = '5551999911003'
    const { data: titulo, error } = await supabase.from('contas_financeiras').insert({
      tipo: 'receber', pessoa_nome: 'Cliente Teste DNC', valor: 500, valor_pago: 0,
      vencimento: new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10),
      status: 'vencida', telefone_cobranca: telefone, em_revisao_financeira: false, codigo_cliente: codigoCliente,
    }).select().single()
    assert.equal(error, null)
    const { error: erroDnc } = await supabase.from('collection_do_not_contact').insert({
      cliente_telefone: telefone, motivo: 'pedido do cliente (teste)', canal: 'ligacao', expira_em: null,
    })
    assert.equal(erroDnc, null)
    try {
      const resultado = await avaliarGuardsCobrancaDoCliente(codigoCliente, telefone)
      assert.equal(resultado.permitido, false)
      assert.match(resultado.motivo, /opt_out/)
    } finally {
      await supabase.from('collection_do_not_contact').delete().eq('cliente_telefone', telefone)
      await supabase.from('contas_financeiras').delete().eq('id', titulo.id)
    }
  })

  await t.test('23. INTEGRAÇÃO — cliente saudável (título aberto, sem promessa, sem DNC) continua PERMITIDO — o novo guard não bloqueia quem está realmente elegível', async () => {
    const { avaliarGuardsCobrancaDoCliente } = await import('../../voice/rodar-fila-cobranca.mjs')
    const codigoCliente = `TESTE-SAUDAVEL-${Date.now()}`
    const telefone = '5551999911004'
    const { data: titulo, error } = await supabase.from('contas_financeiras').insert({
      tipo: 'receber', pessoa_nome: 'Cliente Teste Saudavel', valor: 500, valor_pago: 0,
      vencimento: new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10),
      status: 'vencida', telefone_cobranca: telefone, em_revisao_financeira: false, codigo_cliente: codigoCliente,
    }).select().single()
    assert.equal(error, null)
    try {
      const resultado = await avaliarGuardsCobrancaDoCliente(codigoCliente, telefone)
      assert.equal(resultado.permitido, true)
      assert.equal(resultado.motivo, null)
    } finally {
      await supabase.from('contas_financeiras').delete().eq('id', titulo.id)
    }
  })

  await t.test('24. INTEGRAÇÃO — cliente sem NENHUM título elegível no momento da ligação (todos já quitados/cancelados) bloqueia com motivo explícito', async () => {
    const { avaliarGuardsCobrancaDoCliente } = await import('../../voice/rodar-fila-cobranca.mjs')
    const codigoCliente = `TESTE-SEMTITULO-${Date.now()}`
    const telefone = '5551999911005'
    const resultado = await avaliarGuardsCobrancaDoCliente(codigoCliente, telefone)
    assert.equal(resultado.permitido, false)
    assert.match(resultado.motivo, /sem_titulo_elegivel_no_momento_da_ligacao/)
  })

  limparEnvAllowlist()
  await pararAmbienteDeTeste()
})
