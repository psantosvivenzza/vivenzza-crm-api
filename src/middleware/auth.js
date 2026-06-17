import jwt from 'jsonwebtoken'

export const auth = (req, res, next) => {
  if (process.env.SKIP_AUTH === 'true') {
    req.user = { id: 'dev-user', email: 'dev@vivenzza.com.br', role: 'admin' }
    return next()
  }

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
