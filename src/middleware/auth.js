export const auth = (req, res, next) => {
  if (process.env.SKIP_AUTH === 'true' || process.env.NODE_ENV === 'development') {
    req.user = { id: 'dev-user', email: 'dev@vivenzza.com.br', role: 'admin' }
    return next()
  }

  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ erro: 'Token de autenticação não fornecido' })
  }

  const token = authHeader.split(' ')[1]
  if (token === process.env.API_SECRET_KEY) {
    req.user = { id: 'api-user', email: 'api@vivenzza.com.br', role: 'admin' }
    return next()
  }

  return res.status(401).json({ erro: 'Token inválido' })
}
