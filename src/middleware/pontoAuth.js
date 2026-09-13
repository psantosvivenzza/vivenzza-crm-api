// Permissões do módulo "Meu Ponto" — ver
// docs/meu-ponto/ESPECIFICACAO_MEU_PONTO.md, seção 4.
//
// Habilitação para bater ponto é uma flag por colaborador
// (ponto_habilitacoes), independente de usuarios.role. Gestor de ponto tem
// escopo explícito (ponto_gestores) — nunca é concedido automaticamente ao
// papel financeiro nem a qualquer outro papel existente. Tudo aqui valida no
// backend a partir de req.user.id; nunca aceita um identificador de
// colaborador vindo só do corpo/query sem checar o escopo real.
import { supabase } from '../lib/supabase-admin.server.js'
import { logarErroPonto } from '../lib/ponto/log.js'

// Achado da revisão de 2026-09-11: o JWT é stateless (src/middleware/auth.js
// só verifica a assinatura, nunca reconsulta o banco) — checar
// usuarios.ativo só nas rotas de decisão (como a revisão anterior fez) era
// insuficiente: um usuário desativado com JWT antigo ainda válido
// continuava consultando histórico, abrindo foto/URL assinada, criando
// solicitação/correção, exportando e administrando equipamentos/habilitações.
// Este middleware é aplicado no MOUNT dos três routers do módulo (index.js),
// nunca dentro de um handler específico — cobre tudo de uma vez. É mais
// estrito que o resto do CRM (auth.js só confere ativo no login) de
// propósito, e só para este módulo — não altera a autenticação de nenhum
// outro lugar do sistema.
export async function exigirUsuarioAtivo(req, res, next) {
  try {
    const { data, error } = await supabase.from('usuarios').select('ativo').eq('id', req.user.id).maybeSingle()
    if (error) throw error
    if (!data?.ativo) {
      return res.status(403).json({ erro: 'Sua conta está inativa.' })
    }
    next()
  } catch (err) {
    logarErroPonto('exigirUsuarioAtivo', err?.code)
    res.status(500).json({ erro: 'Não foi possível verificar seu acesso.' })
  }
}

export async function exigirPilotoAtivo(req, res, next) {
  try {
    const { data, error } = await supabase
      .from('ponto_config')
      .select('piloto_ativo')
      .eq('id', true)
      .single()
    if (error) throw error
    if (!data?.piloto_ativo) {
      return res.status(403).json({ erro: 'O piloto de ponto está desativado nesta instância.' })
    }
    next()
  } catch (err) {
    logarErroPonto('exigirPilotoAtivo', err?.code)
    res.status(500).json({ erro: 'Não foi possível verificar o estado do piloto de ponto.' })
  }
}

export async function exigirColaboradorHabilitado(req, res, next) {
  try {
    const { data, error } = await supabase
      .from('ponto_habilitacoes')
      .select('habilitado')
      .eq('usuario_id', req.user.id)
      .maybeSingle()
    if (error) throw error
    if (!data?.habilitado) {
      return res.status(403).json({ erro: 'Você não está habilitado para o piloto de ponto.' })
    }
    next()
  } catch (err) {
    logarErroPonto('exigirColaboradorHabilitado', err?.code)
    res.status(500).json({ erro: 'Não foi possível verificar sua habilitação de ponto.' })
  }
}

// admin vê tudo (req.pontoEscopoGestor = null = "sem restrição de escopo").
// Qualquer outro papel precisa de pelo menos 1 vínculo ativo em
// ponto_gestores; o escopo real (lista de colaborador_usuario_id) fica em
// req.pontoEscopoGestor para os handlers filtrarem as consultas.
export async function exigirGestorOuAdmin(req, res, next) {
  if (req.user?.role === 'admin') {
    req.pontoEscopoGestor = null
    return next()
  }
  try {
    const { data, error } = await supabase
      .from('ponto_gestores')
      .select('colaborador_usuario_id')
      .eq('gestor_usuario_id', req.user.id)
      .is('revogado_em', null)
    if (error) throw error
    if (!data || data.length === 0) {
      return res.status(403).json({ erro: 'Acesso restrito a gestores de ponto ou administradores.' })
    }
    req.pontoEscopoGestor = data.map((linha) => linha.colaborador_usuario_id)
    next()
  } catch (err) {
    logarErroPonto('exigirGestorOuAdmin', err?.code)
    res.status(500).json({ erro: 'Não foi possível verificar o escopo de gestão de ponto.' })
  }
}

// Usar dentro de um handler já protegido por exigirGestorOuAdmin, para
// checar um colaborador_id específico vindo de query/params contra o
// escopo carregado (null = admin = sem restrição).
export function colaboradorNoEscopo(req, colaboradorId) {
  if (req.pontoEscopoGestor === null) return true
  return req.pontoEscopoGestor.includes(colaboradorId)
}
