// Teto GLOBAL de envio (globalSendLimit.js) — 10 cenários do pedido de
// 2026-08-15. Sem enviar WhatsApp real: tudo via fakeEvolution + Postgres
// local. Contexto: dispatchEngine.js documentava um limite global
// (automacoes_config.global_daily_limit/global_hourly_limit) que nenhum
// código lia — e o único teto que de fato existia (LIMITE_DIARIO/
// LIMITE_POR_HORA em cobranca-whatsapp.js) nunca cobria /disparar-individual.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste, criarContaDeTeste, limparInstanciasDeTeste } from './_setup.mjs'

async function criarInstancia(supabase, nome, overrides = {}) {
  const { data, error } = await supabase.from('whatsapp_instances').insert({
    name: nome, instance_name: nome, priority: 1, role: 'principal', enabled: true, ...overrides,
  }).select().single()
  if (error) throw error
  return data
}

// Simula um envio já concluído (o que cobranca-whatsapp.js/cobrancas.js
// inserem DEPOIS de enviarCobrancaComRoteamento retornar 'sent') — não passa
// pelo motor de verdade, só popula o contador que globalSendLimit.js lê.
async function inserirEnvioSimulado(supabase, { origem = 'cron', minutosAtras = 0 } = {}) {
  const dataEnvio = new Date(Date.now() - minutosAtras * 60000).toISOString()
  const { error } = await supabase.from('cobrancas_whatsapp').insert({
    cliente_nome: 'Simulado', cliente_telefone: '5551900000000', valor: 100,
    etapa: 1, status: 'enviada', origem, data_envio: dataEnvio,
  })
  if (error) throw error
}

async function limparCobrancasWhatsapp(supabase) {
  // Limpa TUDO, não só linhas marcadas — a contagem do teto global é
  // deliberadamente sem filtro (é isso que a torna "global"), então o seed
  // sintético do banco local (localdb-reset.mjs) precisa ser removido daqui
  // pra não vazar contagem entre testes.
  await supabase.from('cobrancas_whatsapp').delete().neq('id', '00000000-0000-0000-0000-000000000000')
}

async function setLimitesGlobais(supabase, invalidarCacheFlags, { diario, horario }) {
  await supabase.from('automacoes_config').update({ global_daily_limit: diario, global_hourly_limit: horario }).eq('id', 1)
  invalidarCacheFlags()
}

// enviarCobrancaComRoteamento sempre checa o guard de frescor do sync
// financeiro primeiro (financialSyncGuard.js) — sem isso, todo teste que
// chama a função real cairia em 'nunca_sincronizou' antes mesmo de chegar
// no teto global que este arquivo testa. Não depende de outro arquivo de
// teste ter rodado antes (execução isolada deste arquivo precisa passar
// igual à suíte completa).
async function garantirSyncFinanceiroFresco(supabase) {
  await supabase.from('sincronizacoes_financeiro').delete().neq('id', '00000000-0000-0000-0000-000000000000')
  const agora = new Date().toISOString()
  const { error } = await supabase.from('sincronizacoes_financeiro').insert({
    status: 'concluido', dry_run: false, iniciado_em: agora, concluido_em: agora,
    total_lido: 1, total_atualizado: 0, total_sem_alteracao: 0, total_sem_match: 0,
    total_conflito: 0, total_cancelado: 0, total_com_erro: 0,
  })
  if (error) throw error
}

