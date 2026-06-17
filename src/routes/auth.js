import { Router } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { supabase } from '../lib/supabase.js'

const router = Router()

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, senha } = req.body
    if (!email || !senha) {
      return res.status(400).json({ erro: 'Email e senha são obrigatórios' })
    }

    const { data: usuario, error } = await supabase
      .from('usuarios')
      .select('id, nome, email, role, senha_hash, ativo')
      .eq('email', email.toLowerCase().trim())
      .single()

    if (error || !usuario) {
      return res.status(401).json({ erro: 'Credenciais inválidas' })
    }
    if (!usuario.ativo) {
      return res.status(403).json({ erro: 'Usuário inativo. Contate o administrador.' })
    }
    if (!usuario.senha_hash) {
      return res.status(401).json({ erro: 'Credenciais inválidas' })
    }

    const senhaValida = await bcrypt.compare(senha, usuario.senha_hash)
    if (!senhaValida) {
      return res.status(401).json({ erro: 'Credenciais inválidas' })
    }

    const token = jwt.sign(
      { id: usuario.id, email: usuario.email, role: usuario.role, nome: usuario.nome },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    )

    res.json({
      token,
      usuario: { id: usuario.id, nome: usuario.nome, email: usuario.email, role: usuario.role }
    })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/auth/me — retorna o usuário logado
router.get('/me', async (req, res) => {
  res.json({ usuario: req.user })
})

export default router
