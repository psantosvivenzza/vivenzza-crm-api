// Administração do módulo "Meu Ponto" — habilitar colaboradores, conceder/
// revogar escopo de gestor, cadastrar/revogar equipamentos (modo
// demonstração), e a trava mestra ponto_config.piloto_ativo. Montado com
// [auth, adminOnly] em src/index.js — nunca aberto para financeiro/vendedor.
import { Router } from 'express'
import { supabase } from '../lib/supabase-admin.server.js'
import { logarErroPonto } from '../lib/ponto/log.js'
import { EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA, MENSAGEM_EQUIPAMENTO_NAO_IMPLEMENTADO } from '../lib/ponto/equipamento.js'
import { iniciarVinculoEquipamento, ErroEquipamento } from '../lib/ponto/equipamentoService.js'
import { isUuidValido, exigirUuidNoParam } from '../lib/ponto/validacao.js'

const router = Router()

// GET /api/ponto-admin/habilitacoes
router.get('/habilitacoes', async (req, res) => {
  try {
    const { data: usuarios, error: erroUsuarios } = await supabase
      .from('usuarios')
      .select('id, nome, email, role, ativo')
      .order('nome', { ascending: true })
    if (erroUsuarios) throw erroUsuarios

    const { data: habilitacoes, error: erroHabilitacoes } = await supabase
      .from('ponto_habilitacoes')
      .select('usuario_id, habilitado, habilitado_por, atualizado_em')
    if (erroHabilitacoes) throw erroHabilitacoes

    const porUsuario = new Map((habilitacoes || []).map((h) => [h.usuario_id, h]))
    const itens = (usuarios || []).map((u) => ({
      ...u,
      ponto_habilitado: porUsuario.get(u.id)?.habilitado || false,
      ponto_atualizado_em: porUsuario.get(u.id)?.atualizado_em || null,
    }))

    res.json({ itens })
  } catch (err) {
    logarErroPonto('admin_listar_habilitacoes', err?.code)
    res.status(500).json({ erro: 'Não foi possível carregar as habilitações.' })
  }
})

// PATCH /api/ponto-admin/habilitacoes/:usuario_id — { habilitado, observacao }
router.patch('/habilitacoes/:usuario_id', exigirUuidNoParam('usuario_id'), async (req, res) => {
  const { habilitado, observacao } = req.body || {}
  if (typeof habilitado !== 'boolean') {
    return res.status(400).json({ erro: 'habilitado deve ser true ou false.' })
  }

  try {
    const { data: usuario, error: erroUsuario } = await supabase
      .from('usuarios')
      .select('id')
      .eq('id', req.params.usuario_id)
      .maybeSingle()
    if (erroUsuario) throw erroUsuario
    if (!usuario) return res.status(404).json({ erro: 'Usuário não encontrado.' })

    const { data: existente, error: erroExistente } = await supabase
      .from('ponto_habilitacoes')
      .select('id')
      .eq('usuario_id', req.params.usuario_id)
      .maybeSingle()
    if (erroExistente) throw erroExistente

    if (existente) {
      const { error: erroUpdate } = await supabase
        .from('ponto_habilitacoes')
        .update({ habilitado, habilitado_por: req.user.id, atualizado_em: new Date().toISOString() })
        .eq('id', existente.id)
      if (erroUpdate) throw erroUpdate
    } else {
      const { error: erroInsert } = await supabase
        .from('ponto_habilitacoes')
        .insert({ usuario_id: req.params.usuario_id, habilitado, habilitado_por: req.user.id })
      if (erroInsert) throw erroInsert
    }

    const { error: erroHistorico } = await supabase
      .from('ponto_habilitacoes_historico')
      .insert({
        usuario_id: req.params.usuario_id,
        habilitado,
        alterado_por: req.user.id,
        observacao: observacao?.trim() || null,
      })
    if (erroHistorico) throw erroHistorico

    res.json({ usuario_id: req.params.usuario_id, habilitado })
  } catch (err) {
    logarErroPonto('admin_alterar_habilitacao', err?.code)
    res.status(500).json({ erro: 'Não foi possível alterar a habilitação.' })
  }
})

