import { randomUUID, createHash } from 'crypto'
import { Router } from 'express'
import { supabase } from '../lib/supabase-admin.server.js'
import { gerarXmlNFe } from '../services/nfe/xml.js'
import { assinarNFe } from '../services/nfe/assinar.js'
import { enviarNFe, consultarNFe, cancelarNFe, statusSefaz } from '../services/nfe/sefaz.js'
import { SEFAZ } from '../services/nfe/emitente.js'
import { exigirTransicaoValida } from '../services/nfe/estados.js'
import { registrarEvento } from '../services/nfe/eventos.js'
import { buscarCodigoMunicipio } from '../lib/ibge.js'
import { gerarComissao, estornarComissao } from '../lib/comissoes.js'
import { validarDocumento } from '../lib/cnpj.js'
import { vincularSerie1Autorizada, vincularSerie99Interna, desvincularSeForAAtual } from '../lib/pedidoFiscal.js'

const router = Router()

function sha256(texto) {
  return createHash('sha256').update(texto, 'utf8').digest('hex')
}

const AMBIENTE_ATUAL = SEFAZ.tpAmb === '1' ? 'producao' : 'homologacao'

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
      .select('id, tipo, numero, serie, tipo_documento, chave, status, protocolo, data_emissao, dest_nome, dest_cnpj_cpf, valor_total, natureza_operacao, created_at', { count: 'exact' })
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

    // Destinatário incorreto bloqueado na origem, antes de qualquer chamada à
    // SEFAZ — CNPJ alfanumérico-compatível (Nota Técnica 2025.002), CPF clássico.
    if (dest_cnpj_cpf && !validarDocumento(dest_cnpj_cpf)) {
      return res.status(400).json({ erro: `CNPJ/CPF do destinatário inválido: "${dest_cnpj_cpf}"` })
    }

    if (pedido_id) {
      const { count: jaAutorizada } = await supabase
        .from('nfe')
        .select('id', { count: 'exact', head: true })
        .eq('pedido_id', pedido_id)
        .eq('status', 'autorizada')
      if (jaAutorizada > 0) {
        return res.status(409).json({ erro: 'Este pedido já tem NF-e autorizada' })
      }
    }

    // Série 99 = Nota Interna: documento sem validade fiscal, nunca vai à SEFAZ.
    // Nasce e morre nesta requisição (sem rascunho → emitir em duas etapas como
    // a série 1) — já sai com número da série 99 e status final.
    const serieNum = Number(serie) === 99 ? 99 : 1
    const notaInterna = serieNum === 99
    const tipo_documento = notaInterna ? 'nota_interna' : 'nfe_sefaz'

    // Resolve o código IBGE do município do destinatário dinamicamente (uf + nome) —
    // usado no XML em vez de um valor fixo. Best-effort: se não resolver (nome não
    // bate, API fora do ar), fica null e a emissão em produção barra com erro claro
    // em vez de sair com o município errado (ver services/nfe/xml.js). Nota interna
    // não gera XML fiscal, então não precisa resolver isso.
    const dest_cmun = notaInterna ? null : await buscarCodigoMunicipio(dest_uf, dest_municipio)

    // Calcula totais
    const valorProdutos = itens.reduce((acc, i) => acc + Number(i.valor_total), 0)
    const valorTotal = valorProdutos + Number(valor_frete) - Number(valor_desconto)
    const valorIcms = itens.reduce((acc, i) => acc + Number(i.valor_icms || 0), 0)
    const valorPis = itens.reduce((acc, i) => acc + Number(i.valor_pis || 0), 0)
    const valorCofins = itens.reduce((acc, i) => acc + Number(i.valor_cofins || 0), 0)

    let numero = null
    if (notaInterna) {
      const { data: seq } = await supabase.rpc('proxima_nfe', { p_serie: 99 })
      numero = seq || 1
    }

    // Cria a NFe
    const { data: nfe, error: errNfe } = await supabase
      .from('nfe')
      .insert({
        tipo, serie: serieNum, tipo_documento, numero, natureza_operacao, finalidade, forma_pagamento,
        dest_nome, dest_cnpj_cpf, dest_ie,
        dest_logradouro, dest_numero, dest_complemento,
        dest_bairro, dest_municipio, dest_uf, dest_cmun, dest_cep, dest_fone, dest_email,
        transp_modalidade, valor_frete: Number(valor_frete),
        valor_produtos: valorProdutos,
        valor_desconto: Number(valor_desconto),
        valor_total: valorTotal,
        valor_icms: valorIcms,
        valor_pis: valorPis,
        valor_cofins: valorCofins,
        observacoes, pedido_id: pedido_id || null, lead_id: lead_id || null,
        usuario_id: req.user?.id,
        status: notaInterna ? 'emitida_interna' : 'rascunho',
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

    await registrarEvento({
      nfeId: nfe.id, tipoEvento: 'criacao', statusNovo: nfe.status,
      usuarioId: req.user?.id, motivo: notaInterna ? 'Nota interna (série 99)' : 'Rascunho (série 1)',
    })

    // Nota interna gera comissão de imediato — não há autorização da SEFAZ pra
    // esperar. O gatilho da série 1 continua sendo a autorização, em POST /:id/emitir.
    // Classificação de faturamento: série 99 nunca é venda fiscal (regras 6/11),
    // fica 'nao_fiscal' pro Dashboard não contar como faturamento real.
    if (notaInterna && pedido_id) {
      await gerarComissao(nfe.id).catch(err => console.error('[nfe] erro ao gerar comissão (nota interna):', err.message))
      await vincularSerie99Interna(pedido_id, nfe.id).catch(err => console.error('[nfe] erro ao vincular classificação (nota interna):', err.message))
    }

    const { data: completo } = await supabase.from('nfe').select('*, nfe_itens(*)').eq('id', nfe.id).single()
    res.status(201).json(completo)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// POST /api/nfe/:id/emitir — gera XML, assina e envia à SEFAZ
router.post('/:id/emitir', async (req, res) => {
  const correlationId = randomUUID()
  try {
    const { data: nfe, error } = await supabase
      .from('nfe')
      .select('*, nfe_itens(*)')
      .eq('id', req.params.id)
      .single()

    if (error || !nfe) return res.status(404).json({ erro: 'NFe não encontrada' })
    if (nfe.tipo_documento === 'nota_interna') {
      return res.status(400).json({ erro: 'Nota interna não pode ser transmitida à SEFAZ' })
    }
    if (!['rascunho', 'rejeitada'].includes(nfe.status)) {
      return res.status(409).json({ erro: `NFe com status "${nfe.status}" não pode ser emitida novamente` })
    }

    // Trava de numeração real da série 1 — bloqueada até o contador confirmar
    // o número inicial seguro (numeração legada bagunçada, ver migrations/
    // configuracoes_fiscais.sql). Homologação também respeita a trava: evita
    // testar com um número que depois colide com o valor real definido.
    if (Number(nfe.serie) === 1) {
      const { data: config } = await supabase
        .from('configuracoes_fiscais').select('serie1_numeracao_liberada').eq('id', 1).maybeSingle()
      if (!config?.serie1_numeracao_liberada) {
        return res.status(423).json({
          erro: 'Emissão da série 1 (fiscal real) está bloqueada até a numeração inicial ser confirmada com o contador. Ver tabela configuracoes_fiscais.',
        })
      }
    }

    if (nfe.pedido_id) {
      const { count: jaAutorizada } = await supabase
        .from('nfe')
        .select('id', { count: 'exact', head: true })
        .eq('pedido_id', nfe.pedido_id)
        .eq('status', 'autorizada')
      if (jaAutorizada > 0) {
        return res.status(409).json({ erro: 'Este pedido já tem NF-e autorizada' })
      }
    }

    exigirTransicaoValida(nfe.status, 'enviada')

    // Trava de concorrência: compare-and-swap atômico no próprio WHERE — só
    // move pra 'enviada' se o status ainda for exatamente o que acabamos de
    // ler. Duplo clique / retry / duas réplicas processando a mesma requisição
    // ao mesmo tempo: só uma consegue 0→1 linha afetada aqui; as demais recebem
    // 409 e nunca chegam a chamar a SEFAZ nem a tirar um número da sequência.
    const { data: reservada, error: erroReserva } = await supabase
      .from('nfe')
      .update({ status: 'enviada', correlation_id: correlationId, enviada_em: new Date().toISOString() })
      .eq('id', nfe.id)
      .eq('status', nfe.status)
      .select('id')
      .maybeSingle()
    if (erroReserva) throw erroReserva
    if (!reservada) {
      return res.status(409).json({ erro: 'Esta NF-e já está sendo processada por outra requisição — aguarde ou consulte o status antes de tentar de novo.' })
    }

    await registrarEvento({
      nfeId: nfe.id, tipoEvento: 'envio', statusAnterior: nfe.status, statusNovo: 'enviada',
      correlationId, usuarioId: req.user?.id,
    })

    // Obtém próximo número da sequência (RPC atômica — proxima_nfe.sql, UPDATE
    // ... RETURNING — já é concorrência-segura independente da trava acima).
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
      await supabase.from('nfe').update({ status: 'rascunho', motivo_rejeicao: `Erro ao assinar: ${errAssin.message}` }).eq('id', nfe.id)
      await registrarEvento({
        nfeId: nfe.id, tipoEvento: 'erro_comunicacao', statusAnterior: 'enviada', statusNovo: 'rascunho',
        correlationId, motivo: errAssin.message, usuarioId: req.user?.id,
      })
      return res.status(500).json({ erro: `Erro ao assinar NFe: ${errAssin.message}` })
    }

    const hashEnviado = sha256(xmlAssinado)

    // Atualiza número, chave, XML e hash no banco ANTES de enviar — se o
    // processo cair logo depois do envio (antes de processar a resposta), o
    // job de reconciliação (jobs/reconciliar-nfe.js) já tem chave/protocolo
    // suficientes pra consultar a SEFAZ e concluir sem reemitir.
    await supabase.from('nfe').update({
      numero, chave, xml_enviado: xmlAssinado, hash_xml_enviado: hashEnviado,
      ambiente: AMBIENTE_ATUAL, versao_schema: '4.00',
    }).eq('id', nfe.id)

    // Envia à SEFAZ
    let retorno
    try {
      retorno = await enviarNFe(xmlAssinado)
    } catch (errEnvio) {
      // NÃO volta pra 'rascunho' automaticamente: a essa altura pode ter ido
      // à SEFAZ e travado só na resposta (timeout de rede) — reemitir cegamente
      // arrisca duplicar. Fica em 'enviada' pro job de reconciliação resolver
      // consultando o protocolo; só o comunicado de erro muda.
      await supabase.from('nfe').update({ motivo_rejeicao: `Erro de comunicação: ${errEnvio.message}` }).eq('id', nfe.id)
      await registrarEvento({
        nfeId: nfe.id, tipoEvento: 'erro_comunicacao', statusAnterior: 'enviada', statusNovo: 'enviada',
        correlationId, motivo: errEnvio.message, usuarioId: req.user?.id,
      })
      return res.status(502).json({ erro: `Erro de comunicação com SEFAZ: ${errEnvio.message} — a nota permanece "enviada" até a reconciliação confirmar o resultado real (evita reemissão duplicada).` })
    }

    // Processa retorno SEFAZ
    // cStat 100 = autorizado, 150 = autorizado fora do prazo
    const autorizado = retorno.cStat === '100' || retorno.cStat === '150'
    const denegado = retorno.cStat === '110' || retorno.cStat === '205' // denegação: CNPJ irregular/situação cadastral
    const novoStatus = autorizado ? 'autorizada' : denegado ? 'denegada' : 'rejeitada'
    exigirTransicaoValida('enviada', novoStatus)

    await supabase.from('nfe').update({
      status: novoStatus,
      protocolo: autorizado ? retorno.protocolo : null,
      xml_autorizado: autorizado ? retorno.respXml : null,
      hash_xml_autorizado: autorizado ? sha256(retorno.respXml) : null,
      motivo_rejeicao: autorizado ? null : `${retorno.cStat} - ${retorno.xMotivo}`,
      reconciliada: true,
    }).eq('id', nfe.id)

    await registrarEvento({
      nfeId: nfe.id, tipoEvento: autorizado ? 'autorizacao' : denegado ? 'denegacao' : 'rejeicao',
      statusAnterior: 'enviada', statusNovo: novoStatus, correlationId,
      cstat: retorno.cStat, xMotivo: retorno.xMotivo, protocolo: retorno.protocolo, usuarioId: req.user?.id,
    })

    // Efeitos pós-autorização — só rodam se autorizado. Rejeitada/denegada:
    // nunca move estoque, financeiro ou comissão (a nota não existe pra SEFAZ).
    if (nfe.pedido_id) {
      await supabase.from('pedidos').update({
        status_fiscal: autorizado ? 'autorizado' : 'rejeitado',
        numero_nfe: autorizado ? String(numero) : null,
      }).eq('id', nfe.pedido_id)

      if (autorizado) {
        // Não deixa erro ao gerar comissão/vincular classificação derrubar a resposta
        // de emissão da NF-e — a NF-e já está autorizada na SEFAZ nesse ponto, isso
        // não pode ser desfeito. nfe.nfe_itens já veio no select do topo da rota.
        await gerarComissao(nfe.id).catch(err => console.error('[nfe] erro ao gerar comissão:', err.message))
        await vincularSerie1Autorizada(nfe.pedido_id, nfe).catch(err => console.error('[nfe] erro ao vincular classificação de faturamento:', err.message))
      }
    }

    const { data: atualizada } = await supabase.from('nfe').select('*').eq('id', nfe.id).single()
    res.json({ ...atualizada, sefaz: retorno })
  } catch (err) {
    await registrarEvento({ nfeId: req.params.id, tipoEvento: 'erro_comunicacao', motivo: err.message, correlationId, usuarioId: req.user?.id })
    res.status(500).json({ erro: err.message })
  }
})

// POST /api/nfe/:id/cancelar
router.post('/:id/cancelar', async (req, res) => {
  try {
    const { justificativa } = req.body

    const { data: nfe } = await supabase.from('nfe').select('*').eq('id', req.params.id).single()
    if (!nfe) return res.status(404).json({ erro: 'NFe não encontrada' })

    // Nota interna: cancelamento é só uma baixa no próprio banco, nunca fala com a
    // SEFAZ. Estorna a comissão gerada (se ainda 'disponivel') — a venda foi desfeita.
    if (nfe.tipo_documento === 'nota_interna') {
      if (nfe.status !== 'emitida_interna') {
        return res.status(400).json({ erro: `Nota interna com status "${nfe.status}" não pode ser cancelada` })
      }
      exigirTransicaoValida(nfe.status, 'cancelada_interna')

      await supabase.from('nfe').update({
        status: 'cancelada_interna',
        motivo_rejeicao: justificativa || null,
      }).eq('id', nfe.id)

      await registrarEvento({
        nfeId: nfe.id, tipoEvento: 'cancelamento', statusAnterior: 'emitida_interna', statusNovo: 'cancelada_interna',
        motivo: justificativa || null, usuarioId: req.user?.id,
      })

      await estornarComissao(nfe.id).catch(err => console.error('[nfe] erro ao estornar comissão (nota interna):', err.message))
      await registrarEvento({ nfeId: nfe.id, tipoEvento: 'estorno_comissao', usuarioId: req.user?.id })

      if (nfe.pedido_id) {
        await supabase.from('pedidos').update({ status_fiscal: 'cancelado' }).eq('id', nfe.pedido_id)
        await desvincularSeForAAtual(nfe.pedido_id, nfe.id).catch(err => console.error('[nfe] erro ao desvincular classificação (nota interna):', err.message))
      }

      return res.json({ cancelado: true })
    }

    if (!justificativa || justificativa.length < 15) {
      return res.status(400).json({ erro: 'Justificativa deve ter ao menos 15 caracteres' })
    }
    if (nfe.status !== 'autorizada') return res.status(400).json({ erro: 'Somente NFe autorizada pode ser cancelada' })
    if (!nfe.protocolo) return res.status(400).json({ erro: 'NFe sem protocolo de autorização' })
    exigirTransicaoValida(nfe.status, 'cancelada')

    const retorno = await cancelarNFe(nfe.chave, nfe.protocolo, justificativa)

    const cancelado = retorno.cStat === '135'
    if (cancelado) {
      await supabase.from('nfe').update({
        status: 'cancelada',
        xml_cancelamento: retorno.respXml,
        motivo_rejeicao: null,
      }).eq('id', req.params.id)
    } else {
      // Não confirmado pela SEFAZ: NÃO muda o status (a nota continua
      // 'autorizada' de verdade) — só registra o motivo pra próxima tentativa.
      await supabase.from('nfe').update({ motivo_rejeicao: `${retorno.cStat} - ${retorno.xMotivo}` }).eq('id', req.params.id)
    }

    await registrarEvento({
      nfeId: nfe.id, tipoEvento: 'cancelamento', statusAnterior: 'autorizada', statusNovo: cancelado ? 'cancelada' : 'autorizada',
      cstat: retorno.cStat, xMotivo: retorno.xMotivo, motivo: justificativa, usuarioId: req.user?.id,
    })

    if (cancelado) {
      // NF-e cancelada na SEFAZ = venda desfeita — estorna a comissão gerada na
      // autorização (se ainda 'disponivel'), senão o vendedor fica com comissão
      // de uma venda que não existe mais.
      await estornarComissao(nfe.id).catch(err => console.error('[nfe] erro ao estornar comissão:', err.message))
      await registrarEvento({ nfeId: nfe.id, tipoEvento: 'estorno_comissao', usuarioId: req.user?.id })

      if (nfe.pedido_id) {
        await supabase.from('pedidos').update({ status_fiscal: 'cancelado' }).eq('id', nfe.pedido_id)
        await desvincularSeForAAtual(nfe.pedido_id, nfe.id).catch(err => console.error('[nfe] erro ao desvincular classificação:', err.message))
      }
    }

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
