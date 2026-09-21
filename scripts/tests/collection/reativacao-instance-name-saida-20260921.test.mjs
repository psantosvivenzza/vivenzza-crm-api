// Continuação do achado da auditoria adversarial b264e419 (mesmo já corrigido
// em sdr.js/whatsapp.js pela PR #117): src/routes/reativacao.js grava
// mensagens de saída COMERCIAIS (follow-up automático de reativação) em
// whatsapp_mensagens sem preencher instance_name — a coluna existe desde a
// migration 20260101000041, criada especificamente pra distinguir instância
// comercial de financeira, mas o único ponto de insert de saída deste arquivo
// (dentro de enviarMensagemReativacao) nunca a preenchia. A PR #117 deixou
// este arquivo deliberadamente de fora do escopo (ver comentário no topo de
// whatsapp-mensagens-instance-name-saida-20260921.test.mjs) — esta é a PR
// separada por domínio prevista lá.
//
// Correção testada aqui: o insert em whatsapp_mensagens agora grava
// instance_name = EVOLUTION_INSTANCE — a MESMA constante server-side já usada
// na própria chamada evolutionApi.post que realizou o envio, nunca um valor
// vindo do lead/body. Fallback: se a coluna ainda não existir no ambiente
// (PGRST204 — mesmo tratamento de webhook-handler.js/sdr.js/whatsapp.js),
// regrava sem ela, sem perder o registro local nem reenviar (o envio real via
// Evolution já aconteceu antes de qualquer persistência).
//
// ESCOPO: só o único insert de saída deste arquivo (enviarMensagemReativacao).
// verificarElegiveis() (elegibilidade/ritmo/circuito de entrega) e
// detectarRespostaReativacao() (resposta do lead) não são exercitados aqui —
// nem o achado de instance_name os afeta, nem fazem parte da correção.
import { test, before, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { PG_USER, PG_PASSWORD, PG_PORT, PG_DATABASE } from '../../localdb-config.mjs'
import { criarFakeEvolution } from '../fakes/fakeEvolution.js'
import { criarFakeAnthropic } from '../fakes/fakeAnthropic.js'

process.env.NODE_ENV = 'test'
process.env.LOCAL_PG_URL = `postgres://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${PG_DATABASE}`
process.env.EVOLUTION_API_KEY = 'fake-key-teste'
process.env.ANTHROPIC_API_KEY = 'fake-key-teste'
process.env.EVOLUTION_INSTANCE = 'vivenzza' // mesmo default de produção — determinístico pro teste

const INSTANCIA_COMERCIAL_ESPERADA = 'vivenzza'

let supabase, enviarMensagemReativacao, fakeEvo, fakeClaude

// Terça-feira 14:00 BRT — dentro da janela de envio (dia útil, 09:00-17:30)
// checada por dentroDaJanelaReativacao(). Sem isso, enviarMensagemReativacao()
// retorna null sem tentar nada, por design (guard preservado — ver teste
// dedicado abaixo).
const AGORA_DENTRO_DO_HORARIO = new Date('2026-09-08T17:00:00.000Z')
// Domingo de madrugada — fora da janela, mesmo padrão usado nos outros testes
// de whatsapp/sdr para exercitar o guard de horário.
const AGORA_FORA_DO_HORARIO = new Date('2026-09-06T06:00:00.000Z')

before(async () => {
  fakeEvo = await criarFakeEvolution().iniciar()
  fakeClaude = await criarFakeAnthropic().iniciar()
  process.env.EVOLUTION_API_URL = fakeEvo.url
  process.env.ANTHROPIC_BASE_URL = fakeClaude.url

  ;({ supabase } = await import('../../../src/lib/supabase-admin.server.js'))
  ;({ enviarMensagemReativacao } = await import('../../../src/routes/reativacao.js'))
})

function comLimiteDeTempo(promessa, ms) {
  return Promise.race([promessa, new Promise((resolve) => setTimeout(resolve, ms))])
}

after(async () => {
  await comLimiteDeTempo(fakeEvo.parar(), 1500)
  await comLimiteDeTempo(fakeClaude.parar(), 1500)
  await new Promise((resolve) => setTimeout(resolve, 200))
  process.exit(process.exitCode ?? 0)
})

let contador = 0
function telefoneDeTeste() {
  contador++
  return `5551997${String(Date.now()).slice(-6)}${String(contador).padStart(2, '0')}`
}

async function criarLeadDeTeste(telefone, overrides = {}) {
  const vinteDiasAtras = new Date(AGORA_DENTRO_DO_HORARIO.getTime() - 20 * 86400000).toISOString()
  const { data, error } = await supabase.from('leads').insert({
    nome: `Lead reativação ${telefone}`,
    telefone,
    etapa: 'novo',
    origem: 'whatsapp',
    tipo: 'salao',
    qtd_followups_automaticos: 0,
    ultima_mensagem_em: vinteDiasAtras,
    status_reativacao: null,
    ...overrides,
  }).select('id').single()
  if (error) throw error
  return data.id
}

async function buscarMensagensSaida(telefone) {
  const { data } = await supabase.from('whatsapp_mensagens').select('*').eq('telefone', telefone).eq('direcao', 'saida')
  return data || []
}
async function buscarFila(telefone) {
  const { data } = await supabase.from('reativacao_fila').select('*').eq('telefone', telefone)
  return data || []
}
async function buscarLead(leadId) {
  const { data } = await supabase.from('leads').select('*').eq('id', leadId).single()
  return data
}
async function limparLead(telefone) {
  await supabase.from('whatsapp_mensagens').delete().eq('telefone', telefone)
  await supabase.from('reativacao_fila').delete().eq('telefone', telefone)
  await supabase.from('leads').delete().eq('telefone', telefone)
}

// Mesmo interceptor usado em whatsapp-mensagens-instance-name-saida-20260921.test.mjs:
// substitui a PRÓXIMA chamada supabase.from(tabela).<operacao>(...) (a N-ésima
// ocorrência) por um erro simulado, sem quebrar o encadeamento e sem impedir
// chamadas posteriores (o fallback real do código de produção) de rodarem
// normalmente contra o banco de teste.
function interceptarChamada(supabaseCliente, { tabela, operacao, erroSimulado, ocorrencia = 1 }) {
  const fromOriginal = supabaseCliente.from.bind(supabaseCliente)
  let vistas = 0
  supabaseCliente.from = (t) => {
    const builder = fromOriginal(t)
    if (t === tabela && typeof builder[operacao] === 'function') {
      const metodoOriginal = builder[operacao].bind(builder)
      builder[operacao] = (...args) => {
        vistas++
        const chain = metodoOriginal(...args)
        if (vistas === ocorrencia) {
          chain.then = (resolve, reject) => Promise.resolve({ data: null, error: erroSimulado }).then(resolve, reject)
        }
        return chain
      }
    }
    return builder
  }
  return () => { supabaseCliente.from = fromOriginal }
}

test('sucesso — grava instance_name = EVOLUTION_INSTANCE e preserva ordem envio→persistência', async (t) => {
  mock.timers.enable({ apis: ['Date'], now: AGORA_DENTRO_DO_HORARIO })
  t.after(() => mock.timers.reset())
  const tel = telefoneDeTeste()
  t.after(() => limparLead(tel))
  fakeEvo.resetar()
  fakeClaude.resetar()
  fakeClaude.controlar({ texto: 'Oi! Faz um tempo que a gente não conversa — tudo bem por aí?' })

  const leadId = await criarLeadDeTeste(tel)
  const lead = await buscarLead(leadId)

  const resultado = await enviarMensagemReativacao(lead)
  assert.ok(resultado, 'esperava envio bem-sucedido')
  assert.equal(resultado.tentativa, 1)

  // Envio real aconteceu antes de qualquer persistência local — a mensagem
  // chegou na instância comercial correta.
  const envios = fakeEvo.mensagensEnviadas.filter((m) => m.numero === tel)
  assert.equal(envios.length, 1)
  assert.equal(envios[0].instancia, INSTANCIA_COMERCIAL_ESPERADA)

  const saidas = await buscarMensagensSaida(tel)
  assert.equal(saidas.length, 1)
  assert.equal(saidas[0].instance_name, INSTANCIA_COMERCIAL_ESPERADA, 'a mensagem de saída da reativação precisa gravar a instância comercial que realmente enviou')
  assert.equal(saidas[0].evolution_id, envios[0].msgId)

  const fila = await buscarFila(tel)
  assert.equal(fila.length, 1)
  assert.equal(fila[0].status, 'enviado')

  const leadAtualizado = await buscarLead(leadId)
  assert.equal(leadAtualizado.qtd_followups_automaticos, 1)
  assert.equal(leadAtualizado.status_reativacao, 'ativo')
})

test('instância indisponível (Evolution falha) — nenhuma linha fantasma em whatsapp_mensagens, fila registra erro', async (t) => {
  mock.timers.enable({ apis: ['Date'], now: AGORA_DENTRO_DO_HORARIO })
  t.after(() => mock.timers.reset())
  const tel = telefoneDeTeste()
  t.after(() => limparLead(tel))
  fakeEvo.resetar()
  fakeClaude.resetar()
  fakeEvo.controlarInstancia(INSTANCIA_COMERCIAL_ESPERADA, { comportamento: 'unavailable' })
  t.after(() => fakeEvo.controlarInstancia(INSTANCIA_COMERCIAL_ESPERADA, { comportamento: 'ok' }))
  fakeClaude.controlar({ texto: 'Isto nunca deveria ser registrado localmente' })

  const leadId = await criarLeadDeTeste(tel)
  const lead = await buscarLead(leadId)

  const resultado = await enviarMensagemReativacao(lead)
  assert.equal(resultado, null, 'falha no envio real precisa propagar como null, nunca fingir sucesso')

  const saidas = await buscarMensagensSaida(tel)
  assert.equal(saidas.length, 0, 'sem confirmação de envio real, nenhuma linha (com ou sem instance_name) pode ser gravada em whatsapp_mensagens')

  const fila = await buscarFila(tel)
  assert.equal(fila.length, 1)
  assert.equal(fila[0].status, 'erro')
})

test('coluna instance_name ainda não existe (PGRST204 simulado) — fallback grava sem ela, sem duplicar o envio real', async (t) => {
  mock.timers.enable({ apis: ['Date'], now: AGORA_DENTRO_DO_HORARIO })
  t.after(() => mock.timers.reset())
  const tel = telefoneDeTeste()
  t.after(() => limparLead(tel))
  fakeEvo.resetar()
  fakeClaude.resetar()
  fakeClaude.controlar({ texto: 'Mensagem enviada mesmo com a coluna nova ausente' })

  const leadId = await criarLeadDeTeste(tel)
  const lead = await buscarLead(leadId)

  const remover = interceptarChamada(supabase, {
    tabela: 'whatsapp_mensagens', operacao: 'insert', ocorrencia: 1,
    erroSimulado: { code: 'PGRST204', message: "Could not find the 'instance_name' column of 'whatsapp_mensagens' in the schema cache" },
  })
  let resultado
  try {
    resultado = await enviarMensagemReativacao(lead)
  } finally {
    remover()
  }
  assert.ok(resultado, 'o fallback não pode impedir o retorno de sucesso — o envio real já aconteceu')

  const envios = fakeEvo.mensagensEnviadas.filter((m) => m.numero === tel)
  assert.equal(envios.length, 1, 'a coluna ausente não pode causar um segundo envio real — só o registro local usa fallback')

  const saidas = await buscarMensagensSaida(tel)
  assert.equal(saidas.length, 1, 'o fallback precisa gravar a linha mesmo sem a coluna nova — nunca perder o registro local por causa disso')
  assert.equal(saidas[0].mensagem, 'Mensagem enviada mesmo com a coluna nova ausente')
})

test('instância configurada — grava exatamente EVOLUTION_INSTANCE, nunca um valor vindo do lead', async (t) => {
  mock.timers.enable({ apis: ['Date'], now: AGORA_DENTRO_DO_HORARIO })
  t.after(() => mock.timers.reset())
  const tel = telefoneDeTeste()
  t.after(() => limparLead(tel))
  fakeEvo.resetar()
  fakeClaude.resetar()
  fakeClaude.controlar({ texto: 'Resposta padrão de teste' })

  const leadId = await criarLeadDeTeste(tel)
  const lead = await buscarLead(leadId)
  // Campo espúrio, nunca lido pelo código real — prova que instance_name vem
  // exclusivamente da constante server-side EVOLUTION_INSTANCE, mesmo que o
  // objeto lead carregue (por acidente ou não) um valor parecido.
  lead.instance_name = 'instancia-forjada-pelo-lead'

  await enviarMensagemReativacao(lead)

  const saidas = await buscarMensagensSaida(tel)
  assert.equal(saidas.length, 1)
  assert.equal(saidas[0].instance_name, INSTANCIA_COMERCIAL_ESPERADA)
  assert.notEqual(saidas[0].instance_name, 'instancia-forjada-pelo-lead')
})

test('guard preservado — fora da janela de envio, nada é enviado nem gravado', async (t) => {
  mock.timers.enable({ apis: ['Date'], now: AGORA_FORA_DO_HORARIO })
  t.after(() => mock.timers.reset())
  const tel = telefoneDeTeste()
  t.after(() => limparLead(tel))
  fakeEvo.resetar()
  fakeClaude.resetar()

  const leadId = await criarLeadDeTeste(tel)
  const lead = await buscarLead(leadId)

  const resultado = await enviarMensagemReativacao(lead)
  assert.equal(resultado, null)
  assert.equal(fakeEvo.mensagensEnviadas.filter((m) => m.numero === tel).length, 0)
  assert.equal((await buscarMensagensSaida(tel)).length, 0)
  assert.equal((await buscarFila(tel)).length, 0)
})

test('isolamento comercial/financeiro/SDR — instance_name da reativação nunca coincide com instância financeira, e não toca sdr_conversas', async (t) => {
  mock.timers.enable({ apis: ['Date'], now: AGORA_DENTRO_DO_HORARIO })
  t.after(() => mock.timers.reset())
  const tel = telefoneDeTeste()
  t.after(() => limparLead(tel))
  fakeEvo.resetar()
  fakeClaude.resetar()
  fakeClaude.controlar({ texto: 'Mensagem 100% comercial de reativação' })

  // Não confia na linha financeira semeada pela migration 20260101000029
  // continuar presente: outros arquivos desta suíte (ex: multi-whatsapp-c1.
  // test.mjs, via limparInstanciasDeTeste) apagam TODA a tabela
  // whatsapp_instances sem restaurar o seed — achado pré-existente, mesma
  // categoria já documentada pra esta tabela (whatsapp-instance-health-
  // counters.test.mjs sem cleanup). Semeia a própria fixture financeira aqui,
  // deixando este teste determinístico independente da ordem/estado deixado
  // por outros arquivos.
  // role: 'reserva' (não 'principal') de propósito — evita colidir com
  // idx_whatsapp_instances_unica_principal_ativa caso outro arquivo desta
  // suíte já tenha deixado uma instância 'principal' habilitada no banco
  // compartilhado; irrelevante para o que este teste verifica (só precisa
  // de um instance_name financeiro cadastrado, papel não importa aqui).
  //
  // Limpeza defensiva: mesmo achado pré-existente documentado em
  // whatsapp-mensagens-instance-name-saida-20260921.test.mjs (PR #117) —
  // multi-whatsapp-operational-routing.test.mjs (teste H) cadastra
  // 'vivenzza'/'vivenzza-teste-cloud' em whatsapp_instances de propósito e
  // não limpa depois (último subteste do arquivo). Sem isto, a pré-condição
  // abaixo falha quando os arquivos rodam na mesma base compartilhada, sem
  // nenhuma relação com a correção desta PR.
  await supabase.from('whatsapp_instances').delete().in('instance_name', [INSTANCIA_COMERCIAL_ESPERADA, 'vivenzza-teste-cloud'])
  const { error: erroSeed } = await supabase.from('whatsapp_instances').upsert(
    { name: 'WhatsApp Financeiro (teste)', instance_name: 'vivenzza-financeiro', priority: 9, role: 'reserva', enabled: true },
    { onConflict: 'instance_name' },
  )
  if (erroSeed) throw erroSeed
  const { data: instanciasFinanceiras, error } = await supabase.from('whatsapp_instances').select('instance_name')
  if (error) throw error
  const nomesFinanceiros = new Set(instanciasFinanceiras.map((i) => i.instance_name))
  assert.ok(nomesFinanceiros.has('vivenzza-financeiro'), 'pré-condição do teste: a fixture financeira precisa existir')
  assert.ok(!nomesFinanceiros.has(INSTANCIA_COMERCIAL_ESPERADA), 'pré-condição do teste: a instância comercial não pode estar cadastrada como financeira')

  const { data: sdrAntes } = await supabase.from('sdr_conversas').select('id').eq('telefone', tel)

  const leadId = await criarLeadDeTeste(tel)
  const lead = await buscarLead(leadId)
  await enviarMensagemReativacao(lead)

  const saidas = await buscarMensagensSaida(tel)
  assert.equal(saidas.length, 1)
  assert.equal(saidas[0].instance_name, INSTANCIA_COMERCIAL_ESPERADA)
  assert.ok(!nomesFinanceiros.has(saidas[0].instance_name), 'instance_name gravado pela reativação nunca pode coincidir com uma instância financeira cadastrada')

  const { data: sdrDepois } = await supabase.from('sdr_conversas').select('id').eq('telefone', tel)
  assert.equal((sdrDepois ?? []).length, (sdrAntes ?? []).length, 'enviarMensagemReativacao não deve criar/alterar linhas em sdr_conversas — fluxo isolado do SDR')
})
