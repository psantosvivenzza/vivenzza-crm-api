// Trava DETERMINÍSTICA sobre o que o robô pode dizer.
//
// POR QUE ISTO EXISTE: a regra do Art. 42 do CDC (não expor o devedor a
// terceiro) estava escrita apenas como instrução no prompt do LLM. Instrução
// em prompt é intenção, não garantia — e o modelo que roda aqui é um Ollama
// local, pequeno. Se a recepcionista atende e pergunta "é sobre o quê?", uma
// única frase com "cobrança" ou "valor em aberto" já é a prática que o
// Art. 42 pune, e já houve condenação por vazar dado de cobrança a terceiro.
//
// Então o filtro é de código, não de prompt: ANTES de a pessoa confirmar que
// é o responsável, qualquer resposta que toque em dívida é descartada e
// substituída por uma frase fixa. Fail-closed por definição.

// Vocabulário proibido antes da confirmação de identidade.
const TERMOS_FINANCEIROS = [
  // Radicais, não palavras inteiras: "protestar" e "protesto" têm que cair
  // no mesmo filtro. Este teste ("Se não pagar vamos protestar") passou pela
  // primeira versão da lista e é exatamente o tipo de frase que não pode
  // chegar ao ouvido de quem atendeu o telefone.
  'cobran', 'd[ií]vida', 'd[ée]bito', 'inadimpl', 'atrasad', 'em atraso',
  'vencid', 'vencimento', 'boleto', 'fatura', 't[ií]tulo', 'pend[êe]ncia',
  'valor em aberto', 'saldo devedor', 'negativa', 'negativ[aá]', 'serasa', 'spc',
  'protest', 'jur[ií]dico', 'pagamento', 'pagar', 'pagou', 'quita',
  'parcelament', 'parcelar', 'r\\$', 'reais', 'nota fiscal',
]
const REGEX_FINANCEIRO = new RegExp(`(${TERMOS_FINANCEIROS.join('|')})`, 'i')

// Números com cara de dinheiro ("1.234,56", "230 reais").
const REGEX_DINHEIRO = /(\d{1,3}(\.\d{3})*,\d{2})|(\d+\s*reais)/i

export function mencionaAssuntoFinanceiro(texto) {
  if (!texto) return false
  const t = String(texto)
  return REGEX_FINANCEIRO.test(t) || REGEX_DINHEIRO.test(t)
}

// Resposta única permitida a quem ainda não se identificou como responsável.
export const RESPOSTA_ASSUNTO_A_TERCEIRO =
  'É um assunto comercial do seu interesse. Prefiro tratar direto com o responsável pelo financeiro. Qual o melhor horário para retornar?'

/**
 * Decide o que o robô REALMENTE vai falar.
 *
 * responsavelConfirmado=false  -> nenhuma palavra de dívida sai da boca dele.
 * responsavelConfirmado=true   -> o texto do LLM passa.
 *
 * Retorna { texto, bloqueado, motivo } — `bloqueado` é o que a auditoria
 * precisa para a gente saber com que frequência o modelo tentou vazar.
 */
export function filtrarFalaDoRobo(textoGerado, { responsavelConfirmado }) {
  const texto = String(textoGerado || '').trim()
  if (!texto) {
    return { texto: RESPOSTA_ASSUNTO_A_TERCEIRO, bloqueado: true, motivo: 'resposta_vazia' }
  }
  if (!responsavelConfirmado && mencionaAssuntoFinanceiro(texto)) {
    return {
      texto: RESPOSTA_ASSUNTO_A_TERCEIRO,
      bloqueado: true,
      motivo: 'assunto_financeiro_antes_da_confirmacao',
    }
  }
  return { texto, bloqueado: false, motivo: null }
}

// Reconhece a confirmação de identidade. Conservador de propósito: na
// dúvida, NÃO confirma — e o filtro acima continua valendo. Falso negativo
// custa uma frase a mais; falso positivo custa um processo.
const CONFIRMACOES = [
  /\b(sou eu|s[ou]u ele|sou ela)\b/i,
  // Sem \b antes de "é": em JS o \b é ASCII, então "É ele" no início da
  // frase NÃO casava com /\b[ée] ele\b/ — a confirmação mais comum de todas
  // passava batido. Pego pelo teste, não em produção.
  /(^|\s)[ée]\s+(ele|ela)\b/i, /(^|\s)[ée]\s+comigo\b/i,
  /\bpode falar\b/i, /\bisso mesmo\b/i,
  /\b(sim|isso|exato|exatamente|correto)\b.*\b(sou|falando|aqui)\b/i,
  /^\s*(sim|isso)\s*[.,!]?\s*$/i,
  /\bquem fala\b/i,
  /\b(sou|aqui [ée]) o respons[áa]vel\b/i,
  /\beu que cuido\b/i, /\b(sou|[ée]) do financeiro\b/i,
]
const NEGACOES = [
  // Mesmo problema do \b ASCII: /\bn[ãa]o [ée]\b/ não casava "Não é ele",
  // que é a recusa mais comum. Negação tem que vencer sempre — confirmar
  // por engano é o que libera falar de dívida com a pessoa errada.
  /n[ãa]o\s+[ée](\s|$)/i, /n[ãa]o\s+sou\b/i, /\bengano\b/i, /\bn[úu]mero errado\b/i,
  // Sem \b depois de vogal acentuada: em JS o \b é ASCII e "está" nunca
  // fecha limite de palavra. "Ele não está" passava batido.
  /(ele|ela|el[ea]s)\s+n[ãa]o\s+est[áa]/i, /n[ãa]o\s+se\s+encontra/i,
  /n[ãa]o\s+(trabalha|atende|[ée])\s+mais\s+aqui/i, /(saiu|n[ãa]o veio)\b/i,
  /\bvou chamar\b/i, /\bum momento\b/i, /\bs[óo] um minuto\b/i,
]

