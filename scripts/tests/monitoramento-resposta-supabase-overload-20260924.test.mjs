// Regressão do job src/jobs/monitoramento-resposta.js após a correção do
// incidente de sobrecarga do Supabase (2026-09-24): a trava de reentrância
// (`emExecucao`) já existia e continua idêntica (não duplicada); o que este
// arquivo cobre é o que FOI adicionado — timeout fail-fast (.abortSignal) em
// toda chamada e teto de páginas — sem quebrar a lógica de escalonamento em
// si (15min/30min/2h, destinatários por nível, limpeza de episódio).
//
// Postgres local compartilhado (5433/vivenzza_dev) — mesmo cluster de
// dashboard-atendimento-supabase-overload-20260924.test.mjs; roda em
// processo separado (node --test por arquivo), sem overlap de dados porque
// cada teste cria seus próprios usuarios/leads com sufixo único.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { PG_USER, PG_PASSWORD, PG_HOST, PG_PORT, PG_DATABASE } from '../localdb-config.mjs'

process.env.NODE_ENV = 'test'
process.env.LOCAL_PG_URL = `postgres://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/${PG_DATABASE}`

let supabase, runMonitoramentoResposta
const usuarioIdsCriados = []
const leadIdsCriados = []
let VENDEDOR, ADMIN1, ADMIN2

before(async () => {
  ;({ supabase } = await import('../../src/lib/supabase-admin.server.js'))
  ;({ runMonitoramentoResposta } = await import('../../src/jobs/monitoramento-resposta.js'))

  const sufixo = Date.now()
  const criarUsuario = async (nome, role) => {
    const { data, error } = await supabase
      .from('usuarios')
      .insert({ nome, email: `${nome}-${sufixo}@teste.com`, role })
      .select('id')
      .single()
    if (error) throw error
    usuarioIdsCriados.push(data.id)
    return data.id
  }
  VENDEDOR = await criarUsuario('vendedor-monitoramento-teste', 'vendedor')
  ADMIN1 = await criarUsuario('admin1-monitoramento-teste', 'admin')
  ADMIN2 = await criarUsuario('admin2-monitoramento-teste', 'admin')
})

after(async () => {
  await supabase.from('notifications').delete().in('conversation_id', leadIdsCriados)
  await supabase.from('escalation_log').delete().in('lead_id', leadIdsCriados)
  await supabase.from('whatsapp_mensagens').delete().in('lead_id', leadIdsCriados)
  if (leadIdsCriados.length) await supabase.from('leads').delete().in('id', leadIdsCriados)
  if (usuarioIdsCriados.length) await supabase.from('usuarios').delete().in('id', usuarioIdsCriados)
})

async function criarLeadComUltimaMensagem(nome, direcao, minutosAtras) {
  const { data: lead, error: erroLead } = await supabase
    .from('leads')
    .insert({ nome, responsavel_id: VENDEDOR, etapa: 'novo', origem: 'manual' })
    .select('id')
    .single()
  if (erroLead) throw erroLead
  leadIdsCriados.push(lead.id)

  const criadoEm = new Date(Date.now() - minutosAtras * 60000).toISOString()
  const { error: erroMsg } = await supabase.from('whatsapp_mensagens').insert({
    lead_id: lead.id,
    direcao,
    mensagem: 'x',
    telefone: '5551999999999',
    created_at: criadoEm,
  })
  if (erroMsg) throw erroMsg
  return lead.id
}

async function notificacoesDoLead(leadId) {
  const { data, error } = await supabase
    .from('notifications')
    .select('user_id, escalation_level, title')
    .eq('conversation_id', leadId)
  if (error) throw error
  return data
}

async function niveisDoLead(leadId) {
  const { data, error } = await supabase
    .from('escalation_log')
    .select('level')
    .eq('lead_id', leadId)
  if (error) throw error
  return data.map((r) => r.level).sort()
}