test('Teto global de envio (globalSendLimit.js)', async (t) => {
  const fakeEvolution = await iniciarAmbienteDeTeste()
  const { supabase } = await import('../../../src/lib/supabase-admin.server.js')
  const { verificarLimiteGlobalEnvio } = await import('../../../src/lib/collection/globalSendLimit.js')
  const { enviarCobrancaComRoteamento } = await import('../../../src/lib/collection/collectionRouting.js')
  const { invalidarCacheFlags } = await import('../../../src/lib/collection/featureFlags.js')

  async function resetar() {
    fakeEvolution.resetar()
    await limparInstanciasDeTeste(supabase)
    await limparCobrancasWhatsapp(supabase)
    await garantirSyncFinanceiroFresco(supabase)
    await setLimitesGlobais(supabase, invalidarCacheFlags, { diario: 30, horario: 10 })
    await supabase.from('automacoes_config').update({ multi_whatsapp: false, whatsapp_failover: false }).eq('id', 1)
    invalidarCacheFlags()
  }

  await t.test('1+3. abaixo do hourly e do daily -> permite', async () => {
    await resetar()
    for (let i = 0; i < 5; i++) await inserirEnvioSimulado(supabase, { minutosAtras: 10 })
    const r = await verificarLimiteGlobalEnvio()
    assert.equal(r.permitido, true)
    assert.equal(r.contagem_dia, 5)
    assert.equal(r.contagem_hora, 5)
  })

  await t.test('2. atingiu hourly (mas não daily) -> bloqueia com motivo correto', async () => {
    await resetar()
    await setLimitesGlobais(supabase, invalidarCacheFlags, { diario: 30, horario: 3 })
    for (let i = 0; i < 3; i++) await inserirEnvioSimulado(supabase, { minutosAtras: 5 }) // dentro da hora atual
    const r = await verificarLimiteGlobalEnvio()
    assert.equal(r.permitido, false)
    assert.equal(r.motivo, 'limite_global_horario')
  })

  await t.test('4. atingiu daily -> bloqueia com motivo correto (mesmo com hourly OK)', async () => {
    await resetar()
    await setLimitesGlobais(supabase, invalidarCacheFlags, { diario: 2, horario: 100 })
    for (let i = 0; i < 2; i++) await inserirEnvioSimulado(supabase, { minutosAtras: 300 }) // fora da hora atual, dentro do dia
    const r = await verificarLimiteGlobalEnvio()
    assert.equal(r.permitido, false)
    assert.equal(r.motivo, 'limite_global_diario')
  })

  await t.test('5. A+B somados atingem o global -> C (3ª tentativa) bloqueada, independente de quem enviou A e B', async () => {
    await resetar()
    await setLimitesGlobais(supabase, invalidarCacheFlags, { diario: 2, horario: 100 })
    await inserirEnvioSimulado(supabase, { origem: 'cron', minutosAtras: 1 }) // "instância A" / envio 1
    await inserirEnvioSimulado(supabase, { origem: 'manual', minutosAtras: 1 }) // "instância B" / envio 2
    const r = await verificarLimiteGlobalEnvio()
    assert.equal(r.permitido, false, 'a soma de A+B (2) já atinge o limite diário=2 — C não pode enviar')
    assert.equal(r.motivo, 'limite_global_diario')
  })

  await t.test('6. troca de instância não reseta o global — contagem é da tabela toda, sem coluna de instância', async () => {
    await resetar()
    await criarInstancia(supabase, 'wa01-grl-6', { priority: 1 })
    await criarInstancia(supabase, 'wa02-grl-6', { priority: 2, role: 'reserva' })
    await setLimitesGlobais(supabase, invalidarCacheFlags, { diario: 1, horario: 100 })
    await inserirEnvioSimulado(supabase, { minutosAtras: 1 }) // já consumiu o único slot diário, "pela instância 1"

    await supabase.from('automacoes_config').update({ multi_whatsapp: true }).eq('id', 1)
    invalidarCacheFlags()
    fakeEvolution.controlarInstancia('wa01-grl-6', { comportamento: 'ok' })
    fakeEvolution.controlarInstancia('wa02-grl-6', { comportamento: 'ok' })

    const conta = await criarContaDeTeste(supabase)
    const resultado = await enviarCobrancaComRoteamento({
      contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
      clienteTelefone: conta.telefone_cobranca, valor: conta.valor, mensagem: 'Teste 6', origem: 'cron',
    })
    assert.equal(resultado.status, 'blocked')
    assert.equal(resultado.reason, 'limite_global_diario', 'trocar de instância (wa01 -> wa02 disponível) não deveria abrir um novo teto')
    assert.equal(fakeEvolution.mensagensEnviadas.length, 0)
  })

  await t.test('8. failover técnico (whatsapp_failover=true, 1ª falha, 2ª tentativa) não burla o teto global — checado 1x antes de qualquer tentativa', async () => {
    await resetar()
    await criarInstancia(supabase, 'wa01-grl-8', { priority: 1 })
    await criarInstancia(supabase, 'wa02-grl-8', { priority: 2, role: 'reserva' })
    await setLimitesGlobais(supabase, invalidarCacheFlags, { diario: 0, horario: 100 }) // já no limite antes de começar
    await supabase.from('automacoes_config').update({ multi_whatsapp: true, whatsapp_failover: true }).eq('id', 1)
    invalidarCacheFlags()
    fakeEvolution.controlarInstancia('wa01-grl-8', { comportamento: 'unavailable' })
    fakeEvolution.controlarInstancia('wa02-grl-8', { comportamento: 'ok' })

    const conta = await criarContaDeTeste(supabase)
    const resultado = await enviarCobrancaComRoteamento({
      contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
      clienteTelefone: conta.telefone_cobranca, valor: conta.valor, mensagem: 'Teste 8', origem: 'cron',
    })
    assert.equal(resultado.status, 'blocked')
    assert.equal(resultado.reason, 'limite_global_diario')
    assert.equal(fakeEvolution.mensagensEnviadas.length, 0, 'nem a instância principal nem a reserva deveriam ter sido tentadas — bloqueado antes de qualquer tentativa')
  })

  await t.test('7. retry/failover bem-sucedido conta como 1 envio só (não duplica) quando o caller registra o resultado', async () => {
    await resetar()
    await criarInstancia(supabase, 'wa01-grl-7', { priority: 1 })
    await criarInstancia(supabase, 'wa02-grl-7', { priority: 2, role: 'reserva' })
    await setLimitesGlobais(supabase, invalidarCacheFlags, { diario: 30, horario: 10 })
    await supabase.from('automacoes_config').update({ multi_whatsapp: true, whatsapp_failover: true }).eq('id', 1)
    invalidarCacheFlags()
    fakeEvolution.controlarInstancia('wa01-grl-7', { comportamento: 'unavailable' })
    fakeEvolution.controlarInstancia('wa02-grl-7', { comportamento: 'ok' })

    const conta = await criarContaDeTeste(supabase)
    const resultado = await enviarCobrancaComRoteamento({
      contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
      clienteTelefone: conta.telefone_cobranca, valor: conta.valor, mensagem: 'Teste 7', origem: 'cron',
    })
    assert.equal(resultado.status, 'sent', '2ª instância (reserva) deveria ter assumido via failover')
    assert.equal(fakeEvolution.mensagensEnviadas.length, 1, 'só 1 envio real, mesmo com 2 tentativas (1 falha técnica + 1 sucesso)')

    // Só agora o caller (como cobranca-whatsapp.js faria de verdade) registra o resultado.
    await inserirEnvioSimulado(supabase, { minutosAtras: 0 })
    const r = await verificarLimiteGlobalEnvio()
    assert.equal(r.contagem_dia, 1, 'o retry interno não deveria ter incrementado o contador 2x')
  })

  await t.test('9. limite individual (por instância) continua funcionando mesmo com o global longe do teto', async () => {
    await resetar()
    await criarInstancia(supabase, 'wa01-grl-9', { priority: 1, daily_limit: 0, sent_today: 0 })
    await setLimitesGlobais(supabase, invalidarCacheFlags, { diario: 30, horario: 10 }) // global longe do limite
    await supabase.from('automacoes_config').update({ multi_whatsapp: true }).eq('id', 1)
    invalidarCacheFlags()
    fakeEvolution.controlarInstancia('wa01-grl-9', { comportamento: 'ok' })

    const conta = await criarContaDeTeste(supabase)
    const resultado = await enviarCobrancaComRoteamento({
      contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome,
      clienteTelefone: conta.telefone_cobranca, valor: conta.valor, mensagem: 'Teste 9', origem: 'cron',
    })
    assert.equal(resultado.status, 'failed', 'teto global permitiria, mas daily_limit=0 da própria instância deveria bloquear')
    assert.equal(resultado.motivo, 'sem_instancia_saudavel')
    assert.notEqual(resultado.reason, 'limite_global_diario', 'o bloqueio é da instância, não do teto global — não confundir os dois motivos')
  })

  await t.test('10. idempotência preservada — 2ª chamada da mesma cobrança lógica não é bloqueada nem duplicada pelo teto global', async () => {
    await resetar()
    await criarInstancia(supabase, 'wa01-grl-10', { priority: 1 })
    await setLimitesGlobais(supabase, invalidarCacheFlags, { diario: 30, horario: 10 })
    await supabase.from('automacoes_config').update({ multi_whatsapp: true }).eq('id', 1)
    invalidarCacheFlags()
    fakeEvolution.controlarInstancia('wa01-grl-10', { comportamento: 'ok' })

    const conta = await criarContaDeTeste(supabase)
    const args = {
      contasFinanceirasId: conta.id, etapa: 5, clienteNome: conta.pessoa_nome,
      clienteTelefone: conta.telefone_cobranca, valor: conta.valor, mensagem: 'Teste 10',
    }
    const r1 = await enviarCobrancaComRoteamento({ ...args, origem: 'cron' })
    const r2 = await enviarCobrancaComRoteamento({ ...args, origem: 'manual' })

    assert.equal(r1.status, 'sent')
    assert.equal(r2.motivo, 'idempotencia_existente')
    assert.equal(fakeEvolution.mensagensEnviadas.length, 1, 'teto global não deveria ter impedido o reconhecimento de idempotência nem gerado 2º envio')
  })

  await pararAmbienteDeTeste()
})
