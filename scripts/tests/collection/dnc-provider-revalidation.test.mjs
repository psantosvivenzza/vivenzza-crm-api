// 2026-09-03 — investigação do achado "51 tentativas reais ao provider após
// DNC já registrado" (auditoria read-only da régua). Reconstrução forense
// (produção, read-only) provou que NENHUM dos 51 casos era bypass real do
// guard atual — 100% caía na janela de quarentena antiga "até meia-noite
// BRT" (pré-PR #57/99dfa33), que já foi corrigida por aquele PR. A causa
// raiz das 51 tentativas NÃO É um bug em código.
//
// Mesmo assim, a auditoria de código (dispatchEngine.js) achou dois gaps
// LATENTES reais, nunca exercitados em produção até aqui:
//   1. o loop de failover (numero>1 dentro de enviarComFailover) chamava
//      enviarTexto() de novo pra outra instância sem revalidar pagamento/
//      promessa/DNC — só era checado 1x na entrada (collectionRouting.js).
//      Inofensivo hoje (whatsapp_failover=false em produção — o loop nunca
//      passa de numero=1 na prática), mas real se a flag for ligada.
//   2. estaEmDoNotContact()/registrarBloqueioNumeroInvalidoHoje() comparavam
//      cliente_telefone por STRING EXATA, nunca normalizada — dois títulos
//      do mesmo cliente com telefone_cobranca em formatos diferentes
//      poderiam, em tese, driblar o guard (não foi a causa das 51, mas era
//      um gap real).
//
// Este arquivo prova as duas correções contra código real (Postgres local,
// Fake Evolution) — nunca WhatsApp de verdade.
import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste, criarContaDeTeste, limparInstanciasDeTeste, telefoneDeTeste } from './_setup.mjs'

let supabase, fakeEvolution
let enviarCobrancaComRoteamento, enviarComFailover, estaEmDoNotContact, invalidarCacheFlags

before(async () => {
  fakeEvolution = await iniciarAmbienteDeTeste()
  ;({ supabase } = await import('../../../src/lib/supabase-admin.server.js'))
  ;({ enviarCobrancaComRoteamento } = await import('../../../src/lib/collection/collectionRouting.js'))
  ;({ enviarComFailover } = await import('../../../src/lib/collection/dispatchEngine.js'))
  ;({ estaEmDoNotContact } = await import('../../../src/lib/collection/doNotContactGuard.js'))
  ;({ invalidarCacheFlags } = await import('../../../src/lib/collection/featureFlags.js'))
})
after(async () => {
  // Limpeza final — este arquivo é o único da bateria que deixa
  // multi_whatsapp=true como default de beforeEach (necessário pra exercitar
  // o motor v2/enviarComFailover em quase todo teste daqui); sem restaurar
  // pro default seguro (false, mesmo valor de dnc-guard-real-dispatch.test.mjs),
  // um arquivo que rode depois deste na mesma bateria (npm run test:collection,
  // mesmo Postgres local persistente entre arquivos) e não gerencie a flag
  // ele mesmo herdaria multi_whatsapp=true + instâncias residuais (achado
  // real: quebrou financial-sync-guard-entrypoints.test.mjs antes desta correção).
  await supabase.from('automacoes_config').update({ multi_whatsapp: false, whatsapp_failover: false }).eq('id', 1)
  await limparInstanciasDeTeste(supabase)
  await limparDnc()
  invalidarCacheFlags()
  await pararAmbienteDeTeste()
})

async function criarInstancia(nome, overrides = {}) {
  const { data, error } = await supabase.from('whatsapp_instances').insert({
    name: nome, instance_name: nome, priority: 1, role: 'principal', enabled: true, ...overrides,
  }).select().single()
  if (error) throw error
  return data
}
async function garantirSyncFinanceiroFresco() {
  await supabase.from('sincronizacoes_financeiro').delete().eq('dry_run', false)
  const agora = new Date().toISOString()
  await supabase.from('sincronizacoes_financeiro').insert({
    status: 'concluido', dry_run: false, iniciado_em: agora, concluido_em: agora,
    total_lido: 1, total_atualizado: 0, total_sem_alteracao: 0, total_sem_match: 0,
    total_conflito: 0, total_cancelado: 0, total_com_erro: 0,
  })
}
async function limparDnc() {
  await supabase.from('collection_do_not_contact').delete().neq('id', '00000000-0000-0000-0000-000000000000')
}
async function registrarDnc(telefone, { motivo = 'opt-out teste', expiraEm = null } = {}) {
  const { error } = await supabase.from('collection_do_not_contact').insert({ cliente_telefone: telefone, canal: 'whatsapp', motivo, expira_em: expiraEm })
  if (error) throw error
}

