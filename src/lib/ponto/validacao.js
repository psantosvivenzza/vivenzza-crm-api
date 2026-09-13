// Validação mínima de UUID compartilhada entre os três routers do módulo
// "Meu Ponto" (ponto.js, ponto-gestao.js, ponto-admin.js).
//
// Achado da auditoria adversarial de 2026-09-12: nenhuma dessas rotas
// validava o FORMATO de um :id/colaborador_id/usuario_id antes de usá-lo
// num .eq()/.insert() do PostgREST. Um UUID malformado chega ao Postgres,
// que rejeita com 22P02 (invalid input syntax for type uuid) — o catch
// genérico de cada rota então devolve 500 com uma mensagem amigável, mas
// ainda assim é o código de erro ERRADO para "entrada do cliente é
// inválida" (deveria ser 400) e, em alguns pontos, arrisca deixar o
// detalhe do erro do Postgres visível dependendo de como o handler loga.
//
// Esta checagem roda SEMPRE antes de qualquer consulta ao banco e é pura
// validação de formato — nunca consulta existência nem escopo. Por isso
// não pode se tornar um oráculo de autorização: "formato inválido" (400)
// nunca depende de quem está perguntando nem do que existe no banco, e o
// 404 de "não encontrado ou fora do escopo" continua exatamente como já
// era (uma única mensagem genérica para as duas situações, decidida só
// DEPOIS da consulta) — não criamos um terceiro caminho de resposta que
// diferencie "existe mas não é seu" de "não existe".
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuidValido(valor) {
  return typeof valor === 'string' && UUID_RE.test(valor)
}

// Middleware para validar um :param de rota como UUID. Usar antes de
// qualquer handler que passe req.params[nomeParam] para uma consulta.
export function exigirUuidNoParam(nomeParam) {
  return (req, res, next) => {
    if (!isUuidValido(req.params[nomeParam])) {
      return res.status(400).json({ erro: `${nomeParam} inválido.` })
    }
    next()
  }
}
