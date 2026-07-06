import { Router } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { supabase } from '../lib/supabase.js'
import { auth } from '../middleware/auth.js'

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
router.get('/me', auth, async (req, res) => {
  res.json({ usuario: req.user })
})

// PATCH /api/auth/senha — troca senha do usuário logado
router.patch('/senha', async (req, res) => {
  try {
    const { senha_atual, nova_senha } = req.body
    if (!senha_atual || !nova_senha) {
      return res.status(400).json({ erro: 'Campos senha_atual e nova_senha são obrigatórios' })
    }
    if (nova_senha.length < 6) {
      return res.status(400).json({ erro: 'A nova senha deve ter pelo menos 6 caracteres' })
    }

    const { data: usuario, error } = await supabase
      .from('usuarios')
      .select('id, senha_hash')
      .eq('id', req.user.id)
      .single()

    if (error || !usuario) {
      return res.status(404).json({ erro: 'Usuário não encontrado' })
    }

    const senhaValida = await bcrypt.compare(senha_atual, usuario.senha_hash)
    if (!senhaValida) {
      return res.status(401).json({ erro: 'Senha atual incorreta' })
    }

    const nova_hash = await bcrypt.hash(nova_senha, 10)

    const { error: updateError } = await supabase
      .from('usuarios')
      .update({ senha_hash: nova_hash })
      .eq('id', req.user.id)

    if (updateError) throw updateError

    res.json({ mensagem: 'Senha atualizada com sucesso' })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

export default router