// GET /api/ponto-admin/gestores
router.get('/gestores', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('ponto_gestores')
      .select('id, gestor_usuario_id, colaborador_usuario_id, concedido_por, concedido_em, revogado_em')
      .order('concedido_em', { ascending: false })
    if (error) throw error

    res.json({ itens: data || [] })
  } catch (err) {
    logarErroPonto('admin_listar_gestores', err?.code)
    res.status(500).json({ erro: 'Não foi possível carregar os gestores de ponto.' })
  }
})

// POST /api/ponto-admin/gestores — { gestor_usuario_id, colaborador_usuario_id }
router.post('/gestores', async (req, res) => {
  const { gestor_usuario_id, colaborador_usuario_id } = req.body || {}
  if (!gestor_usuario_id || !colaborador_usuario_id) {
    return res.status(400).json({ erro: 'gestor_usuario_id e colaborador_usuario_id são obrigatórios.' })
  }
  if (!isUuidValido(gestor_usuario_id) || !isUuidValido(colaborador_usuario_id)) {
    return res.status(400).json({ erro: 'gestor_usuario_id e colaborador_usuario_id devem ser UUID.' })
  }
  if (gestor_usuario_id === colaborador_usuario_id) {
    return res.status(400).json({ erro: 'Um colaborador não pode ser gestor de si mesmo.' })
  }

  try {
    const { data, error } = await supabase
      .from('ponto_gestores')
      .insert({ gestor_usuario_id, colaborador_usuario_id, concedido_por: req.user.id })
      .select('id')
      .single()
    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ erro: 'Este escopo já está concedido.' })
      }
      throw error
    }
    res.status(201).json(data)
  } catch (err) {
    logarErroPonto('admin_conceder_gestor', err?.code)
    res.status(500).json({ erro: 'Não foi possível conceder o escopo de gestão.' })
  }
})

// DELETE /api/ponto-admin/gestores/:id — revoga (soft, preserva histórico)
router.delete('/gestores/:id', exigirUuidNoParam('id'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('ponto_gestores')
      .update({ revogado_por: req.user.id, revogado_em: new Date().toISOString() })
      .eq('id', req.params.id)
      .is('revogado_em', null)
      .select('id')
      .maybeSingle()
    if (error) throw error
    if (!data) return res.status(404).json({ erro: 'Escopo não encontrado ou já revogado.' })

    res.json({ id: data.id, revogado: true })
  } catch (err) {
    logarErroPonto('admin_revogar_gestor', err?.code)
    res.status(500).json({ erro: 'Não foi possível revogar o escopo.' })
  }
})

// GET /api/ponto-admin/equipamentos
router.get('/equipamentos', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('ponto_equipamentos')
      .select('id, usuario_id, identificador, status, modo, cadastrado_por, cadastrado_em, revogado_em')
      .order('cadastrado_em', { ascending: false })
    if (error) throw error

    res.json({ itens: data || [] })
  } catch (err) {
    logarErroPonto('admin_listar_equipamentos', err?.code)
    res.status(500).json({ erro: 'Não foi possível carregar os equipamentos.' })
  }
})

// POST /api/ponto-admin/equipamentos — { usuario_id, identificador }
// modo é sempre 'demonstracao' nesta etapa (ver especificação seção 2.5) —
// ignorado se o cliente tentar enviar outro valor, nunca confiado do corpo
// da requisição.
router.post('/equipamentos', async (req, res) => {
  const { usuario_id, identificador } = req.body || {}
  if (!usuario_id || !identificador?.trim()) {
    return res.status(400).json({ erro: 'usuario_id e identificador são obrigatórios.' })
  }
  if (!isUuidValido(usuario_id)) {
    return res.status(400).json({ erro: 'usuario_id deve ser um UUID.' })
  }

  try {
    const { data: equipamento, error } = await supabase
      .from('ponto_equipamentos')
      .insert({ usuario_id, identificador: identificador.trim(), modo: 'demonstracao', cadastrado_por: req.user.id })
      .select('id')
      .single()
    if (error) throw error

    const { error: erroEvento } = await supabase
      .from('ponto_equipamento_eventos')
      .insert({ equipamento_id: equipamento.id, usuario_id, evento: 'vinculado', executado_por: req.user.id })
    if (erroEvento) throw erroEvento

    res.status(201).json({ id: equipamento.id, modo: 'demonstracao' })
  } catch (err) {
    logarErroPonto('admin_cadastrar_equipamento', err?.code)
    res.status(500).json({ erro: 'Não foi possível cadastrar o equipamento.' })
  }
})

