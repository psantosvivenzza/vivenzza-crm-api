// Verificação criptográfica de equipamento NÃO existe nesta etapa (ver
// docs/meu-ponto/ESPECIFICACAO_MEU_PONTO.md, seção 2.5/5). Isto é
// DELIBERADAMENTE uma constante de código, não uma linha em ponto_config
// nem qualquer coisa exposta a endpoint administrativo: a ausência real da
// capacidade de verificar um equipamento não é algo que um admin possa
// "religar" pela UI mudando uma flag — só muda quando o componente local
// (chave protegida pelo SO, desafio de uso único, assinatura por operação,
// validação no servidor) for implementado e testado de verdade, o que é
// uma mudança de código, não de configuração.
//
// Enquanto isto for false, POST /api/ponto/marcacoes (criação DIRETA de
// marcação origem='normal') fica bloqueado incondicionalmente — mesmo com
// ponto_config.piloto_ativo=true em teste isolado. O único caminho
// operacional real é src/routes/ponto.js `/solicitacoes` (solicitação
// auditada, sempre com revisão humana antes de virar uma linha em
// ponto_marcacoes). Ver scripts/tests/ponto/equipamento-bloqueio.test.mjs.
export const EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA = false

export const MENSAGEM_EQUIPAMENTO_NAO_IMPLEMENTADO =
  'Marcação direta exige verificação de equipamento, que ainda não foi implementada nesta etapa do piloto. ' +
  'Use "Solicitar marcação" — sua tentativa fica registrada com foto/justificativa e revisada por um gestor antes de virar um registro oficial.'
