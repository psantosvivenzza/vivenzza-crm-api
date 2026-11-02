import {carregarCadastroFisicoDoPedido} from '../lib/fretes/logistica.js'
import { normalizarCnpj, validarCnpj } from '../lib/cnpj.js'
import { validarBuscaPedido, prepararPedidoFrete, validarPedidoImportavel } from '../lib/fretes/pedido.js'
import { lerLogisticaNetvision } from '../lib/fretes/netvision.js'
import { Router } from 'express'
import { supabase } from '../lib/supabase-admin.server.js'
import { adminOuFinanceiro } from '../middleware/auth.js'
import { compararPropostas, validarCotacao, validarConfigTransportadora, validarProposta, montarSolicitacao, UUID, FreteError } from '../lib/fretes/domain.js'

const CONFIG = () => ({ envio_ativo: process.env.FRETE_ENVIO_ATIVO === 'true', ia_ativa: process.env.FRETE_IA_ATIVA === 'true', acoes_contato: { contrato: 'frete-contact-actions-v1', liberar_contato: false, associar_resposta: false } })
function check(result) { if (result.error) throw result.error; return result.data }
function id(v) { if (!UUID.test(v ?? '')) throw new FreteError('Identificador inválido.'); return v }
function handler(fn) {
  return async (req, res) => {
    try { await fn(req, res) } catch (e) {
      if (e.code === '23505') return res.status(409).json({ erro: 'Já existe uma cotação aberta para esse WhatsApp. Encerre a anterior antes de iniciar outra.' })
      if (e.code === 'P0001') return res.status(409).json({ erro: e.message })
      if (e.status) return res.status(e.status).json({ erro: e.message })
      console.error('[fretes] falha de persistência', e.code ?? 'desconhecida')
      res.status(503).json({ erro: 'Não foi possível acessar as cotações. Verifique a disponibilidade e a migration do módulo.' })
    }
  }
}
export function createFretesRouter(db = supabase, { loadLogistica = lerLogisticaNetvision } = {}) {
  const router = Router()
  router.use(adminOuFinanceiro)
  router.post('/transportadoras', handler(async(req,res)=>{
    if(req.user.role!=='admin')throw new FreteError('Apenas administradores podem criar fornecedores.',403)
    const cnpj=normalizarCnpj(String(req.body.cnpj??'')),razao_social=String(req.body.razao_social??'').trim()
    if(!validarCnpj(cnpj)||!razao_social||razao_social.length>180)throw new FreteError('Informe razão social e CNPJ válidos.')
    const campos=validarConfigTransportadora(req.body)
    if(!campos.telefone_cotacao_frete)throw new FreteError('Informe o WhatsApp do fornecedor com DDD.')
    const mascara=cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/,'$1.$2.$3/$4-$5')
    const existe=(check(await db.from('fornecedores').select('id').in('cnpj',[cnpj,mascara]).limit(1))||[])[0]
    if(existe)throw new FreteError('Fornecedor já cadastrado. Busque pelo CNPJ para configurar seu telefone.',409)
    const result=await db.from('fornecedores').insert({cnpj,razao_social,nome_fantasia:razao_social,ativo:true,origem:'manual',criado_por:UUID.test(req.user.id)?req.user.id:null,contatos:[],...campos,cotacao_frete_atualizada_em:new Date().toISOString(),cotacao_frete_atualizada_por:req.user.id}).select().single()
    if(result.error?.code==='23505')throw new FreteError('Fornecedor já cadastrado. Busque pelo CNPJ para configurar seu telefone.',409)
    const fornecedor=check(result)
    res.status(201).json(fornecedor)
  }))
  router.get('/pedidos/:numero', handler(async(req,res)=>{
    const {numero,filial}=validarBuscaPedido(req.params.numero,req.query.filial)
    let query=db.from('pedidos').select('id,legacy_id,status,total,peso_bruto,qtde_volumes,cliente_erp_id,cliente_nome_origem,cliente_documento_origem,sincronizado_em,status_importacao_pendente,erro_sincronizacao,conflito_sincronizacao,campos_com_override_local,frete_logistica').eq('sistema_origem','legado')
    query=filial ? query.eq('legacy_id',`${filial}-${numero}`):query.like('legacy_id',`%-${numero}`)
    const rows=check(await query.limit(2))||[]
    if(!rows.length)throw new FreteError('Pedido não encontrado entre os pedidos sincronizados da NetVision. Confira número/filial e a sincronização.',404)
    if(rows.length>1)throw new FreteError('Número encontrado em mais de uma filial. Informe a filial para escolher o pedido correto.',409)
    const pedido=rows[0]
    const cliente=pedido.cliente_erp_id ? check(await db.from('clientes_erp').select('razao_social,cnpj_cpf,endereco').eq('id',pedido.cliente_erp_id).maybeSingle()):null
    let cadastroAtual=null,aviso=null
    try{cadastroAtual=await carregarCadastroFisicoDoPedido(db,pedido)}catch{aviso='Não foi possível carregar o cadastro físico atual; usando os dados sincronizados disponíveis.'}
    if(cadastroAtual)pedido.pedido_itens=cadastroAtual
    let snapshot=pedido.frete_logistica
    if(!cadastroAtual && process.env.FRETE_NETVISION_LEITURA_DIRETA==='true') {
      if(Array.isArray(pedido.campos_com_override_local)&&pedido.campos_com_override_local.includes('itens'))aviso='Itens editados no ERP: logística do legado não aplicada; confira a carga manualmente.'
      else try {snapshot=await loadLogistica(pedido.legacy_id.split('-')[0],Number(numero))}catch{aviso='Consulta direta à logística indisponível; usando somente os dados sincronizados disponíveis.'}
    }
    if(Array.isArray(pedido.campos_com_override_local)&&pedido.campos_com_override_local.includes('itens'))snapshot=null
    const result=prepararPedidoFrete(pedido,cliente,snapshot)
    if(aviso)result.avisos.unshift(aviso)
    res.json(result)
  }))
  router.get('/transportadoras', handler(async (req, res) => {
    const busca = String(req.query.busca ?? '').trim().replace(/[^\p{L}\p{N}\s-]/gu, '').slice(0, 100)
    const page = Math.max(1, Math.min(10000, Number.parseInt(req.query.page, 10) || 1))
    let q = db.from('fornecedores').select('id,cnpj,razao_social,nome_fantasia,ativo,contatos,participa_cotacao_frete,telefone_cotacao_frete,cotacao_frete_consentimento,cotacao_frete_atualizada_em', { count: 'exact' }).order('razao_social').range((page - 1) * 100, page * 100 - 1)
    if (busca) {
      const digits=busca.replace(/\D/g,'')
      const mascara=digits.length===14?digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/,'$1.$2.$3/$4-$5'):null
      q=mascara?q.in('cnpj',[digits,mascara]):q.or(`razao_social.ilike.%${busca}%,nome_fantasia.ilike.%${busca}%,cnpj.ilike.%${busca}%`)
    }
    if (req.query.participa === 'true') q = q.eq('participa_cotacao_frete', true).eq('ativo', true)
    const result = await q
    check(result)
    res.json({ data: result.data ?? [], total: result.count, page, limit: 100 })
  }))
  router.patch('/transportadoras/:id', handler(async (req, res) => {
    const campos = validarConfigTransportadora(req.body)
    if(!Object.hasOwn(req.body,'versao')||(req.body.versao!==null&&(typeof req.body.versao!=='string'||!Number.isFinite(Date.parse(req.body.versao)))))throw new FreteError('Atualize o cadastro antes de salvar.',409)
    const fornecedor=check(await db.rpc('frete_configurar_transportadora',{p_id:id(req.params.id),p_versao:req.body.versao,p_campos:campos,p_actor:req.user.id}))
    res.json(fornecedor)
  }))
  router.get('/', handler(async (req, res) => {
    const result = await db.from('frete_cotacoes').select('*').order('created_at', { ascending: false }).limit(100)
    res.json({ data: check(result) ?? [], config: CONFIG() })
  }))
  router.post('/', handler(async (req, res) => {
    const dados = validarCotacao(req.body)
    if(dados.pedido_origem){
      const origem=check(await db.from('pedidos').select('id,legacy_id,status,status_importacao_pendente,erro_sincronizacao,conflito_sincronizacao').eq('id',dados.pedido_origem.id).eq('sistema_origem','legado').maybeSingle())
      if(!origem||origem.legacy_id!==dados.pedido_origem.referencia||origem.status==='cancelado')throw new FreteError('Pedido de origem inválido ou cancelado.',409)
      validarPedidoImportavel(origem)
      dados.conferido_por=req.user.id
      dados.conferido_em=new Date().toISOString()
    }
    const cotacao = check(await db.rpc('frete_criar_cotacao', { p_dados: dados, p_ids: dados.transportadora_ids, p_actor: req.user.id }))
    res.status(201).json(cotacao)
  }))
  async function cotacao(idCotacao) {
    const row = check(await db.from('frete_cotacoes').select('*').eq('id', id(idCotacao)).maybeSingle())
    if (!row) throw new FreteError('Cotação não encontrada.', 404)
    return row
  }
  router.get('/:id', handler(async (req, res) => {
    const row = await cotacao(req.params.id)
    const consultas = check(await db.from('frete_consultas').select('*').eq('cotacao_id', row.id).order('nome_transportadora')) ?? []
    const envios = check(await db.from('frete_envios').select('id,consulta_id,status,error_code,created_at,attempted_at').in('consulta_id', consultas.map(c => c.id)).order('created_at', { ascending: false }).limit(200)) ?? []
    const mensagens = check(await db.from('frete_mensagens').select('*').eq('cotacao_id', row.id).order('created_at', { ascending: false }).limit(500)) ?? []
    res.json({ cotacao: row, consultas: consultas.map(c => ({ ...c, envios: envios.filter(e => e.consulta_id === c.id), mensagens: mensagens.filter(m => m.consulta_id === c.id).reverse() })), comparativo: compararPropostas(consultas, row.dados), config: CONFIG() })
  }))
  router.post('/:id/enviar', handler(async (req, res) => {
    if (!CONFIG().envio_ativo) throw new FreteError('Envio Evolution ainda não habilitado para este módulo. A cotação pode ser preenchida e comparada.', 409)
    const row = await cotacao(req.params.id)
    const quantidade = check(await db.rpc('frete_enfileirar_cotacao', { p_cotacao_id: row.id, p_texto: montarSolicitacao(row.dados, `FRETE-${row.id}`), p_actor: req.user.id }))
    res.json({ enfileiradas: quantidade, mensagem: 'Solicitações registradas na fila da Evolution financeira. A entrega será confirmada por transportadora.' })
  }))
  // Prepared contact operations stay closed until server readiness is confirmed.
  const contactUnconfirmed = () => new FreteError('Não foi possível confirmar a operação. Ela pode ter sido concluída; confira o atendimento antes de qualquer nova ação.', 503)
  const contactHandler = fn => async (req, res) => {
    try {
      if (req.authMethod !== 'jwt' || !UUID.test(req.user?.id ?? '')) throw new FreteError('Sessão humana autenticada obrigatória.', 403)
      await fn(req, res)
    } catch (e) {
      if (e instanceof FreteError) return res.status(e.status).json({ erro: e.message })
      if (e?.code === 'P0001') return res.status(409).json({ erro: 'Atendimento alterado ou operação indisponível. Atualize os dados antes de decidir a próxima ação.' })
      console.error('[fretes] CONTACT_OPERATION_UNCONFIRMED')
      const err = contactUnconfirmed()
      res.status(err.status).json({ erro: err.message })
    }
  }
  const validateContactVersion = value => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value.slice(0, 10) + 'T00:00:00Z').toISOString().slice(0, 10) !== value.slice(0, 10)) throw new FreteError('Atualize o atendimento antes de continuar.', 409)
  }
  const confirmContactReceipt = (row, quoteId, consultationId, release) => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || row.id !== consultationId || row.cotacao_id !== quoteId || row.ia_pausada !== true || (release && row.contato_liberado !== true)) throw contactUnconfirmed()
    return { id: row.id, cotacao_id: row.cotacao_id, ia_pausada: row.ia_pausada, contato_liberado: row.contato_liberado }
  }
  router.post('/:id/consultas/:consultaId/liberar-contato', contactHandler(async (req, res) => {
    if (CONFIG().acoes_contato.liberar_contato !== true) throw new FreteError('Liberação de contato indisponível: prontidão do servidor ainda não confirmada.', 409)
    validateContactVersion(req.body?.versao)
    const quoteId = id(req.params.id), consultationId = id(req.params.consultaId)
    const row = check(await db.rpc('frete_liberar_contato', { p_cotacao_id: quoteId, p_consulta_id: consultationId, p_versao: req.body.versao, p_actor: req.user.id }))
    res.json(confirmContactReceipt(row, quoteId, consultationId, true))
  }))
  router.post('/:id/consultas/:consultaId/respostas/:respostaId/associar', contactHandler(async (req, res) => {
    if (CONFIG().acoes_contato.associar_resposta !== true) throw new FreteError('Associação de resposta indisponível: prontidão do servidor ainda não confirmada.', 409)
    validateContactVersion(req.body?.versao)
    const quoteId = id(req.params.id), consultationId = id(req.params.consultaId), responseId = id(req.params.respostaId)
    const row = check(await db.rpc('frete_associar_resposta', { p_cotacao_id: quoteId, p_consulta_id: consultationId, p_resposta_id: responseId, p_versao: req.body.versao, p_actor: req.user.id }))
    const receipt = confirmContactReceipt(row, quoteId, consultationId, false)
    // One readback verifies the exact response link; failure never retries the write.
    const linked = check(await db.from('frete_respostas_pendentes').select('id,consulta_id').eq('id', responseId).maybeSingle())
    if (!linked || linked.id !== responseId || linked.consulta_id !== consultationId) throw contactUnconfirmed()
    res.json({ ...receipt, resposta_associada_id: linked.id })
  }))
  router.patch('/:id/consultas/:consultaId', handler(async (req, res) => {
    if (req.body?.ia_pausada === true && Object.keys(req.body).length === 1) {
      await cotacao(req.params.id)
      const row = check(await db.rpc('frete_pausar_consulta', { p_cotacao_id: id(req.params.id), p_consulta_id: id(req.params.consultaId), p_actor: req.user.id }))
      return res.json(row)
    }
    const campos = validarProposta(req.body)
    if(typeof req.body.versao!=='string'||!Number.isFinite(Date.parse(req.body.versao)))throw new FreteError('Atualize a proposta antes de salvar.',409)
    campos.versao=req.body.versao
    await cotacao(req.params.id)
    const row = check(await db.rpc('frete_salvar_proposta', { p_cotacao_id: id(req.params.id), p_consulta_id: id(req.params.consultaId), p_campos: campos, p_actor: req.user.id }))
    res.json(row)
  }))
  router.post('/:id/encerrar', handler(async (req, res) => {
    await cotacao(req.params.id)
    check(await db.rpc('frete_encerrar_cotacao', { p_cotacao_id: id(req.params.id), p_actor: req.user.id }))
    res.json({ status: 'encerrada' })
  }))
  return router
}
export default createFretesRouter()
