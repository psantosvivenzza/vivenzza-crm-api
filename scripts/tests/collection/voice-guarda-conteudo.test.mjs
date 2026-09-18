// Trava as regras que protegem a marca e o Art. 42 do CDC na ligação de voz.
// Estes testes não tocam banco de propósito: são a última linha de defesa e
// precisam rodar sempre, em qualquer máquina.
import test from 'node:test'
import assert from 'node:assert/strict'
import { filtrarFalaDoRobo, avaliarConfirmacaoResponsavel, mencionaAssuntoFinanceiro, RESPOSTA_ASSUNTO_A_TERCEIRO } from '../../../src/lib/voice/guardaConteudo.js'
import { montarSaudacao, primeiroNome, saudacaoDoDia } from '../../../src/lib/voice/saudacao.js'
import { validarTelefoneBrasileiro } from '../../../src/lib/voice/outboundExternalTest.js'

test('NUNCA fala de dívida antes de a pessoa confirmar que é a responsável (Art. 42 CDC)', () => {
  const tentativas = [
    'Estou ligando sobre uma cobrança em aberto',
    'Há um título vencido no valor de R$ 230,00',
    'Consta um débito em atraso no cadastro',
    'Podemos fazer o parcelamento do boleto',
    'O saldo devedor é de 1.250,00',
    'Se não pagar vamos protestar',
  ]
  for (const t of tentativas) {
    const r = filtrarFalaDoRobo(t, { responsavelConfirmado: false })
    assert.equal(r.bloqueado, true, `deveria bloquear: ${t}`)
    assert.equal(r.texto, RESPOSTA_ASSUNTO_A_TERCEIRO)
  }
})

test('depois da confirmação, a fala do modelo passa', () => {
  const r = filtrarFalaDoRobo('Consta um título vencido de R$ 230,00. Podemos parcelar?', { responsavelConfirmado: true })
  assert.equal(r.bloqueado, false)
})

test('resposta vazia nunca vira silêncio — vira a frase fixa', () => {
  for (const vazio of ['', '   ', null, undefined]) {
    const r = filtrarFalaDoRobo(vazio, { responsavelConfirmado: true })
    assert.equal(r.bloqueado, true)
    assert.ok(r.texto.length > 0)
  }
})

test('confirmação de identidade é conservadora: na dúvida NÃO confirma', () => {
  for (const sim of ['Sim, sou eu', 'É ele', 'Pode falar', 'Isso mesmo', 'Sim', 'Sou o responsável', 'Eu que cuido']) {
    assert.equal(avaliarConfirmacaoResponsavel(sim), true, `deveria confirmar: ${sim}`)
  }
  for (const nao of ['Não é ele', 'Ele não está', 'Vou chamar ela', 'Só um minuto', 'Número errado', 'Ela foi almoçar', '', 'alô']) {
    assert.equal(avaliarConfirmacaoResponsavel(nao), false, `NÃO deveria confirmar: ${nao}`)
  }
})

test('negação vence confirmação na mesma frase', () => {
  assert.equal(avaliarConfirmacaoResponsavel('Sim, mas não sou eu, vou chamar'), false)
})

test('saudação pede a pessoa pelo nome, e nunca usa razão social como nome', () => {
  assert.match(montarSaudacao('MARIA TEREZINHA DA SILVA'), /Falo com Maria\?$/)
  assert.match(montarSaudacao('BELEZA PURA LTDA'), /respons[áa]vel pelo financeiro/)
  assert.match(montarSaudacao(null), /respons[áa]vel pelo financeiro/)
  assert.equal(primeiroNome('SALAO X'), null)
  assert.equal(primeiroNome('  '), null)
})

test('a saudação nunca menciona cobrança', () => {
  for (const nome of ['Maria', null, 'BELEZA PURA LTDA']) {
    assert.equal(mencionaAssuntoFinanceiro(montarSaudacao(nome)), false)
  }
})