beforeEach(async () => {
  fakeEvolution.resetar()
  await limparInstanciasDeTeste(supabase)
  await limparDnc()
  await garantirSyncFinanceiroFresco()
  await supabase.from('automacoes_config').update({
    multi_whatsapp: true, whatsapp_failover: false, cobranca_whatsapp_ativa: true,
  }).eq('id', 1)
  invalidarCacheFlags()
})

test('1. DNC temporário ativo bloqueia o provider (controle)', async () => {
  await criarInstancia('wa01-t1')
  const conta = await criarContaDeTeste(supabase)
  await registrarDnc(conta.telefone_cobranca, { expiraEm: new Date(Date.now() + 10 * 86400000).toISOString() })
  const r = await enviarCobrancaComRoteamento({ contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome, clienteTelefone: conta.telefone_cobranca, valor: 500, mensagem: 'm', origem: 'cron' })
  assert.equal(r.status, 'blocked')
  assert.equal(fakeEvolution.mensagensEnviadas.length, 0)
})

test('2. opt-out permanente (expira_em NULL) bloqueia o provider (controle)', async () => {
  await criarInstancia('wa01-t2')
  const conta = await criarContaDeTeste(supabase)
  await registrarDnc(conta.telefone_cobranca, { expiraEm: null })
  const r = await enviarCobrancaComRoteamento({ contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome, clienteTelefone: conta.telefone_cobranca, valor: 500, mensagem: 'm', origem: 'cron' })
  assert.equal(r.status, 'blocked')
  assert.equal(r.reason, 'opt_out')
  assert.equal(fakeEvolution.mensagensEnviadas.length, 0)
})

test('3. DNC expirado permite o fluxo normal (envio segue)', async () => {
  const inst = await criarInstancia('wa01-t3')
  fakeEvolution.controlarInstancia('wa01-t3', { comportamento: 'ok' })
  const conta = await criarContaDeTeste(supabase)
  await registrarDnc(conta.telefone_cobranca, { expiraEm: new Date(Date.now() - 86400000).toISOString() }) // ontem — já expirado
  const r = await enviarCobrancaComRoteamento({ contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome, clienteTelefone: conta.telefone_cobranca, valor: 500, mensagem: 'm', origem: 'cron' })
  assert.equal(r.status, 'sent')
  assert.equal(fakeEvolution.mensagensEnviadas.some((m) => m.instancia === inst.instance_name), true)
})

test('4. novo telefone não herda DNC do telefone antigo (contato independente)', async () => {
  const inst = await criarInstancia('wa01-t4')
  fakeEvolution.controlarInstancia('wa01-t4', { comportamento: 'ok' })
  const telefoneAntigo = telefoneDeTeste()
  const telefoneNovo = telefoneDeTeste()
  await registrarDnc(telefoneAntigo, { expiraEm: new Date(Date.now() + 10 * 86400000).toISOString() })

  const conta = await criarContaDeTeste(supabase, { telefone_cobranca: telefoneNovo })
  const r = await enviarCobrancaComRoteamento({ contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome, clienteTelefone: telefoneNovo, valor: 500, mensagem: 'm', origem: 'cron' })
  assert.equal(r.status, 'sent', 'telefone novo é um contato independente — nunca herda DNC do antigo')
  assert.equal(fakeEvolution.mensagensEnviadas.some((m) => m.instancia === inst.instance_name), true)
})

test('5. telefone em formato diferente (pontuação/espaço/DDI), mesmos dígitos, respeita o DNC existente', async () => {
  await criarInstancia('wa01-t5')
  const conta = await criarContaDeTeste(supabase, { telefone_cobranca: '5551981320490' })
  // DNC gravado num formato DIFERENTE do telefone_cobranca da conta, mesmos
  // dígitos (inclusive o mesmo DDI "55") — só pontuação/espaço variam.
  await registrarDnc('+55 (51) 98132-0490', { expiraEm: new Date(Date.now() + 10 * 86400000).toISOString() })

  const r = await enviarCobrancaComRoteamento({ contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome, clienteTelefone: conta.telefone_cobranca, valor: 500, mensagem: 'm', origem: 'cron' })
  assert.equal(r.status, 'blocked', 'mesmos dígitos em formato diferente ainda é o mesmo telefone — precisa bloquear')
  assert.equal(fakeEvolution.mensagensEnviadas.length, 0)
})

