// 2026-08-17 — prova de integração REAL (Postgres local + Fake Evolution,
// nenhum WhatsApp de verdade) de que a regra de consolidação está
// corretamente LIGADA em executarReguaCobranca() (cron real) e que os guards
// existentes (DNC) continuam protegendo um grupo consolidado exatamente como
// protegiam um título único — nenhum deles foi modificado por este trabalho.
//
// executarReguaCobranca() só roda dentro de 08h-17h BRT — testes pulam com
// t.skip() fora da janela (mesmo padrão de financial-sync-guard-entrypoints.test.mjs).
// Cada envio real espera 45-90s (aguardarIntervaloAleatorio, não alterado
// aqui) — por isso este arquivo tem poucos testes, cada um cobrindo várias
// asserções por execução em vez de 1 execução por asserção.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste, criarContaDeTeste, telefoneDeTeste } from './_setup.mjs'

let supabase, executarReguaCobranca, _resetCacheParaTeste, fakeEvolution

before(async () => {
  fakeEvolution = await iniciarAmbienteDeTeste()
  ;({ supabase } = await import('../../../src/lib/supabase-admin.server.js'))
  ;({ executarReguaCobranca } = await import('../../../src/jobs/cobranca-whatsapp.js'))
  ;({ _resetCacheParaTeste } = await import('../../../src/lib/collection/financialSyncGuard.js'))
})
after(async () => { await pararAmbienteDeTeste() })

function dentroDaJanelaAgoraBrt() {
  const horaBrt = (new Date().getUTCHours() - 3 + 24) % 24
  return horaBrt >= 8 && horaBrt < 17
}

async function ligarCobrancaComSyncFresco() {
  await supabase.from('automacoes_config').update({ cobranca_whatsapp_ativa: true }).eq('id', 1)
  await supabase.from('sincronizacoes_financeiro').delete().eq('dry_run', false)
  const agora = new Date().toISOString()
  await supabase.from('sincronizacoes_financeiro').insert({
    status: 'concluido', dry_run: false, iniciado_em: agora, concluido_em: agora,
    total_lido: 1, total_atualizado: 0, total_sem_alteracao: 0, total_sem_match: 0,
    total_conflito: 0, total_cancelado: 0, total_com_erro: 0,
  })
  _resetCacheParaTeste()
}

// vencimento de HOJE cai na etapa 2 (D-1 a D0) — dentro da janela de qualquer
// horário do dia, sem depender de qual dia da semana é hoje.
function vencimentoHoje() {
  return new Date().toISOString().slice(0, 10)
}

// PROBLEMA REAL descoberto rodando a suíte completa: executarReguaCobranca()
// varre TODA conta elegível do banco, não só a deste teste. Isso tem duas
// consequências, ambas confirmadas rodando de verdade:
//
//   1. Este teste, sozinho, mandou mensagem pra contas alheias (resíduo de
//      OUTROS arquivos de teste, que rodam antes na mesma suíte, no mesmo
//      Postgres local nunca resetado entre arquivos) e estourou
//      LIMITE_POR_HORA=10 (constante de produção, não mexida aqui) ANTES de
//      chegar nos grupos deste teste — quebrando não só este arquivo como
//      dnc-guard-real-dispatch e multi-whatsapp-operational-routing (que
//      rodam DEPOIS na mesma suíte e herdam o teto já consumido).
//   2. Mesmo isolado de resíduo de OUTROS arquivos, a fixture do PRÓPRIO
//      seed.sql (~9 contas elegíveis, prefixo de telefone '55519999%',
//      aplicado uma vez por `db:local:reset`) sozinha já consome os 10
//      slots/hora antes de alcançar os grupos deste teste.
//
// Fix: SUPRIME (nunca deleta) qualquer conta elegível fora do controle deste
// teste durante a janela da régua — via em_revisao_financeira=true, que
// exclui da query de executarReguaCobranca() sem apagar a linha nem mudar
// nenhum outro campo. Restaura tudo no finally, então nenhum outro arquivo
// de teste (nem os 2 registros fixos de cobrancas_whatsapp que o seed cria)
// é afetado depois deste arquivo terminar.
async function suprimirOutrasContasElegiveis() {
  const { data } = await supabase
    .from('contas_financeiras')
    .select('id')
    .eq('tipo', 'receber')
    .in('status', ['aberta', 'vencida', 'pago_parcial'])
    .eq('em_revisao_financeira', false)
  const ids = (data ?? []).map((c) => c.id)
  if (ids.length) {
    await supabase.from('contas_financeiras').update({ em_revisao_financeira: true }).in('id', ids)
  }
  return ids
}
async function restaurarContas(ids) {
  if (ids.length) {
    await supabase.from('contas_financeiras').update({ em_revisao_financeira: false }).in('id', ids)
  }
}