test('período do dia acompanha o horário de Brasília', () => {
  const d = (iso) => saudacaoDoDia(new Date(iso))
  assert.equal(d('2026-09-17T12:00:00Z'), 'bom dia')   // 09:00 BRT
  assert.equal(d('2026-09-17T18:00:00Z'), 'boa tarde') // 15:00 BRT
  assert.equal(d('2026-09-17T23:00:00Z'), 'boa noite') // 20:00 BRT
})

test('telefone malformado nunca é discado (ligar para terceiro é o pior desfecho)', () => {
  assert.equal(validarTelefoneBrasileiro('+5551991567661').valido, true)
  assert.equal(validarTelefoneBrasileiro('51991567661').valido, true)
  for (const ruim of ['991567661', '+555199156766', '+5551891567661', '+5551999999999', '', null, 'abc']) {
    assert.equal(validarTelefoneBrasileiro(ruim).valido, false, `deveria reprovar: ${ruim}`)
  }
})

// --- Achado do piloto real de 18/09/2026 -------------------------------
// Na 1a ligacao atendida, o cliente respondeu "Não." ao "Falo com Jorge?" e o
// robô disse "uma pessoa da Vivenzza entra em contato" e DESLIGOU. Negar ser
// o responsável é a resposta mais comum da abertura e nunca pode encerrar a
// ligação nem virar pedido de atendimento humano.
test('negação de identidade é reconhecida em todas as formas comuns', async () => {
  const { ehNegacaoDeIdentidade } = await import('../../../src/lib/voice/guardaConteudo.js')
  for (const nao of [
    'Não.', 'não', 'Não é ele', 'Ele não está', 'Ela não está agora',
    'Não se encontra', 'Ele não trabalha mais aqui', 'Vou chamar', 'Um momento',
  ]) {
    assert.equal(ehNegacaoDeIdentidade(nao), true, `deveria ser negação: ${nao}`)
  }
  for (const sim of ['Sim, sou eu', 'Pode falar', 'Isso mesmo', 'É ele', '']) {
    assert.equal(ehNegacaoDeIdentidade(sim), false, `NÃO é negação: ${sim}`)
  }
})

test('a resposta a quem nega identidade nunca menciona cobrança', async () => {
  const { RESPOSTA_ASSUNTO_A_TERCEIRO, mencionaAssuntoFinanceiro } = await import('../../../src/lib/voice/guardaConteudo.js')
  assert.equal(mencionaAssuntoFinanceiro(RESPOSTA_ASSUNTO_A_TERCEIRO), false)
})

// Achado do piloto real: uma ligação foi atendida por caixa postal e o robô
// conversou 36s com a secretária eletrônica. Recado de cobrança em caixa
// postal é exposição a terceiro (Art. 42 CDC) e ainda queima o teto horário.
test('caixa postal é reconhecida pelas frases das operadoras brasileiras', async () => {
  const { ehCaixaPostal } = await import('../../../src/lib/voice/guardaConteudo.js')
  for (const cx of [
    'quando terminar a gravação.', 'Deixe seu recado após o sinal',
    'A caixa postal do número chamado', 'O número chamado não está disponível',
    'Grave sua mensagem', 'No momento não pode atender', 'depois do sinal',
    'correio de voz', 'deixe a sua mensagem',
  ]) {
    assert.equal(ehCaixaPostal(cx), true, `deveria detectar caixa postal: ${cx}`)
  }
  for (const humano of ['Sim, sou eu', 'Não', 'Pode falar', 'Já paguei semana passada', 'Quem fala?', '']) {
    assert.equal(ehCaixaPostal(humano), false, `NÃO é caixa postal: ${humano}`)
  }
})

test('caixa postal nunca recebe conteúdo de cobrança', async () => {
  const { filtrarFalaDoRobo } = await import('../../../src/lib/voice/guardaConteudo.js')
  // Mesmo que algo escape até aqui, o filtro de conteúdo continua valendo
  // enquanto não houve confirmação de responsável — e numa caixa postal
  // nunca há.
  const r = filtrarFalaDoRobo('Você tem um título vencido de R$ 1.409,44', { responsavelConfirmado: false })
  assert.equal(r.bloqueado, true)
})
