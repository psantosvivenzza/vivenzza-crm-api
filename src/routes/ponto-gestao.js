// Painel de gestão de ponto — gestor vê só sua equipe autorizada
// (ponto_gestores), admin vê tudo. Nunca reaproveita adminOuFinanceiro: o
// papel financeiro não ganha acesso automático a isto (ver especificação,
// seção 4). Montado com [auth, exigirGestorOuAdmin] em src/index.js.
import { Router } from 'express'
import { supabase } from '../lib/supabase-admin.server.js'
import { gerarUrlAssinada } from '../lib/ponto/fotoStorage.js'
import { logarErroPonto } from '../lib/ponto/log.js'
import { colaboradorNoEscopo } from '../middleware/pontoAuth.js'

const router = Router()

// Tipos válidos e a regra de quais tipo_solicitacao geram marcação
// automática ao aprovar agora vivem dentro de ponto_decidir_correcao /
// ponto_decidir_solicitacao (migration 20260101000050) — a decisão
// completa roda como uma transação só no banco, não em dois passos daqui.

// exigirUsuarioAtivo (usuarios.ativo) é aplicado no MOUNT deste router em
// index.js, cobrindo toda rota, não só decisão (achado da revisão de
// 2026-09-11 — checar isso só nas rotas de decisão era insuficiente).

// GET /api/ponto-gestao/colaboradores
router.get('/colaboradores', async (req, res) => {
  try {
    let consultaHabilitacoes = supabase
      .from('ponto_habilitacoes')
      .select('usuario_id, habilitado, atualizado_em')

    if (req.pontoEscopoGestor !== null) {
      if (req.pontoEscopoGestor.length === 0) return res.json({ itens: [] })
      consultaHabilitacoes = consultaHabilitacoes.in('usuario_id', req.pontoEscopoGestor)
    }

    const { data: habilitacoes, error: erroHabilitacoes } = await consultaHabilitacoes
    if (erroHabilitacoes) throw erroHabilitacoes
    if (!habilitacoes || habilitacoes.length === 0) return res.json({ itens: [] })

    const ids = habilitacoes.map((h) => h.usuario_id)
    const { data: usuarios, error: erroUsuarios } = await supabase
      .from('usuarios')
      .select('id, nome, email')
      .in('id', ids)
    if (erroUsuarios) throw erroUsuarios

    const usuariosPorId = new Map((usuarios || []).map((u) => [u.id, u]))
    const itens = habilitacoes
      .filter((h) => usuariosPorId.has(h.usuario_id))
      .map((h) => ({ ...usuariosPorId.get(h.usuario_id), habilitado: h.habilitado, atualizado_em: h.atualizado_em }))

    res.json({ itens })
  } catch (err) {
    logarErroPonto('gestao_listar_colaboradores', err?.code)
    res.status(500).json({ erro: 'Não foi possível carregar os colaboradores.' })
  }
})

// GET /api/ponto-gestao/marcacoes?colaborador_id=&inicio=&fim=&pagina=&limite=
router.get('/marcacoes', async (req, res) => {
  try {
    const { colaborador_id } = req.query
    if (colaborador_id && !colaboradorNoEscopo(req, colaborador_id)) {
      return res.status(403).json({ erro: 'Colaborador fora do seu escopo de gestão.' })
    }

    const pagina = Math.max(1, Number(req.query.pagina) || 1)
    const limite = Math.min(500, Math.max(1, Number(req.query.limite) || 30))
    const de = (pagina - 1) * limite

    let consulta = supabase
      .from('ponto_marcacoes')
      .select('id, usuario_id, tipo, origem, registrado_em, dia_brt, foto_id, sinalizado_para_revisao, motivo_sinalizacao, justificativa_contingencia', { count: 'exact' })
      .order('registrado_em', { ascending: false })
      .range(de, de + limite - 1)

    if (colaborador_id) {
      consulta = consulta.eq('usuario_id', colaborador_id)
    } else if (req.pontoEscopoGestor !== null) {
      if (req.pontoEscopoGestor.length === 0) return res.json({ itens: [], total: 0, pagina, limite })
      consulta = consulta.in('usuario_id', req.pontoEscopoGestor)
    }
    if (req.query.inicio) consulta = consulta.gte('dia_brt', req.query.inicio)
    if (req.query.fim) consulta = consulta.lte('dia_brt', req.query.fim)

    const { data, error, count } = await consulta
    if (error) throw error

    res.json({ itens: data || [], total: count || 0, pagina, limite })
  } catch (err) {
    logarErroPonto('gestao_listar_marcacoes', err?.code)
    res.status(500).json({ erro: 'Não foi possível carregar as marcações.' })
  }
})

