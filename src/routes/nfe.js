import { Router } from 'express'
import { supabase } from '../lib/supabase.js'
import { gerarXmlNFe } from '../services/nfe/xml.js'
import { assinarNFe } from '../services/nfe/assinar.js'
import { enviarNFe, consultarNFe, cancelarNFe, statusSefaz } from '../services/nfe/sefaz.js'

const router = Router()

// GET /api/nfe/status-sefaz
router.get('/status-sefaz', async (req, res) => {
  try {
    const status = await statusSefaz()
    res.json(status)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/nfe — listar notas
router.get('/', async (req, res) => {
  try {
    const { status, tipo, page = 1, limit = 50 } = req.query
    const offset = (Number(page) - 1) * Number(limit)

    let query = supabase
      .from('nfe')
      .select('id, tipo, numero, serie, chave, status, protocolo, data_emissao, dest_nome, dest_cnpj_cpf, valor_total, natureza_operacao, created_at', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + Number(limit) - 1)

    if (status) query = query.eq('status', status)
    if (tipo) query = query.eq('tipo', tipo)

    const { data, error, count } = await query
    if (error) throw error

    res.json({ data, total: count, page: Number(page), limit: Number(limit) })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/nfe/:id — detalhe com itens
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('nfe')
      .select('*, nfe_itens(*)')
      .eq('id', req.params.id)
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ erro: 'NFe não encontrada' })

    res.json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/nfe/:id/xml — retorna o XML autorizado
router.get('/:id/xml', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('nfe')
      .select('xml_autorizado, xml_enviado, chave, numero')
      .eq('id', req.params.id)
      .single()

    if (error) throw error

    const xml = data.xml_autorizado || data.xml_enviado
    if (!xml) return res.status(404).json({ erro: 'XML não disponível' })

    res.setHeader('Content-Type', 'application/xml')
    res.setHeader('Content-Disposition', `attachment; filename="NFe${data.chave || data.numero}.xml"`)
    res.send(xml)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// POST /api/nfe — criar rascunho de NFe
router.post('/', async (req, res) => {
  try {
    const {
      tipo = 'nfe',
      serie = 1,
      natureza_operacao,
      finalidade = 1,
      forma_pagamento = '01',
      dest_nome, dest_cnpj_cpf, dest_ie,
      dest_logradouro, dest_numero, dest_complemento,
      dest_bairro, dest_municipio, dest_uf, dest_cep,
      dest_fone, dest_email,
      transp_modalidade = 9,
      valor_frete = 0,
      valor_desconto = 0,
      observacoes,
      pedido_id, lead_id,
      itens = [],
    } = req.body

    if (!itens.length) {
      return res.status(400).json({ erro: 'Ao menos um item é obrigatório' })
    }

    // Calcula totais
    const valorProdutos = itens.reduce((acc, i) => acc + Number(i.valor_total), 0)
    const valorTotal = valorProdutos + Number(valor_frete) - Number(valor_desconto)
    const valorIcms = itens.reduce((acc, i) => acc + Number(i.valor_icms || 0), 0)
    const valorPis = itens.reduce((acc, i) => acc + Number(i.valor_pis || 0), 0)
    const valorCofins = itens.reduce((acc, i) => acc + Number(i.valor_cofins || 0), 0)

    // Cria a NFe
    const { data: nfe, error: errNfe } = await supabase
      .from('nfe')
      .insert({
        tipo, serie, natureza_operacao, finalidade, forma_pagamento,
        dest_nome, dest_cnpj_cpf, dest_ie,
        dest_logradouro, dest_numero, dest_complemento,
        dest_bairro, dest_municipio, dest_uf, dest_cep, dest_fone, dest_email,
        transp_modalidade, valor_frete: Number(valor_frete),
        valor_produtos: valorProdutos,
        valor_desconto: Number(valor_desconto),
        valor_total: valorTotal,
        valor_icms: valorIcms,
        valor_pis: valorPis,
        valor_cofins: valorCofins,
        observacoes, pedido_id: pedido_id || null, lead_id: lead_id || null,
        usuario_id: req.user?.id,
        status: 'rascunho',
      })
      .select()
      .single()

    if (errNfe) throw errNfe

    // Cria itens
    if (itens.length > 0) {
      const itensData = itens.map((item, idx) => ({
        nfe_id: nfe.id,
        numero_item: idx + 1,
        produto_id: item.produto_id || null,
        codigo: item.codigo,
        descricao: item.descricao,
        ncm: item.ncm,
        cfop: item.cfop || '5102',
        unidade: item.unidade || 'UN',
        quantidade: Number(item.quantidade),
        valor_unitario: Number(item.valor_unitario),
        valor_total: Number(item.valor_total),
        cst_icms: item.cst_icms || '00',
        aliq_icms: Number(item.aliq_icms || 0),
        valor_icms: Number(item.valor_icms || 0),
        cst_pis: item.cst_pis || '07',
        valor_pis: Number(item.valor_pis || 0),
        cst_cofins: item.cst_cofins || '07',
        valor_cofins: Number(item.valor_cofins || 0),
        valor_desconto: Number(item.valor_desconto || 0),
      }))

      const { error: errItens } = await supabase.from('nfe_itens').insert(itensData)
      if (errItens) throw errItens
    }

    const { data: completo } = await supabase.from('nfe').select('*, nfe_itens(*)').eq('id', nfe.id).single()
    res.status(201).json(completo)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// POST /api/nfe/:id/emitir — gera XML, assina e envia à SEFAZ
router.post('/:id/emitir', async (req, res) => {
  try {
    const { data: nfe, error } = await supabase
      .from('nfe')
      .select('*, nfe_itens(*)')
      .eq('id', req.params.id)
      .single()

    if (error || !nfe) return res.status(404).json({ erro: 'NFe não encontrada' })
    if (!['rascunho', 'rejeitada'].includes(nfe.status)) {
      return res.status(400).json({ erro: `NFe com status "${nfe.status}" não pode ser emitida novamente` })
    }

    // Obtém próximo número da sequência
    const { data: seq } = await supabase.rpc('proxima_nfe', { p_serie: nfe.serie })
    const numero = seq || 1

    // Gera chave e XML
    const nfeComNumero = { ...nfe, numero }
    const { chave, xml } = gerarXmlNFe(nfeComNumero)

    // Assina o XML
    let xmlAssinado
    try {
      xmlAssinado = assinarNFe(xml, chave)
    } catch (errAssin) {
      return res.status(500).json({ erro: `Erro ao assinar NFe: ${errAssin.message}` })
    }

    // Atualiza número e chave no banco
    await supabase.from('nfe').update({ numero, chave, xml_enviado: xmlAssinado, status: 'enviada' }).eq('id', nfe.id)

    // Envia à SEFAZ
    let retorno
    try {
      retorno = await enviarNFe(xmlAssinado)
    } catch (errEnvio) {
      await supabase.from('nfe').update({ status: 'rascunho', motivo_rejeicao: errEnvio.message }).eq('id', nfe.id)
      return res.status(502).json({ erro: `Erro de comunicação com SEFAZ: ${errEnvio.message}` })
    }

    // Processa retorno SEFAZ
    // cStat 100 = autorizado, 150 = autorizado fora do prazo
    const autorizado = retorno.cStat === '100' || retorno.cStat === '150'
    const novoStatus = autorizado ? 'autorizada' : 'rejeitada'

    await supabase.from('nfe').update({
      status: novoStatus,
      protocolo: autorizado ? retorno.protocolo : null,
      xml_autorizado: autorizado ? retorno.respXml : null,
      motivo_rejeicao: autorizado ? null : `${retorno.cStat} - ${retorno.xMotivo}`,
    }).eq('id', nfe.id)

    const { data: atualizada } = await supabase.from('nfe').select('*').eq('id', nfe.id).single()
    res.json({ ...atualizada, sefaz: retorno })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// POST /api/nfe/:id/cancelar
router.post('/:id/cancelar', async (req, res) => {
  try {
    const { justificativa } = req.body

    if (!justificativa || justificativa.length < 15) {
      return res.status(400).json({ erro: 'Justificativa deve ter ao menos 15 caracteres' })
    }

    const { data: nfe } = await supabase.from('nfe').select('*').eq('id', req.params.id).single()
    if (!nfe) return res.status(404).json({ erro: 'NFe não encontrada' })
    if (nfe.status !== 'autorizada') return res.status(400).json({ erro: 'Somente NFe autorizada pode ser cancelada' })
    if (!nfe.protocolo) return res.status(400).json({ erro: 'NFe sem protocolo de autorização' })

    const retorno = await cancelarNFe(nfe.chave, nfe.protocolo, justificativa)

    const cancelado = retorno.cStat === '135'
    await supabase.from('nfe').update({
      status: cancelado ? 'cancelada' : nfe.status,
      xml_cancelamento: retorno.respXml,
      motivo_rejeicao: cancelado ? null : `${retorno.cStat} - ${retorno.xMotivo}`,
    }).eq('id', req.params.id)

    res.json({ cancelado, ...retorno })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/nfe/:id/consultar — consulta status na SEFAZ
router.get('/:id/consultar', async (req, res) => {
  try {
    const { data: nfe } = await supabase.from('nfe').select('chave').eq('id', req.params.id).single()
    if (!nfe?.chave) return res.status(400).json({ erro: 'NFe sem chave de acesso' })

    const retorno = await consultarNFe(nfe.chave)
    res.json(retorno)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

export default router