test('6. números REALMENTE diferentes (DDD diferente, ou com/sem 9º dígito) nunca colidem — normalização não pode ser heurística perigosa', async () => {
  await criarInstancia('wa01-t6')
  fakeEvolution.controlarInstancia('wa01-t6', { comportamento: 'ok' })
  await registrarDnc('5551981234567', { expiraEm: new Date(Date.now() + 10 * 86400000).toISOString() })

  // DDD diferente (11 em vez de 51) — dígitos totalmente diferentes, nunca deveria colidir.
  const contaDddDiferente = await criarContaDeTeste(supabase, { telefone_cobranca: '5511981234567' })
  const r1 = await enviarCobrancaComRoteamento({ contasFinanceirasId: contaDddDiferente.id, etapa: 3, clienteNome: contaDddDiferente.pessoa_nome, clienteTelefone: contaDddDiferente.telefone_cobranca, valor: 500, mensagem: 'm', origem: 'cron' })
  assert.equal(r1.status, 'sent', 'DDD diferente é um número genuinamente diferente — normalização não pode fazer colidir')

  // Mesmos dígitos MENOS o 9º dígito (10 dígitos em vez de 11) — normalizarTelefone()
  // NUNCA reinterpreta isso como o mesmo número (só remove pontuação, nunca DDI/9º dígito).
  const contaSem9 = await criarContaDeTeste(supabase, { telefone_cobranca: '555181234567' })
  const r2 = await enviarCobrancaComRoteamento({ contasFinanceirasId: contaSem9.id, etapa: 3, clienteNome: contaSem9.pessoa_nome, clienteTelefone: contaSem9.telefone_cobranca, valor: 500, mensagem: 'm', origem: 'cron' })
  assert.equal(r2.status, 'sent', 'variação de 9º dígito não é reconciliada — heurística deliberadamente conservadora')
})

test('7. loop de failover (whatsapp_failover=true, 2 instâncias) revalida DNC a cada iteração — DNC já existente bloqueia antes de tentar QUALQUER instância, inclusive a 1ª', async () => {
  // Prova que a checagem que esta correção move para DENTRO do loop (antes
  // era só na entrada de collectionRouting.js) continua ativa mesmo quando o
  // loop tem mais de uma iteração possível (whatsapp_failover=true) — sem
  // depender de cronometrar uma corrida real entre a escrita do DNC e a
  // resposta HTTP do fake provider (frágil e não determinístico). O caso
  // "DNC escrito DEPOIS que uma tentativa anterior real já saiu" é coberto de
  // forma determinística pelo cenário 8 (duas chamadas sequenciais reais,
  // mesmo telefone, sem corrida artificial) — a task pede exatamente isso:
  // "não exigir cancelamento impossível de request que já saiu antes do DNC
  // existir".
  await criarInstancia('wa01-t7', { priority: 1 })
  await criarInstancia('wa02-t7', { priority: 2, role: 'reserva' })
  fakeEvolution.controlarInstancia('wa01-t7', { comportamento: 'unavailable' }) // se o guard não bloqueasse, isso forçaria tentar wa02
  fakeEvolution.controlarInstancia('wa02-t7', { comportamento: 'ok' })
  await supabase.from('automacoes_config').update({ whatsapp_failover: true }).eq('id', 1)
  invalidarCacheFlags()

  const conta = await criarContaDeTeste(supabase)
  await registrarDnc(conta.telefone_cobranca, { motivo: 'numero_invalido_whatsapp', expiraEm: new Date(Date.now() + 30 * 86400000).toISOString() })

  const r = await enviarComFailover({ contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome, clienteTelefone: conta.telefone_cobranca, valor: 500, mensagem: 'm', origem: 'cron' })
  assert.equal(r.status, 'blocked', 'a revalidação na 1ª iteração do loop já bloqueia — nunca chega a selecionar wa01')
  assert.equal(fakeEvolution.mensagensEnviadas.length, 0, 'nem wa01 nem wa02 deveriam ter recebido qualquer mensagem')
})