// GET /api/ponto-gestao/marcacoes/:id/foto
router.get('/marcacoes/:id/foto', async (req, res) => {
  try {
    const { data: marcacao, error: erroMarcacao } = await supabase
      .from('ponto_marcacoes')
      .select('id, usuario_id, foto_id')
      .eq('id', req.params.id)
      .maybeSingle()
    if (erroMarcacao) throw erroMarcacao
    if (!marcacao || !colaboradorNoEscopo(req, marcacao.usuario_id)) {
      return res.status(404).json({ erro: 'Marcação não encontrada.' })
    }
    if (!marcacao.foto_id) {
      return res.status(404).json({ erro: 'Esta marcação não tem foto associada.' })
    }

    const { data: foto, error: erroFoto } = await supabase
      .from('ponto_fotos')
      .select('storage_path')
      .eq('id', marcacao.foto_id)
      .single()
    if (erroFoto) throw erroFoto

    const assinada = await gerarUrlAssinada(foto.storage_path)
    res.json(assinada)
  } catch (err) {
    logarErroPonto('gestao_obter_foto', err?.code)
    res.status(500).json({ erro: 'Não foi possível gerar o link da foto.' })
  }
})

// GET /api/ponto-gestao/correcoes?status=&colaborador_id=
router.get('/correcoes', async (req, res) => {
  try {
    const { colaborador_id, status } = req.query
    if (colaborador_id && !colaboradorNoEscopo(req, colaborador_id)) {
      return res.status(403).json({ erro: 'Colaborador fora do seu escopo de gestão.' })
    }

    let consulta = supabase
      .from('ponto_correcoes')
      .select('id, marcacao_id, usuario_id, tipo_solicitacao, valor_original, valor_proposto, justificativa, status, solicitado_em, decidido_por, decidido_em, decisao_justificativa')
      .order('solicitado_em', { ascending: false })

    if (colaborador_id) {
      consulta = consulta.eq('usuario_id', colaborador_id)
    } else if (req.pontoEscopoGestor !== null) {
      if (req.pontoEscopoGestor.length === 0) return res.json({ itens: [] })
      consulta = consulta.in('usuario_id', req.pontoEscopoGestor)
    }
    if (status) consulta = consulta.eq('status', status)

    const { data, error } = await consulta
    if (error) throw error

    res.json({ itens: data || [] })
  } catch (err) {
    logarErroPonto('gestao_listar_correcoes', err?.code)
    res.status(500).json({ erro: 'Não foi possível carregar as solicitações de correção.' })
  }
})

// Traduz os erros nomeados que a função Postgres levanta (RAISE EXCEPTION
// com uma mensagem fixa) para status HTTP — mesmo padrão de
// fn_aprovar_estorno/fn_rejeitar_estorno já usado no projeto (RPC +
// mensagem fixa interpretada no catch). Nunca expõe o texto bruto do erro
// do Postgres ao cliente além dessas mensagens conhecidas e seguras.
async function buscarResumoMarcacao(id) {
  if (!id) return null
  const { data } = await supabase.from('ponto_marcacoes').select('id, tipo, registrado_em, dia_brt').eq('id', id).maybeSingle()
  return data || { id }
}

function mapearErroDecisao(mensagem) {
  if (mensagem === 'autoaprovacao_bloqueada') return { status: 403, erro: 'Você não pode decidir sobre a própria solicitação.' }
  if (mensagem === 'piloto_desativado') return { status: 403, erro: 'O piloto está desativado — aprovações que criariam uma marcação estão bloqueadas. Rejeitar continua disponível.' }
  if (mensagem === 'solicitacao_nao_encontrada' || mensagem === 'correcao_nao_encontrada') return { status: 404, erro: 'Solicitação não encontrada.' }
  if (mensagem === 'decisao_invalida') return { status: 400, erro: 'decisao deve ser "aprovada" ou "rejeitada".' }
  // fora_do_escopo/decisor_invalido_ou_inativo: a função Postgres reconfere
  // isso de propósito (migration 051) — não deveria disparar pelo caminho
  // normal (Express já barra antes), só protege contra chamada direta da
  // função ou um bug no pré-check daqui.
  if (mensagem === 'fora_do_escopo') return { status: 403, erro: 'Colaborador fora do seu escopo de gestão.' }
  if (mensagem === 'decisor_invalido_ou_inativo') return { status: 403, erro: 'Sua conta está inativa.' }
  return null
}

