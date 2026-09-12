// "Meu Ponto" — autosserviço do colaborador. Piloto interno, NÃO é REP-P,
// não faz reconhecimento facial nem prova de vida. Ver
// docs/meu-ponto/ESPECIFICACAO_MEU_PONTO.md.
//
// req.user.id é sempre a fonte de "quem está marcando" — nunca um
// usuario_id vindo do corpo/query (mesmo padrão de
// src/routes/collection-contact-review.js).
//
// MODELO REVISADO (2026-09-10): enquanto EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA
// for false (src/lib/ponto/equipamento.js), POST /marcacoes (criação DIRETA
// de origem='normal') fica bloqueada incondicionalmente, mesmo com
// ponto_config.piloto_ativo=true. O caminho operacional real desta etapa é
// /solicitacoes: toda tentativa de marcação vira uma solicitação auditada
// (ponto_solicitacoes_marcacao), com ou sem foto, sempre com justificativa,
// e só produz uma linha em ponto_marcacoes depois de decisão humana de um
// gestor (ver src/routes/ponto-gestao.js).
import { Router } from 'express'
import bcrypt from 'bcryptjs'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { supabase } from '../lib/supabase-admin.server.js'
import { hojeBrtISO } from '../lib/ponto/tempo.js'
import { proximoTipoEsperado, avaliarSequencia } from '../lib/ponto/sequencia.js'
import { validarFotoBuffer, uploadFoto, gerarUrlAssinada, PONTO_FOTOS_TAMANHO_MAXIMO_BYTES } from '../lib/ponto/fotoStorage.js'
import { logarErroPonto } from '../lib/ponto/log.js'
import { exigirPilotoAtivo, exigirColaboradorHabilitado } from '../middleware/pontoAuth.js'
import { EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA, MENSAGEM_EQUIPAMENTO_NAO_IMPLEMENTADO } from '../lib/ponto/equipamento.js'
import { emitirDesafio, registrarMarcacaoAssinada, ErroEquipamento } from '../lib/ponto/equipamentoService.js'
import { calcularHashConteudo } from '../lib/ponto/assinaturaEquipamento.js'

const router = Router()

const TIPOS_VALIDOS = ['entrada', 'saida_intervalo', 'retorno_intervalo', 'saida']
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TIPOS_SOLICITACAO_VALIDOS = ['ajuste_horario', 'ajuste_tipo', 'inclusao_marcacao_faltante', 'outro']
// Estes três tipos, se aprovados, geram uma NOVA linha em ponto_marcacoes
// (ver ponto_decidir_correcao, migration 051) a partir de
// valor_proposto.tipo/registrado_em — 'outro' nunca gera marcação
// automaticamente. Validar aqui, na criação, evita que uma correção com
// valor_proposto incompleto fique pendente e só "estoure" (silenciosamente,
// sem gerar marcação nem avisar ninguém) no momento da aprovação pelo
// gestor — a função Postgres também revalida isto (nunca confia só nesta
// checagem em JS), mas o gestor nunca deveria ver uma correção aprovável
// que na prática não pode produzir nada.
const TIPOS_CORRECAO_QUE_GERAM_MARCACAO = ['ajuste_horario', 'ajuste_tipo', 'inclusao_marcacao_faltante']

// Proteção contra tentativa repetida de senha (a única coisa que uma
// marcação/solicitação exige além de estar logado). Chave por usuário, não
// só por IP — várias pessoas do mesmo escritório compartilham IP, e um
// limite só-por-IP ou deixaria passar demais ou bloquearia gente inocente.
const limiteTentativasSensiveis = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  // req.user sempre existe aqui (auth roda antes) — o fallback pra IP é só
  // defensivo. ipKeyGenerator normaliza IPv6 corretamente (por prefixo
  // /56), evitando que variações de endereço dentro do mesmo /56 burlem o
  // limite — é o que a validação do express-rate-limit pede explicitamente.
  keyGenerator: (req) => req.user?.id || ipKeyGenerator(req.ip),
  message: { erro: 'Muitas tentativas em pouco tempo. Aguarde alguns minutos.' },
})

