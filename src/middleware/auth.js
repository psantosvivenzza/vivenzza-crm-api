import jwt from 'jsonwebtoken'

export const auth = (req, res, next) => {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ erro: 'Token de autenticação não fornecido' })
  }

  const token = authHeader.split(' ')[1]

  // Compatibilidade com API_SECRET_KEY estático (integrações)
  if (process.env.API_SECRET_KEY && token === process.env.API_SECRET_KEY) {
    req.user = { id: 'api-user', email: 'api@vivenzza.com.br', role: 'admin' }
    return next()
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    req.user = decoded
    next()
  } catch {
    return res.status(401).json({ erro: 'Token inválido ou expirado' })
  }
}

export const adminOnly = (req, res, next) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ erro: 'Acesso restrito a administradores' })
  }
  next()
}

// Papéis com permissão pra operações financeiras (decisão explícita do
// responsável, 2026-09-07): só admin e financeiro — vendedor nunca, nem em
// título da própria carteira. Allowlist (não denylist): qualquer papel fora
// desta lista é bloqueado, inclusive ausente/desconhecido — diferente do
// gate de posse anterior (role==='vendedor'), que deixava passar qualquer
// coisa que não fosse exatamente 'vendedor'.
export const PAPEIS_FINANCEIROS = ['admin', 'financeiro']

// Usado nas mutações financeiras de src/routes/financeiro.js (criar/editar/
// cancelar/excluir/baixar/estornar/aprovar-rejeitar estorno/promessa) — e,
// desde a decisão de 2026-09-08, também no MOUNT inteiro (leitura + escrita)
// de 6 routers do bloco financeiro do menu em src/index.js: aging,
// dashboard-recuperacao, cobrancas, collection-shadow, collection-whatsapp,
// collection-contact-review — além de GET /relatorios/dre. "Ver o bloco" não
// é autorização automática pra qualquer coisa dentro dele: operações que são
// CONFIGURAÇÃO GLOBAL de automação, não gestão de conta/cliente específico
// (POST /api/cobrancas/toggle, POST /api/cobrancas/disparar), usam
// `adminOnly` direto na rota, por decisão explícita separada (2026-09-08) —
// ver comentário em src/routes/cobrancas.js.
export const adminOuFinanceiro = (req, res, next) => {
  if (!PAPEIS_FINANCEIROS.includes(req.user?.role)) {
    return res.status(403).json({ erro: 'Acesso restrito a administradores ou financeiro' })
  }
  next()
}