test('nível 1 (15min): notifica só o vendedor responsável', async () => {
  const leadId = await criarLeadComUltimaMensagem('Lead 16min', 'entrada', 16)
  const resultado = await runMonitoramentoResposta()
  assert.equal(resultado.pulado, undefined)

  assert.deepEqual(await niveisDoLead(leadId), [1])
  const notifs = await notificacoesDoLead(leadId)
  assert.equal(notifs.length, 1)
  assert.equal(notifs[0].user_id, VENDEDOR)
  assert.equal(notifs[0].escalation_level, 1)
})

test('nível 2 (30min): notifica vendedor + todos os admins, preservando o nível 1', async () => {
  const leadId = await criarLeadComUltimaMensagem('Lead 31min', 'entrada', 31)
  await runMonitoramentoResposta()

  assert.deepEqual(await niveisDoLead(leadId), [1, 2])
  const notifs = await notificacoesDoLead(leadId)
  const porNivel = (n) => notifs.filter((x) => x.escalation_level === n).map((x) => x.user_id)
  assert.deepEqual(porNivel(1), [VENDEDOR])
  // Inclusão, não igualdade de conjunto: o seed sintético (supabase/seed.sql)
  // já cadastra um admin fixo ("Admin Teste") — o job corretamente notifica
  // TODOS os admins da tabela, não só os criados por este teste.
  assert.ok(porNivel(2).includes(VENDEDOR))
  assert.ok(porNivel(2).includes(ADMIN1))
  assert.ok(porNivel(2).includes(ADMIN2))
})

test('nível 3 (2h, crítico): notifica só admins nesse nível, mas todos os 3 níveis ficam registrados', async () => {
  const leadId = await criarLeadComUltimaMensagem('Lead 121min', 'entrada', 121)
  await runMonitoramentoResposta()

  assert.deepEqual(await niveisDoLead(leadId), [1, 2, 3])
  const notifs = await notificacoesDoLead(leadId)
  const porNivel = (n) => notifs.filter((x) => x.escalation_level === n).map((x) => x.user_id)
  assert.ok(!porNivel(3).includes(VENDEDOR), 'nível 3 é só pra admins, vendedor não deveria receber')
  assert.ok(porNivel(3).includes(ADMIN1))
  assert.ok(porNivel(3).includes(ADMIN2))
})

test('lead respondido (última mensagem = saída) limpa o episódio de escalonamento', async () => {
  const leadId = await criarLeadComUltimaMensagem('Lead respondido', 'entrada', 20)
  await runMonitoramentoResposta()
  assert.deepEqual(await niveisDoLead(leadId), [1], 'precondição: nível 1 registrado antes da resposta')

  const { error } = await supabase.from('whatsapp_mensagens').insert({
    lead_id: leadId,
    direcao: 'saida',
    mensagem: 'resposta do vendedor',
    telefone: '5551999999999',
    created_at: new Date().toISOString(),
  })
  if (error) throw error

  await runMonitoramentoResposta()
  assert.deepEqual(await niveisDoLead(leadId), [], 'episódio deveria ser liberado depois da resposta')
})

test('lead recém-criado sem espera suficiente não escalona nada', async () => {
  const leadId = await criarLeadComUltimaMensagem('Lead recente', 'entrada', 2)
  await runMonitoramentoResposta()
  assert.deepEqual(await niveisDoLead(leadId), [])
  assert.deepEqual(await notificacoesDoLead(leadId), [])
})

test('trava de reentrância (emExecucao) sobrevive às mudanças de timeout: execuções concorrentes não dobram notificação', async () => {
  const leadId = await criarLeadComUltimaMensagem('Lead concorrente', 'entrada', 17)

  const [r1, r2] = await Promise.all([runMonitoramentoResposta(), runMonitoramentoResposta()])
  const algumPulado = r1.pulado === true || r2.pulado === true
  assert.ok(algumPulado, 'uma das duas execuções concorrentes deveria ser pulada pela trava de reentrância')

  // Qualquer que seja a execução que "venceu", o resultado final é o mesmo
  // de uma execução única: 1 notificação de nível 1, nunca 2 (duplicada).
  const notifs = await notificacoesDoLead(leadId)
  assert.equal(notifs.length, 1, 'execuções concorrentes não podem gerar notificação duplicada pro mesmo episódio')
})