// Toda rota deste router exige colaborador habilitado (flag própria, não
// role). exigirPilotoAtivo só bloqueia a CRIAÇÃO de marcação/solicitação —
// consulta do próprio histórico continua disponível mesmo com o piloto
// desligado, para não esconder dados já existentes de quem já usou o
// piloto antes dele ser pausado.
router.use(exigirColaboradorHabilitado)

// GET /api/ponto/estado
router.get('/estado', async (req, res) => {
  try {
    const { data: config, error: erroConfig } = await supabase
      .from('ponto_config')
      .select('piloto_ativo')
      .eq('id', true)
      .single()
    if (erroConfig) throw erroConfig

    const hoje = hojeBrtISO()
    const { data: marcacoesHoje, error: erroMarcacoes } = await supabase
      .from('ponto_marcacoes')
      .select('id, tipo, origem, registrado_em, sinalizado_para_revisao')
      .eq('usuario_id', req.user.id)
      .eq('dia_brt', hoje)
      .order('registrado_em', { ascending: true })
    if (erroMarcacoes) throw erroMarcacoes

    const { data: ultima, error: erroUltima } = await supabase
      .from('ponto_marcacoes')
      .select('tipo')
      .eq('usuario_id', req.user.id)
      .order('registrado_em', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (erroUltima) throw erroUltima

    const { count: correcoesPendentes, error: erroCorrecoes } = await supabase
      .from('ponto_correcoes')
      .select('id', { count: 'exact', head: true })
      .eq('usuario_id', req.user.id)
      .eq('status', 'pendente')
    if (erroCorrecoes) throw erroCorrecoes

    const { count: solicitacoesPendentes, error: erroSolicitacoes } = await supabase
      .from('ponto_solicitacoes_marcacao')
      .select('id', { count: 'exact', head: true })
      .eq('usuario_id', req.user.id)
      .eq('status', 'pendente')
    if (erroSolicitacoes) throw erroSolicitacoes

    res.json({
      piloto_ativo: Boolean(config?.piloto_ativo),
      equipamento_verificacao_implementada: EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA,
      dia_brt: hoje,
      marcacoes_hoje: marcacoesHoje || [],
      proximo_tipo_esperado: proximoTipoEsperado(ultima?.tipo || null),
      correcoes_pendentes: correcoesPendentes || 0,
      solicitacoes_pendentes: solicitacoesPendentes || 0,
    })
  } catch (err) {
    logarErroPonto('estado', err?.code)
    res.status(500).json({ erro: 'Não foi possível carregar o estado do ponto.' })
  }
})

// GET /api/ponto/marcacoes?inicio=YYYY-MM-DD&fim=YYYY-MM-DD&pagina=&limite=
router.get('/marcacoes', async (req, res) => {
  try {
    const pagina = Math.max(1, Number(req.query.pagina) || 1)
    const limite = Math.min(100, Math.max(1, Number(req.query.limite) || 30))
    const de = (pagina - 1) * limite

    let consulta = supabase
      .from('ponto_marcacoes')
      .select('id, tipo, origem, registrado_em, dia_brt, foto_id, sinalizado_para_revisao, motivo_sinalizacao', { count: 'exact' })
      .eq('usuario_id', req.user.id)
      .order('registrado_em', { ascending: false })
      .range(de, de + limite - 1)

    if (req.query.inicio) consulta = consulta.gte('dia_brt', req.query.inicio)
    if (req.query.fim) consulta = consulta.lte('dia_brt', req.query.fim)

    const { data, error, count } = await consulta
    if (error) throw error

    res.json({ itens: data || [], total: count || 0, pagina, limite })
  } catch (err) {
    logarErroPonto('listar_marcacoes', err?.code)
    res.status(500).json({ erro: 'Não foi possível carregar suas marcações.' })
  }
})

// GET /api/ponto/marcacoes/:id/foto — URL assinada de curta duração; só o
// próprio dono da marcação pode pedir.
router.get('/marcacoes/:id/foto', async (req, res) => {
  try {
    const { data: marcacao, error: erroMarcacao } = await supabase
      .from('ponto_marcacoes')
      .select('id, usuario_id, foto_id')
      .eq('id', req.params.id)
      .maybeSingle()
    if (erroMarcacao) throw erroMarcacao
    if (!marcacao || marcacao.usuario_id !== req.user.id) {
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
    logarErroPonto('obter_foto', err?.code)
    res.status(500).json({ erro: 'Não foi possível gerar o link da foto.' })
  }
})

// Faz upload/validação de uma foto opcional e devolve o foto_id (ou null).
// Compartilhado entre /marcacoes (futuro) e /solicitacoes (caminho real
// desta etapa) — mesma validação de formato/tamanho nos dois.
async function processarFotoOpcional({ usuarioId, fotoBase64, mimeType }) {
  if (!fotoBase64) return { fotoId: null, erro: null }

  const tipoMime = mimeType === 'image/png' ? 'image/png' : 'image/jpeg'
  let buffer
  try {
    buffer = Buffer.from(fotoBase64, 'base64')
  } catch {
    return { fotoId: null, erro: 'foto_base64 inválida.' }
  }
  const validacao = validarFotoBuffer(buffer, tipoMime)
  if (!validacao.valido) {
    return { fotoId: null, erro: `Foto inválida: ${validacao.motivo}.` }
  }

  let uploaded
  try {
    uploaded = await uploadFoto({ usuarioId, buffer, mimeType: tipoMime })
  } catch (erroUpload) {
    logarErroPonto('upload_foto', erroUpload?.codigoOriginal)
    const falha = new Error('falha_upload_foto')
    falha.status = 502
    throw falha
  }

  const { data: fotoRow, error: erroFotoInsert } = await supabase
    .from('ponto_fotos')
    .insert({
      usuario_id: usuarioId,
      storage_path: uploaded.storagePath,
      mime_type: tipoMime,
      tamanho_bytes: buffer.length,
      capturada_em: new Date().toISOString(),
    })
    .select('id')
    .single()
  if (erroFotoInsert) throw erroFotoInsert

  return { fotoId: fotoRow.id, erro: null }
}

function mensagemAmigavelRegistro(codigo) {
  const mapa = {
    equipamento_invalido_ou_revogado: 'Equipamento não encontrado, inativo ou revogado.',
    assinatura_invalida: 'Não foi possível validar a assinatura do equipamento. A marcação não foi registrada.',
    piloto_desativado: 'O piloto está desativado no momento.',
    usuario_invalido_ou_inativo: 'Sua conta está inativa.',
    desafio_nao_encontrado: 'Desafio inválido para este equipamento/usuário. Peça um novo desafio.',
    desafio_ja_usado: 'Este desafio já foi usado. Peça um novo desafio.',
    desafio_expirado: 'Este desafio expirou. Peça um novo desafio.',
    conteudo_nao_confere: 'O conteúdo enviado não corresponde ao desafio assinado. A marcação não foi registrada.',
    operacao_id_conteudo_diferente: 'Este operacao_id já foi usado com um tipo diferente. Gere uma nova tentativa (novo operacao_id) em vez de reenviar com dados alterados.',
  }
  return mapa[codigo] || 'Não foi possível registrar a marcação.'
}

// POST /api/ponto/desafios — pede um desafio de uso único, vinculado a
// usuário+equipamento+tipo+hash do conteúdo (passo 3 do protocolo, ver
// docs/meu-ponto/PROTOCOLO_COMPONENTE_WINDOWS.md). Atrás do mesmo gate
// estrutural que POST /marcacoes — inalcançável de verdade enquanto
// EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA for false.
router.post('/desafios', exigirPilotoAtivo, limiteTentativasSensiveis, async (req, res) => {
  if (!EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA) {
    return res.status(501).json({ erro: MENSAGEM_EQUIPAMENTO_NAO_IMPLEMENTADO })
  }

  const { equipamento_id, tipo, hash_conteudo } = req.body || {}
  if (!equipamento_id || !UUID_RE.test(equipamento_id)) {
    return res.status(400).json({ erro: 'equipamento_id é obrigatório e deve ser um UUID.' })
  }
  if (!TIPOS_VALIDOS.includes(tipo)) {
    return res.status(400).json({ erro: `tipo deve ser um de: ${TIPOS_VALIDOS.join(', ')}` })
  }
  if (!hash_conteudo || typeof hash_conteudo !== 'string') {
    return res.status(400).json({ erro: 'hash_conteudo é obrigatório.' })
  }

  try {
    const desafio = await emitirDesafio({ usuarioId: req.user.id, equipamentoId: equipamento_id, tipo, hashConteudo: hash_conteudo })
    res.status(201).json(desafio)
  } catch (err) {
    if (err instanceof ErroEquipamento) {
      return res.status(err.status).json({ erro: 'Equipamento não encontrado, inativo ou não cadastrado para produção.' })
    }
    logarErroPonto('emitir_desafio', err?.code)
    res.status(500).json({ erro: 'Não foi possível gerar o desafio.' })
  }
})

// POST /api/ponto/marcacoes — criação DIRETA de marcação origem='normal',
// com assinatura de equipamento (passos 5-6 do protocolo).
//
// BLOQUEADA incondicionalmente enquanto EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA
// for false — mesmo com ponto_config.piloto_ativo=true em teste isolado, e
// mesmo com um desafio/assinatura válidos. O código abaixo do gate é real
// (não um placeholder) mas fica inalcançável até essa mudança de código
// separada. Use POST /solicitacoes para o caminho real desta etapa.
//
// A assinatura de equipamento SOMA uma terceira trava — nunca substitui
// senha (identidade) nem foto (evidência revisável), as duas continuam
// obrigatórias exatamente como no fluxo de solicitação.
router.post('/marcacoes', exigirPilotoAtivo, limiteTentativasSensiveis, async (req, res) => {
  if (!EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA) {
    return res.status(501).json({ erro: MENSAGEM_EQUIPAMENTO_NAO_IMPLEMENTADO })
  }

  const { operacao_id, tipo, senha_atual, foto_base64, mime_type, equipamento_id, nonce, assinatura } = req.body || {}

  if (!operacao_id || !UUID_RE.test(operacao_id)) {
    return res.status(400).json({ erro: 'operacao_id é obrigatório e deve ser um UUID.' })
  }
  if (!TIPOS_VALIDOS.includes(tipo)) {
    return res.status(400).json({ erro: `tipo deve ser um de: ${TIPOS_VALIDOS.join(', ')}` })
  }
  if (!senha_atual) {
    return res.status(400).json({ erro: 'Confirme sua senha para registrar a marcação.' })
  }
  if (!foto_base64) {
    return res.status(400).json({ erro: 'Marcação direta exige foto capturada pela câmera.' })
  }
  if (!equipamento_id || !UUID_RE.test(equipamento_id)) {
    return res.status(400).json({ erro: 'equipamento_id é obrigatório e deve ser um UUID.' })
  }
  if (!nonce || typeof nonce !== 'string') {
    return res.status(400).json({ erro: 'nonce é obrigatório.' })
  }
  if (!assinatura || typeof assinatura !== 'string') {
    return res.status(400).json({ erro: 'assinatura é obrigatória.' })
  }

  try {
    const { data: existente, error: erroExistente } = await supabase
      .from('ponto_marcacoes')
      .select('id, tipo, origem, registrado_em, dia_brt, sinalizado_para_revisao')
      .eq('operacao_id', operacao_id)
      .maybeSingle()
    if (erroExistente) throw erroExistente
    if (existente) {
      // Mesmo reforço do idempotência aplicado em /solicitacoes (seção 2.3
      // da especificação): reenvio do mesmo operacao_id com um tipo
      // diferente nunca é tratado como "a mesma operação" — devolveria
      // silenciosamente a marcação antiga como se fosse sucesso da nova
      // tentativa. A função Postgres (migration 053) reforça a mesma
      // checagem para a janela de corrida entre duas chamadas concorrentes.
      if (existente.tipo !== tipo) {
        return res.status(409).json({ erro: mensagemAmigavelRegistro('operacao_id_conteudo_diferente') })
      }
      return res.status(200).json({ ...existente, idempotente: true })
    }

    const { data: usuario, error: erroUsuario } = await supabase
      .from('usuarios')
      .select('senha_hash')
      .eq('id', req.user.id)
      .single()
    if (erroUsuario) throw erroUsuario
    const senhaValida = usuario?.senha_hash && (await bcrypt.compare(senha_atual, usuario.senha_hash))
    if (!senhaValida) {
      return res.status(401).json({ erro: 'Senha incorreta. A marcação não foi registrada.' })
    }

    let fotoBuffer
    try {
      fotoBuffer = Buffer.from(foto_base64, 'base64')
    } catch {
      return res.status(400).json({ erro: 'foto_base64 inválida.' })
    }

    let fotoId
    try {
      const resultadoFoto = await processarFotoOpcional({ usuarioId: req.user.id, fotoBase64: foto_base64, mimeType: mime_type })
      if (resultadoFoto.erro) {
        return res.status(400).json({ erro: resultadoFoto.erro })
      }
      fotoId = resultadoFoto.fotoId
    } catch (erroFoto) {
      return res.status(erroFoto.status || 500).json({ erro: 'Falha ao enviar a foto. A marcação não foi registrada — tente novamente.' })
    }

    // Hash recalculado a partir da foto REALMENTE recebida — a função de
    // registro rejeita se não bater com o hash assinado no desafio
    // (protocolo §1, passo 6). Nunca confiamos num hash vindo do corpo.
    const hashConteudo = calcularHashConteudo(fotoBuffer)

    const { data: ultima, error: erroUltima } = await supabase
      .from('ponto_marcacoes')
      .select('tipo')
      .eq('usuario_id', req.user.id)
      .order('registrado_em', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (erroUltima) throw erroUltima
    const avaliacao = avaliarSequencia(ultima?.tipo || null, tipo)

    let resultado
    try {
      resultado = await registrarMarcacaoAssinada({
        usuarioId: req.user.id,
        equipamentoId: equipamento_id,
        nonce,
        operacaoId: operacao_id,
        tipo,
        hashConteudo,
        assinaturaBase64: assinatura,
        fotoId,
        ip: req.ip || null,
        sinalizadoParaRevisao: avaliacao.sinalizar,
        motivoSinalizacao: avaliacao.motivo,
      })
    } catch (erroRegistro) {
      if (erroRegistro instanceof ErroEquipamento) {
        return res.status(erroRegistro.status).json({ erro: mensagemAmigavelRegistro(erroRegistro.codigoEquipamento) })
      }
      throw erroRegistro
    }

    const corpo = {
      id: resultado.marcacao_id,
      tipo: resultado.tipo,
      origem: resultado.origem,
      registrado_em: resultado.registrado_em,
      dia_brt: resultado.dia_brt,
      sinalizado_para_revisao: resultado.sinalizado_para_revisao,
      idempotente: resultado.resultado === 'ja_registrada_antes',
    }
    res.status(corpo.idempotente ? 200 : 201).json(corpo)
  } catch (err) {
    logarErroPonto('criar_marcacao', err?.code)
    res.status(500).json({ erro: 'Não foi possível registrar a marcação.' })
  }
})

// POST /api/ponto/solicitacoes — O CAMINHO REAL desta etapa. Toda tentativa
// de marcação (com ou sem foto) vira uma solicitação auditada; só produz
// uma linha em ponto_marcacoes depois que um gestor aprovar
// (src/routes/ponto-gestao.js POST /solicitacoes/:id/decisao).
//
// Idempotência real por operacao_id: reenvio do mesmo operacao_id com o
// MESMO conteúdo (retry/timeout/duplo clique) devolve a solicitação já
// existente. Reenvio do mesmo operacao_id com conteúdo DIFERENTE (tipo ou
// justificativa distintos) é tratado como conflito, não como "a mesma
// operação" — nunca aceitamos silenciosamente um payload diferente sob a
// mesma chave de idempotência.
router.post('/solicitacoes', exigirPilotoAtivo, limiteTentativasSensiveis, async (req, res) => {
  const { operacao_id, tipo, senha_atual, justificativa, foto_base64, mime_type, horario_declarado } = req.body || {}

  if (!operacao_id || !UUID_RE.test(operacao_id)) {
    return res.status(400).json({ erro: 'operacao_id é obrigatório e deve ser um UUID.' })
  }
  if (!TIPOS_VALIDOS.includes(tipo)) {
    return res.status(400).json({ erro: `tipo deve ser um de: ${TIPOS_VALIDOS.join(', ')}` })
  }
  if (!senha_atual) {
    return res.status(400).json({ erro: 'Confirme sua senha para enviar a solicitação.' })
  }
  if (!justificativa?.trim()) {
    return res.status(400).json({ erro: 'justificativa é obrigatória — toda solicitação precisa dizer o que aconteceu.' })
  }
  // Horário DECLARADO pelo colaborador — sempre opcional, nunca confundido
  // com o horário de recebimento no servidor (capturado_em, abaixo, sempre
  // automático). Só um contexto a mais pro gestor avaliar; nunca vira
  // registrado_em da marcação aprovada (ver função ponto_decidir_solicitacao).
  let horarioDeclaradoISO = null
  if (horario_declarado) {
    const parsed = new Date(horario_declarado)
    if (Number.isNaN(parsed.getTime())) {
      return res.status(400).json({ erro: 'horario_declarado, se enviado, precisa ser uma data/hora válida.' })
    }
    horarioDeclaradoISO = parsed.toISOString()
  }

  try {
    // Achado relacionado à auditoria adversarial de 2026-09-12 (documentado
    // na PR #81 para POST /marcacoes, mesmo padrão aqui): esta consulta de
    // idempotência filtrava só por operacao_id, sem exigir
    // usuario_id = req.user.id. Como o retorno antecipado abaixo acontece
    // ANTES da verificação de senha, um atacante autenticado que
    // descobrisse o operacao_id de outro colaborador (log, captura de
    // tela, URL) conseguia, sem senha correta: (1) ler id/status da
    // solicitação alheia quando tipo+justificativa coincidissem
    // exatamente, tratada como se fosse a própria solicitação do
    // atacante; ou (2) confirmar via 409 que aquele operacao_id já existe
    // para outra pessoa, mesmo com conteúdo divergente. O filtro por
    // usuario_id abaixo garante que a idempotência só nunca enxerga
    // registros de outro usuário — nesse caso cai no fluxo normal de
    // validação (senha), que rejeita corretamente. Ver
    // scripts/tests/ponto/auditoria-solicitacoes-idor-http.test.mjs.
    const { data: existente, error: erroExistente } = await supabase
      .from('ponto_solicitacoes_marcacao')
      .select('id, tipo, justificativa, status, criado_em')
      .eq('operacao_id', operacao_id)
      .eq('usuario_id', req.user.id)
      .maybeSingle()
    if (erroExistente) throw erroExistente
    if (existente) {
      const mesmoConteudo = existente.tipo === tipo && existente.justificativa === justificativa.trim()
      if (!mesmoConteudo) {
        return res.status(409).json({
          erro: 'Este operacao_id já foi usado com um conteúdo diferente. Gere uma nova tentativa (novo operacao_id) em vez de reenviar com dados alterados.',
        })
      }
      return res.status(200).json({ id: existente.id, status: existente.status, idempotente: true })
    }

    const { data: usuario, error: erroUsuario } = await supabase
      .from('usuarios')
      .select('senha_hash')
      .eq('id', req.user.id)
      .single()
    if (erroUsuario) throw erroUsuario
    const senhaValida = usuario?.senha_hash && (await bcrypt.compare(senha_atual, usuario.senha_hash))
    if (!senhaValida) {
      return res.status(401).json({ erro: 'Senha incorreta. A solicitação não foi registrada.' })
    }

    let fotoId
    try {
      const resultadoFoto = await processarFotoOpcional({ usuarioId: req.user.id, fotoBase64: foto_base64, mimeType: mime_type })
      if (resultadoFoto.erro) {
        return res.status(400).json({ erro: resultadoFoto.erro })
      }
      fotoId = resultadoFoto.fotoId
    } catch (erroFoto) {
      return res.status(erroFoto.status || 500).json({ erro: 'Falha ao enviar a foto. A solicitação não foi registrada — tente novamente.' })
    }

    const motivo = foto_base64 ? 'equipamento_nao_implementado' : 'camera_indisponivel'

    const { data: solicitacao, error: erroInsert } = await supabase
      .from('ponto_solicitacoes_marcacao')
      .insert({
        operacao_id,
        usuario_id: req.user.id,
        tipo,
        motivo,
        justificativa: justificativa.trim(),
        dia_brt: hojeBrtISO(),
        foto_id: fotoId,
        ip_registro: req.ip || null,
        horario_declarado: horarioDeclaradoISO,
      })
      .select('id, tipo, motivo, status, criado_em, horario_declarado')
      .single()

    if (erroInsert) {
      logarErroPonto('inserir_solicitacao_apos_foto', erroInsert?.code)
      return res.status(500).json({
        erro: fotoId
          ? 'A foto foi recebida, mas o registro da solicitação falhou. Tente novamente com o mesmo toque — nada foi confirmado ainda.'
          : 'Não foi possível registrar a solicitação. Tente novamente.',
      })
    }

    res.status(201).json({ ...solicitacao, idempotente: false })
  } catch (err) {
    logarErroPonto('criar_solicitacao', err?.code)
    res.status(500).json({ erro: 'Não foi possível registrar a solicitação.' })
  }
})

// GET /api/ponto/solicitacoes — próprias solicitações e status.
router.get('/solicitacoes', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('ponto_solicitacoes_marcacao')
      .select('id, tipo, motivo, justificativa, foto_id, status, criado_em, horario_declarado, decidido_em, decisao_justificativa, marcacao_gerada_id')
      .eq('usuario_id', req.user.id)
      .order('criado_em', { ascending: false })
    if (error) throw error

    res.json({ itens: data || [] })
  } catch (err) {
    logarErroPonto('listar_solicitacoes', err?.code)
    res.status(500).json({ erro: 'Não foi possível carregar suas solicitações.' })
  }
})

// GET /api/ponto/solicitacoes/por-operacao/:operacao_id — recuperação após
// timeout: consulta o resultado sem reenviar foto/senha.
router.get('/solicitacoes/por-operacao/:operacao_id', async (req, res) => {
  if (!UUID_RE.test(req.params.operacao_id)) {
    return res.status(400).json({ erro: 'operacao_id inválido.' })
  }
  try {
    const { data, error } = await supabase
      .from('ponto_solicitacoes_marcacao')
      .select('id, usuario_id, tipo, status, criado_em, decidido_em')
      .eq('operacao_id', req.params.operacao_id)
      .maybeSingle()
    if (error) throw error
    if (!data || data.usuario_id !== req.user.id) {
      return res.status(404).json({ erro: 'Nenhuma solicitação encontrada para este operacao_id.' })
    }
    const { usuario_id, ...resto } = data
    res.json(resto)
  } catch (err) {
    logarErroPonto('consultar_solicitacao_por_operacao', err?.code)
    res.status(500).json({ erro: 'Não foi possível consultar a solicitação.' })
  }
})

// GET /api/ponto/solicitacoes/:id/foto
router.get('/solicitacoes/:id/foto', async (req, res) => {
  try {
    const { data: solicitacao, error: erroSolicitacao } = await supabase
      .from('ponto_solicitacoes_marcacao')
      .select('id, usuario_id, foto_id')
      .eq('id', req.params.id)
      .maybeSingle()
    if (erroSolicitacao) throw erroSolicitacao
    if (!solicitacao || solicitacao.usuario_id !== req.user.id) {
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
    logarErroPonto('obter_foto_solicitacao', err?.code)
    res.status(500).json({ erro: 'Não foi possível gerar o link da foto.' })
  }
})

// POST /api/ponto/correcoes — colaborador solicita correção com
// justificativa sobre uma marcação JÁ CONFIRMADA (não é o caminho de
// registrar agora — isso é /solicitacoes). Não exige reautenticação por
// senha: é um pedido por escrito, não uma alegação de presença no momento.
router.post('/correcoes', async (req, res) => {
  const { marcacao_id, tipo_solicitacao, valor_proposto, justificativa } = req.body || {}

  if (!TIPOS_SOLICITACAO_VALIDOS.includes(tipo_solicitacao)) {
    return res.status(400).json({ erro: `tipo_solicitacao deve ser um de: ${TIPOS_SOLICITACAO_VALIDOS.join(', ')}` })
  }
  if (!valor_proposto || typeof valor_proposto !== 'object') {
    return res.status(400).json({ erro: 'valor_proposto é obrigatório.' })
  }
  if (!justificativa?.trim()) {
    return res.status(400).json({ erro: 'justificativa é obrigatória.' })
  }
  if (TIPOS_CORRECAO_QUE_GERAM_MARCACAO.includes(tipo_solicitacao)) {
    if (!TIPOS_VALIDOS.includes(valor_proposto.tipo)) {
      return res.status(400).json({
        erro: `valor_proposto.tipo é obrigatório para "${tipo_solicitacao}" e deve ser um de: ${TIPOS_VALIDOS.join(', ')}`,
      })
    }
    const registradoEmProposto = valor_proposto.registrado_em ? new Date(valor_proposto.registrado_em) : null
    if (!registradoEmProposto || Number.isNaN(registradoEmProposto.getTime())) {
      return res.status(400).json({
        erro: `valor_proposto.registrado_em é obrigatório para "${tipo_solicitacao}" e deve ser uma data/hora válida.`,
      })
    }
  }

  try {
    let valorOriginal = null
    if (marcacao_id) {
      const { data: marcacao, error: erroMarcacao } = await supabase
        .from('ponto_marcacoes')
        .select('id, usuario_id, tipo, origem, registrado_em, dia_brt')
        .eq('id', marcacao_id)
        .maybeSingle()
      if (erroMarcacao) throw erroMarcacao
      if (!marcacao || marcacao.usuario_id !== req.user.id) {
        return res.status(404).json({ erro: 'Marcação não encontrada.' })
      }
      valorOriginal = marcacao
    }

    const { data, error } = await supabase
      .from('ponto_correcoes')
      .insert({
        marcacao_id: marcacao_id || null,
        usuario_id: req.user.id,
        tipo_solicitacao,
        valor_original: valorOriginal,
        valor_proposto,
        justificativa: justificativa.trim(),
        solicitado_por: req.user.id,
        status: 'pendente',
      })
      .select('id, status, solicitado_em')
      .single()
    if (error) throw error

    res.status(201).json(data)
  } catch (err) {
    logarErroPonto('criar_correcao', err?.code)
    res.status(500).json({ erro: 'Não foi possível registrar a solicitação de correção.' })
  }
})

// GET /api/ponto/correcoes — próprias solicitações e resultado.
router.get('/correcoes', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('ponto_correcoes')
      .select('id, marcacao_id, tipo_solicitacao, valor_proposto, justificativa, status, solicitado_em, decidido_em, decisao_justificativa')
      .eq('usuario_id', req.user.id)
      .order('solicitado_em', { ascending: false })
    if (error) throw error

    res.json({ itens: data || [] })
  } catch (err) {
    logarErroPonto('listar_correcoes', err?.code)
    res.status(500).json({ erro: 'Não foi possível carregar suas solicitações de correção.' })
  }
})

export default router
export const PONTO_TAMANHO_MAXIMO_FOTO = PONTO_FOTOS_TAMANHO_MAXIMO_BYTES