beforeEach(async () => {
  delete process.env.COBRANCA_EXIGE_SYNC
  delete process.env.COBRANCA_SYNC_MAX_ATRASO_MIN
  fakeEvolution.resetar()
  await ligarCobrancaComSyncFresco()
})

test('regra de consolidação ligada de verdade no cron: grupo de 2 títulos → 1 mensagem com valor somado; DNC continua bloqueando; ambíguo nunca é cobrado; retry não duplica', async (t) => {
  if (!dentroDaJanelaAgoraBrt()) { t.skip('fora da janela 08h-17h BRT — executarReguaCobranca() bloquearia antes de chegar na lógica testada aqui'); return }

  const idsSuprimidos = await suprimirOutrasContasElegiveis()
  const idsMeus = []
  const telefoneGrupoDnc = telefoneDeTeste() // declarado fora do try — usado também na limpeza do finally

  try {
    const vencimento = vencimentoHoje()
    const telefoneGrupoNormal = telefoneDeTeste()
    const telefoneAmbiguoA = telefoneDeTeste()
    const telefoneAmbiguoB = telefoneDeTeste()

    const codigoClienteNormal = `CONSOLIDA-NORMAL-${Date.now()}`
    const codigoClienteDnc = `CONSOLIDA-DNC-${Date.now()}`
    const codigoClienteAmbiguo = `CONSOLIDA-AMBIGUO-${Date.now()}`

    // Grupo A — normal, deve consolidar e enviar 1 mensagem com R$700
    const a1 = await criarContaDeTeste(supabase, { codigo_cliente: codigoClienteNormal, telefone_cobranca: telefoneGrupoNormal, vencimento, valor: 400, pessoa_nome: 'Cliente Consolidação Normal' })
    const a2 = await criarContaDeTeste(supabase, { codigo_cliente: codigoClienteNormal, telefone_cobranca: telefoneGrupoNormal, vencimento, valor: 300, pessoa_nome: 'Cliente Consolidação Normal' })
    idsMeus.push(a1.id, a2.id)
    await supabase.from('contas_financeiras').update({ legacy_id: 'legacy-a1' }).eq('id', a1.id)
    await supabase.from('contas_financeiras').update({ legacy_id: 'legacy-a2' }).eq('id', a2.id)

    // Grupo B — mesmo desenho, mas telefone em DNC — não deve gerar nenhum envio
    const b1 = await criarContaDeTeste(supabase, { codigo_cliente: codigoClienteDnc, telefone_cobranca: telefoneGrupoDnc, vencimento, valor: 250, pessoa_nome: 'Cliente Consolidação DNC' })
    const b2 = await criarContaDeTeste(supabase, { codigo_cliente: codigoClienteDnc, telefone_cobranca: telefoneGrupoDnc, vencimento, valor: 250, pessoa_nome: 'Cliente Consolidação DNC' })
    idsMeus.push(b1.id, b2.id)
    await supabase.from('contas_financeiras').update({ legacy_id: 'legacy-b1' }).eq('id', b1.id)
    await supabase.from('contas_financeiras').update({ legacy_id: 'legacy-b2' }).eq('id', b2.id)
    await supabase.from('collection_do_not_contact').insert({ cliente_telefone: telefoneGrupoDnc, canal: 'todos' })

    // Grupo C — ambíguo (telefones divergentes no mesmo cliente+vencimento) — nunca deveria ser tentado
    const c1 = await criarContaDeTeste(supabase, { codigo_cliente: codigoClienteAmbiguo, telefone_cobranca: telefoneAmbiguoA, vencimento, valor: 100, pessoa_nome: 'Cliente Ambíguo' })
    const c2 = await criarContaDeTeste(supabase, { codigo_cliente: codigoClienteAmbiguo, telefone_cobranca: telefoneAmbiguoB, vencimento, valor: 100, pessoa_nome: 'Cliente Ambíguo' })
    idsMeus.push(c1.id, c2.id)
    await supabase.from('contas_financeiras').update({ legacy_id: 'legacy-c1' }).eq('id', c1.id)
    await supabase.from('contas_financeiras').update({ legacy_id: 'legacy-c2' }).eq('id', c2.id)

    const resumo1 = await executarReguaCobranca()

    assert.ok(resumo1.gruposAmbiguos >= 1, 'grupo C deveria ser contado como ambíguo')
    assert.ok(resumo1.gruposConsolidados >= 2, 'grupos A e B deveriam ser contados como consolidados (candidatos), independente do resultado final do envio')

    // Grupo C nunca deveria ter chegado nem perto de um envio
    const { data: cobrancasC } = await supabase.from('cobrancas_whatsapp').select('id').in('contas_financeiras_id', [c1.id, c2.id])
    assert.equal(cobrancasC.length, 0, 'grupo ambíguo nunca deveria gerar registro de cobrança')

    // Grupo A — exatamente 1 mensagem, valor somado, vinculada ao representante (a1 ou a2, determinístico)
    const { data: cobrancasA } = await supabase.from('cobrancas_whatsapp').select('*').in('contas_financeiras_id', [a1.id, a2.id])
    assert.equal(cobrancasA.length, 1, 'grupo de 2 títulos deveria gerar exatamente 1 registro de cobrança, nunca 2')
    assert.equal(Number(cobrancasA[0].valor), 700, 'valor da mensagem deveria ser a soma dos 2 saldos (400+300)')
    assert.match(cobrancasA[0].mensagem_enviada, /Esse valor corresponde a 2 títulos com o mesmo vencimento\./)
    const representanteA = cobrancasA[0].contas_financeiras_id

    // Grupo B — bloqueado por DNC, nenhum registro de cobrança criado (guard preservado)
    const { data: cobrancasB } = await supabase.from('cobrancas_whatsapp').select('id').in('contas_financeiras_id', [b1.id, b2.id])
    assert.equal(cobrancasB.length, 0, 'DNC deveria continuar bloqueando mesmo um grupo consolidado')

    // RETRY — roda a régua de novo no mesmo dia. Grupo A não pode gerar 2ª mensagem.
    const resumo2 = await executarReguaCobranca()
    const { data: cobrancasADepoisRetry } = await supabase.from('cobrancas_whatsapp').select('id, contas_financeiras_id').in('contas_financeiras_id', [a1.id, a2.id])
    assert.equal(cobrancasADepoisRetry.length, 1, 'retry no mesmo dia não pode duplicar a mensagem consolidada')
    assert.equal(cobrancasADepoisRetry[0].contas_financeiras_id, representanteA, 'retry deveria reconhecer o MESMO representante (idempotência determinística)')
  } finally {
    // Limpeza: restaura as contas suprimidas (nenhum outro arquivo de teste é
    // afetado) e remove só o que este teste criou — nunca toca na fixture do
    // seed.sql além de restaurá-la exatamente como estava. cobrancas_whatsapp
    // referencia contas_financeiras sem ON DELETE CASCADE — apagar os
    // registros de cobrança PRIMEIRO, senão o delete das contas falha por FK.
    await restaurarContas(idsSuprimidos)
    if (idsMeus.length) {
      await supabase.from('cobrancas_whatsapp').delete().in('contas_financeiras_id', idsMeus)
      await supabase.from('collection_do_not_contact').delete().eq('cliente_telefone', telefoneGrupoDnc)
      await supabase.from('contas_financeiras').delete().in('id', idsMeus)
    }
  }
})