// POST /api/ponto-admin/equipamentos/:id/vinculos — gera o código de
// vínculo de uso único (passo 1 do protocolo, ver
// docs/meu-ponto/PROTOCOLO_COMPONENTE_WINDOWS.md). Atrás do mesmo gate
// estrutural que POST /api/ponto/marcacoes — enquanto
// EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA for false, gerar um código aqui não
// serviria pra nada (o endpoint que o consome, POST /api/ponto-equipamento/
// vincular, também está atrás do mesmo gate) — por isso fica bloqueado
// também, em vez de deixar um código "válido" sem nenhum uso possível.
router.post('/equipamentos/:id/vinculos', exigirUuidNoParam('id'), async (req, res) => {
  if (!EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA) {
    return res.status(501).json({ erro: MENSAGEM_EQUIPAMENTO_NAO_IMPLEMENTADO })
  }
  try {
    const vinculo = await iniciarVinculoEquipamento({ equipamentoId: req.params.id, criadoPor: req.user.id })
    res.status(201).json(vinculo)
  } catch (err) {
    if (err instanceof ErroEquipamento) {
      return res.status(err.status).json({ erro: err.status === 404 ? 'Equipamento não encontrado ou revogado.' : 'Não foi possível gerar o código de vínculo.' })
    }
    logarErroPonto('admin_iniciar_vinculo_equipamento', err?.code)
    res.status(500).json({ erro: 'Não foi possível gerar o código de vínculo.' })
  }
})

// DELETE /api/ponto-admin/equipamentos/:id — revoga (soft, preserva histórico)
router.delete('/equipamentos/:id', exigirUuidNoParam('id'), async (req, res) => {
  try {
    const { data: equipamento, error } = await supabase
      .from('ponto_equipamentos')
      .update({ status: 'revogado', revogado_por: req.user.id, revogado_em: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('status', 'ativo')
      .select('id, usuario_id')
      .maybeSingle()
    if (error) throw error
    if (!equipamento) return res.status(404).json({ erro: 'Equipamento não encontrado ou já revogado.' })

    const { error: erroEvento } = await supabase
      .from('ponto_equipamento_eventos')
      .insert({ equipamento_id: equipamento.id, usuario_id: equipamento.usuario_id, evento: 'revogado', executado_por: req.user.id })
    if (erroEvento) throw erroEvento

    res.json({ id: equipamento.id, revogado: true })
  } catch (err) {
    logarErroPonto('admin_revogar_equipamento', err?.code)
    res.status(500).json({ erro: 'Não foi possível revogar o equipamento.' })
  }
})

// GET /api/ponto-admin/config
router.get('/config', async (req, res) => {
  try {
    const { data, error } = await supabase.from('ponto_config').select('piloto_ativo, atualizado_por, atualizado_em').eq('id', true).single()
    if (error) throw error
    res.json(data)
  } catch (err) {
    logarErroPonto('admin_ler_config', err?.code)
    res.status(500).json({ erro: 'Não foi possível carregar a configuração do piloto.' })
  }
})

// PATCH /api/ponto-admin/config — { piloto_ativo }
// Ação deliberada, autenticada, sempre manual — nunca deve ser ligada como
// efeito colateral de deploy (ver especificação, seção 6 — checklist de
// ativação). Esta rota só existe pra dar ao administrador o botão explícito;
// nada neste piloto chama isso automaticamente.
router.patch('/config', async (req, res) => {
  const { piloto_ativo } = req.body || {}
  if (typeof piloto_ativo !== 'boolean') {
    return res.status(400).json({ erro: 'piloto_ativo deve ser true ou false.' })
  }

  try {
    const { data, error } = await supabase
      .from('ponto_config')
      .update({ piloto_ativo, atualizado_por: req.user.id, atualizado_em: new Date().toISOString() })
      .eq('id', true)
      .select('piloto_ativo, atualizado_em')
      .single()
    if (error) throw error
    res.json(data)
  } catch (err) {
    logarErroPonto('admin_alterar_config', err?.code)
    res.status(500).json({ erro: 'Não foi possível alterar a configuração do piloto.' })
  }
})

export default router