// POST /api/ponto-gestao/correcoes/:id/decisao — { decisao: 'aprovada'|'rejeitada', decisao_justificativa }
//
// A decisão em si (UPDATE de status + INSERT da marcação, quando aplicável)
// roda inteira dentro de ponto_decidir_correcao (função Postgres, migration
// 20260101000050) — uma chamada de função é UMA transação: se o INSERT da
// marcação falhar, o UPDATE de status é desfeito junto, a correção continua
// 'pendente'. `FOR UPDATE` dentro da função serializa decisões concorrentes
// — nunca depende só da checagem prévia em JavaScript abaixo (que existe só
// pra dar um 404/403 rápido antes de gastar uma chamada RPC).
router.post('/correcoes/:id/decisao', async (req, res) => {
  const { decisao, decisao_justificativa } = req.body || {}
  if (!['aprovada', 'rejeitada'].includes(decisao)) {
    return res.status(400).json({ erro: 'decisao deve ser "aprovada" ou "rejeitada".' })
  }

  try {
    const { data: correcao, error: erroCorrecao } = await supabase
      .from('ponto_correcoes')
      .select('id, usuario_id')
      .eq('id', req.params.id)
      .maybeSingle()
    if (erroCorrecao) throw erroCorrecao
    if (!correcao || !colaboradorNoEscopo(req, correcao.usuario_id)) {
      return res.status(404).json({ erro: 'Solicitação não encontrada.' })
    }

    const { data, error } = await supabase.rpc('ponto_decidir_correcao', {
      p_correcao_id: correcao.id,
      p_decisor_id: req.user.id,
      p_decisao: decisao,
      p_decisao_justificativa: decisao_justificativa?.trim() || null,
    })
    if (error) {
      const mapeado = mapearErroDecisao(error.message)
      if (mapeado) return res.status(mapeado.status).json({ erro: mapeado.erro })
      throw error
    }

    const resultado = Array.isArray(data) ? data[0] : data
    if (resultado.resultado === 'ja_decidida_antes') {
      return res.status(409).json({
        erro: 'Esta solicitação já foi decidida.',
        status: resultado.status,
        decidido_por: resultado.decidido_por,
        decidido_em: resultado.decidido_em,
        marcacao_gerada_id: resultado.marcacao_gerada_id,
      })
    }

    res.json({
      id: resultado.correcao_id,
      status: resultado.status,
      marcacao_gerada: await buscarResumoMarcacao(resultado.marcacao_gerada_id),
    })
  } catch (err) {
    logarErroPonto('decidir_correcao', err?.code)
    res.status(500).json({ erro: 'Não foi possível registrar a decisão.' })
  }
})

// GET /api/ponto-gestao/solicitacoes?status=&colaborador_id= — solicitações
// de marcação (caminho real enquanto EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA
// for false — ver src/lib/ponto/equipamento.js). Distintas de /correcoes:
// aqui é "alguém tentando registrar presença agora", não "peço ajuste de
// algo já confirmado".
router.get('/solicitacoes', async (req, res) => {
  try {
    const { colaborador_id, status } = req.query
    if (colaborador_id && !colaboradorNoEscopo(req, colaborador_id)) {
      return res.status(403).json({ erro: 'Colaborador fora do seu escopo de gestão.' })
    }

    let consulta = supabase
      .from('ponto_solicitacoes_marcacao')
      .select('id, usuario_id, tipo, motivo, justificativa, foto_id, status, criado_em, horario_declarado, decidido_por, decidido_em, decisao_justificativa, marcacao_gerada_id')
      .order('criado_em', { ascending: false })

    if (colaborador_id) {
      consulta = consulta.eq('usuario_id', colaborador_id)
    } else if (req.pontoEscopoGestor !== null) {
      if (req.pontoEscopoGestor.length === 0) return res.json({ itens: [] })
      consulta = consulta.in('usuario_id', req.pontoEscopoGestor)
    }
    if (status) consulta = consulta.eq('status', status)

    const { data, error } = await consulta
    if (error) throw error

    res.json({ itens: data || [] })
  } catch (err) {
    logarErroPonto('gestao_listar_solicitacoes', err?.code)
    res.status(500).json({ erro: 'Não foi possível carregar as solicitações de marcação.' })
  }
})

