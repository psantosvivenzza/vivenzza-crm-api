import { supabase } from '../lib/supabase.js'

export async function auth(req, res, next) {
  if (process.env.SKIP_AUTH === 'true') return next()

  const authHeader = req.headers.authorization

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ erro: 'Token de autenticação não fornecido' })
  }

  const token = authHeader.split(' ')[1]

  const { data: { user }, error } = await supabase.auth.getUser(token)

  if (error || !user) {
    return res.status(401).json({ erro: 'Token inválido ou expirado' })
  }

  req.user = user
  next()
}
