// FASE C.3A.1 (homologação, 2026-08-12) — evolution-health.js agora espelha
// status na Central de Instâncias (whatsapp_instances), sem duplicar
// healthcheck, sem enviar mensagem, e sem cadastrar a instância comercial
// como se fosse parte do motor de cobrança.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste, limparInstanciasDeTeste } from './_setup.mjs'

test('evolution-health.js: integração com whatsapp_instances', async (t) => {
  const fakeEvolution = await iniciarAmbienteDeTeste()
  const { supabase } = await import('../../../src/lib/supabase-admin.server.js')
  const { runEvolutionHealthCheck } = await import('../../../src/jobs/evolution-health.js')

  await t.test('1. healthcheck de vivenzza-financeiro (open) atualiza whatsapp_instances (connection_status/health_status)', async () => {
    await limparInstanciasDeTeste(supabase)
    await supabase.from('whatsapp_instances').insert({
      name: 'WhatsApp Financeiro 01', instance_name: 'teste-financeiro-01', priority: 1, role: 'principal', enabled: true,
    })
    fakeEvolution.resetar()
    fakeEvolution.controlarInstancia('teste-financeiro-01', { connectionStatus: 'open' })
    fakeEvolution.controlarInstancia('vivenzza', { connectionStatus: 'open' })

    await runEvolutionHealthCheck()

    const { data: instancia } = await supabase.from('whatsapp_instances').select('connection_status, health_status').eq('instance_name', 'teste-financeiro-01').single()
    assert.equal(instancia.connection_status, 'open')
    assert.equal(instancia.health_status, 'connected')
  })

  await t.test('2. healthcheck de vivenzza (comercial) NÃO cadastra automaticamente como reserva — update casa 0 linhas, não insere', async () => {
    await limparInstanciasDeTeste(supabase)
    await supabase.from('whatsapp_instances').insert({
      name: 'WhatsApp Financeiro 01', instance_name: 'teste-financeiro-01', priority: 1, role: 'principal', enabled: true,
    })
    fakeEvolution.resetar()
    fakeEvolution.controlarInstancia('teste-financeiro-01', { connectionStatus: 'open' })
    fakeEvolution.controlarInstancia('vivenzza', { connectionStatus: 'open' })

    await runEvolutionHealthCheck()

    const { data: todas } = await supabase.from('whatsapp_instances').select('instance_name')
    assert.deepEqual(todas.map((i) => i.instance_name).sort(), ['teste-financeiro-01'], 'nenhuma linha nova deveria ter sido criada pra "vivenzza"')
  })

  await t.test('3. healthcheck nunca chama sendText quando tudo está saudável (zero mensagem real)', async () => {
    await limparInstanciasDeTeste(supabase)
    await supabase.from('whatsapp_instances').insert({
      name: 'WhatsApp Financeiro 01', instance_name: 'teste-financeiro-01', priority: 1, role: 'principal', enabled: true,
    })
    fakeEvolution.resetar()
    fakeEvolution.controlarInstancia('teste-financeiro-01', { connectionStatus: 'open' })
    fakeEvolution.controlarInstancia('vivenzza', { connectionStatus: 'open' })

    await runEvolutionHealthCheck()
    assert.equal(fakeEvolution.mensagensEnviadas.length, 0)
  })

  await t.test('4. instância não cadastrada na Central não quebra o healthcheck (no-op silencioso)', async () => {
    await limparInstanciasDeTeste(supabase)
    fakeEvolution.resetar()
    fakeEvolution.controlarInstancia('teste-financeiro-01', { connectionStatus: 'close' })
    fakeEvolution.controlarInstancia('vivenzza', { connectionStatus: 'open' })

    // Sem nenhuma linha em whatsapp_instances — não deveria lançar.
    await assert.doesNotReject(() => runEvolutionHealthCheck())
  })

  await pararAmbienteDeTeste()
})