// GET /api/ponto-gestao/solicitacoes/:id/foto
router.get('/solicitacoes/:id/foto', async (req, res) => {
  try {
    const { data: solicitacao, error: erroSolicitacao } = await supabase
      .from('ponto_solicitacoes_marcacao')
      .select('id, usuario_id, foto_id')
      .eq('id', req.params.id)
      .maybeSingle()
    if (erroSolicitacao) throw erroSolicitacao
    if (!solicitacao || !colaboradorNoEscopo(req, solicitacao.usuario_id)) {
      return res.status(404).json({ erro: 'Solicitação não encontrada.' })
    }
    if (!solicitacao.foto_id) {
      return res.status(404).json({ erro: 'Esta solicitação não tem foto associada.' })
    }

    const { data: foto, error: erroFoto } = await supabase
      .from('ponto_fotos')
      .select('storage_path')
      .eq('id', solicitacao.foto_id)
      .single()
    if (erroFoto) throw erroFoto

    const assinada = await gerarUrlAssinada(foto.storage_path)
    res.json(assinada)
  } catch (err) {
    logarErroPonto('gestao_obter_foto_solicitacao', err?.code)
    res.status(500).json({ erro: 'Não foi possível gerar o link da foto.' })
  }
})

// POST /api/ponto-gestao/solicitacoes/:id/decisao — { decisao, decisao_justificativa }
//
// Aprovar é o ÚNICO jeito de uma solicitação virar uma marcação real
// enquanto o equipamento não for verificável — origem='contingencia' (não
// "marcação direta verificada"), sempre sinalizado_para_revisao=true (é
// uma exceção por construção), registrado_em preserva o instante real da
// tentativa (capturado_em da solicitação, recebido no servidor no momento
// do envio) — NUNCA o instante da decisão do gestor.
//
// A decisão inteira (UPDATE de status + INSERT da marcação + link de
// volta) roda dentro de ponto_decidir_solicitacao (função Postgres,
// migration 20260101000050) como UMA transação — se o INSERT falhar, o
// UPDATE de status é desfeito junto, a solicitação continua 'pendente'.
// `FOR UPDATE` na função serializa decisões concorrentes; a checagem de
// escopo abaixo é só um 404 rápido antes de gastar uma chamada RPC, nunca
// a única proteção contra corrida.
router.post('/solicitacoes/:id/decisao', async (req, res) => {
  const { decisao, decisao_justificativa } = req.body || {}
  if (!['aprovada', 'rejeitada'].includes(decisao)) {
    return res.status(400).json({ erro: 'decisao deve ser "aprovada" ou "rejeitada".' })
  }

  try {
    const { data: solicitacao, error: erroSolicitacao } = await supabase
      .from('ponto_solicitacoes_marcacao')
      .select('id, usuario_id')
      .eq('id', req.params.id)
      .maybeSingle()
    if (erroSolicitacao) throw erroSolicitacao
    if (!solicitacao || !colaboradorNoEscopo(req, solicitacao.usuario_id)) {
      return res.status(404).json({ erro: 'Solicitação não encontrada.' })
    }

    const { data, error } = await supabase.rpc('ponto_decidir_solicitacao', {
      p_solicitacao_id: solicitacao.id,
      p_decisor_id: req.user.id,
      p_decisao: decisao,
      p_decisao_justificativa: decisao_justificativa?.trim() || null,
    })
    if (error) {
      const mapeado = mapearErroDecisao(error.message)
      if (mapeado) return res.status(mapeado.status).json({ erro: mapeado.erro })
      throw error
    }

    const resultado = Array.isArray(data) ? data[0] : data
    if (resultado.resultado === 'ja_decidida_antes') {
      return res.status(409).json({
        erro: 'Esta solicitação já foi decidida.',
        status: resultado.status,
        decidido_por: resultado.decidido_por,
        decidido_em: resultado.decidido_em,
        marcacao_gerada_id: resultado.marcacao_gerada_id,
      })
    }

    res.json({
      id: resultado.solicitacao_id,
      status: resultado.status,
      marcacao_gerada: await buscarResumoMarcacao(resultado.marcacao_gerada_id),
    })
  } catch (err) {
    logarErroPonto('decidir_solicitacao', err?.code)
    res.status(500).json({ erro: 'Não foi possível registrar a decisão.' })
  }
})

export default router