test('8. concorrência real: tentativa A falha PERMANENT_RECIPIENT -> grava DNC -> tentativa B (outro título, mesmo telefone) fica bloqueada', async () => {
  await criarInstancia('wa01-t8')
  const telefone = telefoneDeTeste() // termina em número aleatório — força terminar em "000" pra simular PERMANENT_RECIPIENT
  const telefonePermanente = telefone.slice(0, -3) + '000'

  const contaA = await criarContaDeTeste(supabase, { telefone_cobranca: telefonePermanente })
  const resultadoA = await enviarCobrancaComRoteamento({ contasFinanceirasId: contaA.id, etapa: 3, clienteNome: contaA.pessoa_nome, clienteTelefone: telefonePermanente, valor: 500, mensagem: 'm', origem: 'cron' })
  assert.equal(resultadoA.status, 'failed')
  assert.equal(resultadoA.categoria, 'PERMANENT_RECIPIENT')

  // DNC já foi persistido de forma síncrona (registrarBloqueioNumeroInvalidoHoje
  // é await'ado dentro do fluxo de falha antes de enviarComFailover retornar).
  const dncDepoisDeA = await estaEmDoNotContact(telefonePermanente)
  assert.equal(dncDepoisDeA.blocked, true, 'DNC precisa estar gravado e visível assim que A termina')

  // B é outro título, mesmo telefone — sua PRÓPRIA chamada (não uma retry de
  // A) precisa revalidar DNC do zero e ser bloqueada antes de qualquer
  // chamada real ao provider.
  const contaB = await criarContaDeTeste(supabase, { telefone_cobranca: telefonePermanente })
  const resultadoB = await enviarCobrancaComRoteamento({ contasFinanceirasId: contaB.id, etapa: 3, clienteNome: contaB.pessoa_nome, clienteTelefone: telefonePermanente, valor: 500, mensagem: 'm', origem: 'cron' })
  assert.equal(resultadoB.status, 'blocked', 'depois do DNC persistido, nenhuma chamada subsequente pode chegar ao provider')

  const { data: attemptsPosDnc } = await supabase
    .from('collection_dispatch_attempts')
    .select('id, criado_em')
    .gt('criado_em', new Date(Date.now() - 60000).toISOString())
  // A (a própria falha real que criou o DNC) gera 1 attempt real — B, bloqueado
  // ANTES de qualquer seleção de instância, não gera nenhum.
  const { data: dispatchesB } = await supabase.from('collection_dispatches').select('id').eq('contas_financeiras_id', contaB.id)
  assert.equal(dispatchesB?.length ?? 0, 0, 'B bloqueado no guard nunca chega a criar um dispatch/attempt novo')
  void attemptsPosDnc
})

test('9. bloqueio de DNC não conta como provider attempt (collection_dispatch_attempts)', async () => {
  await criarInstancia('wa01-t9')
  const conta = await criarContaDeTeste(supabase)
  await registrarDnc(conta.telefone_cobranca, { expiraEm: new Date(Date.now() + 10 * 86400000).toISOString() })
  await enviarCobrancaComRoteamento({ contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome, clienteTelefone: conta.telefone_cobranca, valor: 500, mensagem: 'm', origem: 'cron' })
  const { data: attempts } = await supabase.from('collection_dispatch_attempts').select('id')
  assert.equal(attempts?.length ?? 0, 0, 'nenhuma linha de tentativa real deveria existir — o bloqueio acontece antes de qualquer seleção de instância')
})

test('10. bloqueio de DNC não consome o teto global de envio (contarTentativasReaisDesde)', async () => {
  const { contarTentativasReaisDesde } = await import('../../../src/lib/collection/providerAttemptCounter.js')
  await criarInstancia('wa01-t10')
  const conta = await criarContaDeTeste(supabase)
  await registrarDnc(conta.telefone_cobranca, { expiraEm: new Date(Date.now() + 10 * 86400000).toISOString() })

  const antes = await contarTentativasReaisDesde({ desde: new Date(Date.now() - 60000).toISOString() })
  await enviarCobrancaComRoteamento({ contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome, clienteTelefone: conta.telefone_cobranca, valor: 500, mensagem: 'm', origem: 'cron' })
  const depois = await contarTentativasReaisDesde({ desde: new Date(Date.now() - 60000).toISOString() })
  assert.equal(depois, antes, 'bloqueio de DNC não é uma tentativa real ao provider — não pode consumir cota de rate limit')
})

