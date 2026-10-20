import {carregarCadastroFisicoDoPedido} from '../lib/fretes/logistica.js'
import { normalizarCnpj, validarCnpj } from '../lib/cnpj.js'
import { validarBuscaPedido, prepararPedidoFrete, validarPedidoImportavel } from '../lib/fretes/pedido.js'
import { lerLogisticaNetvision } from '../lib/fretes/netvision.js'
import { Router } from 'express'
import { supabase } from '../lib/supabase-admin.server.js'
import { adminOuFinanceiro } from '../middleware/auth.js'
import { candidatosTelefone,telefonesEquivalentes } from '../lib/telefone.js'
import { compararPropostas, validarCotacao, validarConfigTransportadora, validarProposta, montarSolicitacao, UUID, FreteError } from '../lib/fretes/domain.js'

const CONFIG = () => ({ envio_ativo: process.env.FRETE_ENVIO_ATIVO === 'true', ia_ativa: process.env.FRETE_IA_ATIVA === 'true' })
function check(result) { if (result.error) throw result.error; return result.data }
function id(v) { if (!UUID.test(v ?? '')) throw new FreteError('Identificador inválido.'); return v }
function handler(fn) {
  return async (req, res) => {
    try { await fn(req, res) } catch (e) {
      if (e.code === '23505') return res.status(409).json({ erro: 'Registro concorrente ou duplicado. Atualize antes de repetir; não é necessário encerrar outras cotações.' })
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
    const anexos=check(await db.from('frete_anexos').select('mensagem_id,status,mimetype').eq('cotacao_id',row.id))??[]
    const telefones=[...new Set(consultas.flatMap(c=>c.telefone?candidatosTelefone(c.telefone):[]))]
    const pendentes=telefones.length?check(await db.from('frete_respostas_pendentes').select('id,telefone,texto,created_at,anexo_status,mimetype').is('consulta_id',null).eq('instance_name','vivenzza-financeiro').in('telefone',telefones).order('created_at').limit(100))??[]:[]
    for(const consulta of consultas)consulta.respostas_pendentes=pendentes.filter(p=>telefonesEquivalentes(p.telefone,consulta.telefone))
    res.json({ cotacao: row, consultas: consultas.map(c => ({ ...c, envios: envios.filter(e => e.consulta_id === c.id), mensagens: mensagens.filter(m => m.consulta_id === c.id).reverse().map(m=>({...m,anexo:anexos.find(a=>a.mensagem_id===m.id)||null})) })), comparativo: compararPropostas(consultas, row.dados), config: CONFIG() })
  }))
  router.get('/:id/anexos/:mensagemId',handler(async(req,res)=>{
    const m=check(await db.from('frete_mensagens').select('id').eq('id',id(req.params.mensagemId)).eq('cotacao_id',id(req.params.id)).maybeSingle())
    if(!m)throw new FreteError('Anexo não encontrado.',404)
    const a=check(await db.from('frete_anexos').select('mimetype,conteudo_base64').eq('mensagem_id',m.id).maybeSingle())
    if(!a?.conteudo_base64)throw new FreteError('Anexo indisponível.',404)
    res.set({'Content-Type':a.mimetype,'Content-Disposition':'attachment; filename="proposta-frete"','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}).send(Buffer.from(a.conteudo_base64,'base64'))
  }))
  router.post('/:id/enviar', handler(async (req, res) => {
    if (!CONFIG().envio_ativo) throw new FreteError('Envio Evolution ainda não habilitado para este módulo. A cotação pode ser preenchida e comparada.', 409)
    const row = await cotacao(req.params.id)
    const quantidade = check(await db.rpc('frete_enfileirar_cotacao', { p_cotacao_id: row.id, p_texto: montarSolicitacao(row.dados, `FRETE-${row.id}`), p_actor: req.user.id }))
    res.json({ enfileiradas: quantidade, mensagem: 'Solicitações registradas na fila da Evolution financeira. A entrega será confirmada por transportadora.' })
  }))
  router.post('/:id/consultas/:consultaId/liberar-contato', handler(async(req,res)=>{
    if(typeof req.body?.versao!=='string'||!Number.isFinite(Date.parse(req.body.versao)))throw new FreteError('Atualize o atendimento antes de liberar.',409)
    res.json(check(await db.rpc('frete_liberar_contato',{p_cotacao_id:id(req.params.id),p_consulta_id:id(req.params.consultaId),p_versao:req.body.versao,p_actor:req.user.id})))
  }))
  router.post('/:id/consultas/:consultaId/respostas/:respostaId/associar',handler(async(req,res)=>{
    if(typeof req.body?.versao!=='string'||!Number.isFinite(Date.parse(req.body.versao)))throw new FreteError('Atualize o atendimento antes de associar.',409)
    res.json(check(await db.rpc('frete_associar_resposta',{p_cotacao_id:id(req.params.id),p_consulta_id:id(req.params.consultaId),p_resposta_id:id(req.params.respostaId),p_versao:req.body.versao,p_actor:req.user.id})))
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