// A pessoa NEGOU ser a responsável (ou disse que ela não está). É a resposta
// mais comum da abertura e precisa de tratamento próprio: encerrar aqui, ou
// pior, mandar "uma pessoa da Vivenzza entra em contato", é jogar fora o
// contato. O certo é pedir o responsável / o melhor horário, sem NUNCA dizer
// do que se trata (Art. 42 do CDC).
// ALUCINAÇÃO DO WHISPER (achado do piloto, 18/09/2026). Em silêncio ou ruído,
// o Whisper não devolve vazio: ele INVENTA texto, e sempre os mesmos bordões,
// tirados das legendas com que foi treinado. Duas das três ligações que o
// painel marcou como "cliente pediu atendente" hoje tinham como transcrição
// "Legendas pela comunidade de Amara.org" — ninguém pediu nada, era silêncio.
//
// Sem este filtro, todo silêncio vira um turno com intenção UNKNOWN, UNKNOWN
// entra em INTENTS_SEMPRE_HUMANO, e o robô promete ao cliente que "uma pessoa
// da Vivenzza entra em contato". Promessa feita por causa de ruído.
const ALUCINACOES_WHISPER = [
  /amara\.org/i,
  /legendas? (pela|por|feitas? pela) comunidade/i,
  /legendado pela comunidade/i,
  /^\s*(obrigad[oa]|tchau|muito obrigad[oa])[.!]?\s*$/i,
  /subtitles? by/i,
  /^\s*\.{2,}\s*$/,
  /^\s*\[?(m[úu]sica|music|aplausos|risos)\]?\s*$/i,
  /inscreva-se no canal/i,
  /^\s*legenda[s]?\s*[:.]?\s*$/i,
]

export function ehAlucinacaoDoStt(transcricao) {
  const t = String(transcricao || '').trim()
  if (!t) return false
  // Transcrição muito curta em cima de uma gravação longa também é ruído,
  // mas isso quem avalia é quem tem a duração — aqui só o texto.
  return ALUCINACOES_WHISPER.some((r) => r.test(t))
}

// ACHADO DO PILOTO REAL (18/09/2026): uma ligação foi "atendida" por uma
// CAIXA POSTAL e o robô conversou com a secretária eletrônica por 36
// segundos — gastou minuto de trunk, ocupou o teto horário e registrou a
// tentativa como se tivesse falado com o cliente, o que empurra a régua para
// a próxima etapa sem contato nenhum ter existido. Pior: mensagem de
// cobrança em caixa postal é recado que qualquer um da casa ou do salão
// escuta, exatamente o que o Art. 42 do CDC pune.
//
// Detectar pela transcrição é mais confiável aqui que o AMD do Asterisk: a
// gravação já passa pelo Whisper de qualquer jeito, e as operadoras
// brasileiras usam um conjunto pequeno e previsível de frases.
const PADROES_CAIXA_POSTAL = [
  /caixa postal/i,
  /ap[óo]s o sinal/i,
  /depois do sinal/i,
  /deixe (o |a |os |as |sua |seu |suas |seus )*(recado|mensagem)/i,
  /grave (o |a |os |as |sua |seu |suas |seus )*(recado|mensagem)/i,
  /quando terminar a grava[çc][ãa]o/i,
  /n[ãa]o (pode|p[óo]de) atender( no momento)?/i,
  /n[ãa]o est[áa] dispon[íi]vel/i,
  /o n[úu]mero (chamado|discado)/i,
  /(voice ?mail|correio de voz)/i,
  /tim torpedo|vivo recado|claro recado|oi recado/i,
  /desligue( ou aguarde)?/i,
]

export function ehCaixaPostal(transcricao) {
  const t = String(transcricao || '')
  if (!t.trim()) return false
  return PADROES_CAIXA_POSTAL.some((r) => r.test(t))
}

export function ehNegacaoDeIdentidade(transcricao) {
  const t = String(transcricao || '').trim()
  if (!t) return false
  if (/^\s*n[ãa]o\s*[.,!]?\s*$/i.test(t)) return true
  return NEGACOES.some((r) => r.test(t))
}

export function avaliarConfirmacaoResponsavel(transcricao) {
  const t = String(transcricao || '')
  if (!t.trim()) return false
  if (NEGACOES.some((r) => r.test(t))) return false
  return CONFIRMACOES.some((r) => r.test(t))
}

// Só o pedido EXPLÍCITO de atendente vira tarefa de retorno. "Não entendi o
// que a pessoa falou" (UNKNOWN) NÃO é pedido de humano: no piloto de
// 18/09/2026, duas das três ligações marcadas como "pediu atendente" eram
// silêncio que o Whisper alucinou. Misturar os dois enche a fila da equipe de
// tarefa falsa — e fila com tarefa falsa é fila que ninguém olha.
const INTENTS_QUE_VIRAM_TAREFA = new Set([
  'QUERO_ATENDENTE',
  'CONTESTA_VALOR',
  'SEM_CONDICAO_AGORA',
])

export function pedidoMereceTarefa(intent) {
  return INTENTS_QUE_VIRAM_TAREFA.has(String(intent || '').toUpperCase())
}