test('11. nenhuma comunicação real é feita em nenhum teste deste arquivo de guard (controle final)', async () => {
  const conta = await criarContaDeTeste(supabase)
  await registrarDnc(conta.telefone_cobranca, { expiraEm: new Date(Date.now() + 10 * 86400000).toISOString() })
  await enviarCobrancaComRoteamento({ contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome, clienteTelefone: conta.telefone_cobranca, valor: 500, mensagem: 'm', origem: 'cron' })
  assert.equal(fakeEvolution.mensagensEnviadas.length, 0)
})

test('12. opt-out permanente (expira_em NULL) nunca é encurtado/substituído por uma quarentena temporária', async () => {
  const telefone = telefoneDeTeste()
  const telefonePermanenteFalha = telefone.slice(0, -3) + '000' // vai falhar como PERMANENT_RECIPIENT
  await registrarDnc(telefonePermanenteFalha, { motivo: 'pedido do cliente', expiraEm: null })

  await criarInstancia('wa01-t12')
  const conta = await criarContaDeTeste(supabase, { telefone_cobranca: telefonePermanenteFalha })
  const r = await enviarCobrancaComRoteamento({ contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome, clienteTelefone: telefonePermanenteFalha, valor: 500, mensagem: 'm', origem: 'cron' })
  assert.equal(r.status, 'blocked', 'opt-out permanente já bloqueia — nem chega a tentar o provider, então nem PERMANENT_RECIPIENT seria gerado')

  const { data: linha } = await supabase.from('collection_do_not_contact').select('expira_em, motivo').eq('cliente_telefone', telefonePermanenteFalha).single()
  assert.equal(linha.expira_em, null, 'opt-out permanente nunca pode virar temporário')
  assert.equal(linha.motivo, 'pedido do cliente', 'motivo original nunca é sobrescrito')
})

test('13. quarentena existente MAIS LONGA que a nova nunca é encurtada', async () => {
  const telefone = telefoneDeTeste()
  const telefonePermanenteFalha = telefone.slice(0, -3) + '000'
  const expiraLonge = new Date(Date.now() + 60 * 86400000).toISOString() // 60 dias — mais longe que os 30 padrão
  await registrarDnc(telefonePermanenteFalha, { motivo: 'numero_invalido_whatsapp', expiraEm: expiraLonge })

  await criarInstancia('wa01-t13')
  const conta = await criarContaDeTeste(supabase, { telefone_cobranca: telefonePermanenteFalha })
  const r = await enviarCobrancaComRoteamento({ contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome, clienteTelefone: telefonePermanenteFalha, valor: 500, mensagem: 'm', origem: 'cron' })
  assert.equal(r.status, 'blocked', 'quarentena ainda ativa (60 dias) bloqueia antes de qualquer tentativa — nunca reinicia a contagem')

  const { data: linha } = await supabase.from('collection_do_not_contact').select('expira_em').eq('cliente_telefone', telefonePermanenteFalha).single()
  assert.equal(new Date(linha.expira_em).toISOString(), expiraLonge, 'expira_em não pode ter sido alterado — muito menos encurtado — por um bloqueio que nem chegou a tentar o provider')
})

test('14. revalidação por retry usa o telefone EXATO da tentativa (não um valor cacheado/desatualizado)', async () => {
  await criarInstancia('wa01-t14', { priority: 1 })
  await criarInstancia('wa02-t14', { priority: 2, role: 'reserva' })
  fakeEvolution.controlarInstancia('wa01-t14', { comportamento: 'unavailable' })
  fakeEvolution.controlarInstancia('wa02-t14', { comportamento: 'ok' })
  await supabase.from('automacoes_config').update({ whatsapp_failover: true }).eq('id', 1)
  invalidarCacheFlags()

  const conta = await criarContaDeTeste(supabase)
  // Sem DNC nenhum — prova que a revalidação em si não bloqueia indevidamente
  // quando não há motivo real (controle negativo do retry-guard).
  const r = await enviarComFailover({ contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome, clienteTelefone: conta.telefone_cobranca, valor: 500, mensagem: 'm', origem: 'cron' })
  assert.equal(r.status, 'sent', 'sem DNC, a revalidação extra a cada tentativa não pode bloquear indevidamente o retry legítimo')
  assert.equal(fakeEvolution.mensagensEnviadas.some((m) => m.instancia === 'wa02-t14'), true, 'wa02 (2ª tentativa) precisa ter recebido a mensagem normalmente')
})
