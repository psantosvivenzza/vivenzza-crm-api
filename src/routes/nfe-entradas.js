import { Router } from 'express'
import { supabase } from '../lib/supabase.js'
import { EMITENTE } from '../services/nfe/emitente.js'
import { parseNFeXml, sha256 } from '../services/nfe-entrada/xml.js'
import { validarEstruturaEntrada } from '../services/nfe-entrada/validacao.js'
import { normalizarCnpj } from '../lib/cnpj.js'
import { adminOnly } from '../middleware/auth.js'

const router = Router()

// GET /api/nfe-entradas — lista (a Caixa de Entrada SEFAZ usa isto pras 8 abas de status)
router.get('/', async (req, res) => {
  try {
    const { status, fornecedor_id, data_de, data_ate, page = 1, limit = 50 } = req.query
    const offset = (Number(page) - 1) * Number(limit)

    let query = supabase
      .from('nfe_entradas')
      .select('*, fornecedores(id, razao_social, nome_fantasia, cnpj)', { count: 'exact' })
      .order('criado_em', { ascending: false })
      .range(offset, offset + Number(limit) - 1)

    if (status) query = query.eq('status', status)
    if (fornecedor_id) query = query.eq('fornecedor_id', fornecedor_id)
    if (data_de) query = query.gte('data_entrada', data_de)
    if (data_ate) query = query.lte('data_entrada', data_ate)

    const { data, error, count } = await query
    if (error) throw error

    res.json({ data, total: count, page: Number(page), limit: Number(limit) })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/nfe-entradas/:id — detalhe completo (nota + itens + fornecedor + eventos)
router.get('/:id', async (req, res) => {
  try {
    const { data: nota, error } = await supabase
      .from('nfe_entradas')
      .select('*, fornecedores(*)')
      .eq('id', req.params.id)
      .single()

    if (error) throw error
    if (!nota) return res.status(404).json({ erro: 'Nota de entrada não encontrada' })

    const { data: itens, error: errItens } = await supabase
      .from('nfe_entrada_itens')
      .select('*, produtos(id, nome, sku, unidade, preco_custo)')
      .eq('nfe_entrada_id', req.params.id)
      .order('numero_item')

    if (errItens) throw errItens

    const { data: eventos, error: errEventos } = await supabase
      .from('nfe_entrada_eventos')
      .select('*, usuarios(id, nome)')
      .eq('nfe_entrada_id', req.params.id)
      .order('criado_em', { ascending: false })

    if (errEventos) throw errEventos

    const { data: parcelas, error: errParcelas } = await supabase
      .from('contas_financeiras')
      .select('*')
      .eq('nfe_entrada_id', req.params.id)
      .order('numero_parcela')

    if (errParcelas) throw errParcelas

    res.json({ ...nota, itens, eventos, parcelas })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/nfe-entradas/:id/xml — baixa o XML completo original
router.get('/:id/xml', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('nfe_entradas')
      .select('xml_completo, chave_acesso, numero')
      .eq('id', req.params.id)
      .single()

    if (error) throw error
    if (!data || !data.xml_completo) return res.status(404).json({ erro: 'XML não disponível para esta nota' })

    res.set('Content-Type', 'application/xml')
    res.set('Content-Disposition', `attachment; filename="NFe_${data.chave_acesso || data.numero}.xml"`)
    res.send(data.xml_completo)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// POST /api/nfe-entradas/importar-xml — importação manual de XML de NF-e de fornecedor
//
// Faz TUDO que a especificação pede antes de gravar qualquer coisa: valida
// estrutura, chave de acesso, protocolo, destinatário (tem que ser a
// Vivenzza), bloqueia XML duplicado (mesma chave OU mesmo hash) e checa se
// o fornecedor já existe pelo CNPJ do emitente — se não existir, NÃO cria
// nada sozinho: devolve os dados pro usuário confirmar na tela antes.
router.post('/importar-xml', async (req, res) => {
  try {
    const { xml } = req.body
    if (!xml || typeof xml !== 'string' || xml.trim().length === 0) {
      return res.status(400).json({ erro: 'Campo "xml" (conteúdo do arquivo XML) é obrigatório' })
    }

    let parsed
    try {
      parsed = await parseNFeXml(xml)
    } catch (err) {
      return res.status(400).json({ erro: `XML inválido: ${err.message}` })
    }

    const { valido, erros } = validarEstruturaEntrada(parsed, EMITENTE.CNPJ)
    if (!valido) {
      return res.status(422).json({ erro: 'XML não passou na validação de entrada', detalhes: erros })
    }

    const hash = sha256(xml)

    // Bloqueia duplicidade por chave de acesso OU por hash do conteúdo (cobre
    // tanto reimportação do mesmo XML quanto uma tentativa de reenviar a
    // mesma chave com XML levemente diferente).
    const { data: duplicadaPorChave } = await supabase
      .from('nfe_entradas')
      .select('id, status')
      .eq('chave_acesso', parsed.chave_acesso)
      .maybeSingle()

    if (duplicadaPorChave) {
      return res.status(409).json({
        erro: `Esta NF-e (chave ${parsed.chave_acesso}) já foi importada anteriormente`,
        nfe_entrada_id: duplicadaPorChave.id,
        status_atual: duplicadaPorChave.status,
      })
    }

    const { data: duplicadaPorHash } = await supabase
      .from('nfe_entradas')
      .select('id, status')
      .eq('hash_xml', hash)
      .maybeSingle()

    if (duplicadaPorHash) {
      return res.status(409).json({
        erro: 'Este arquivo XML (mesmo conteúdo, hash idêntico) já foi importado anteriormente',
        nfe_entrada_id: duplicadaPorHash.id,
        status_atual: duplicadaPorHash.status,
      })
    }

    // Fornecedor: busca por CNPJ. Se não achar, NÃO cria — devolve pendente.
    const cnpjFornecedor = normalizarCnpj(parsed.fornecedor.cnpj)
    const { data: fornecedorExistente } = await supabase
      .from('fornecedores')
      .select('*')
      .eq('cnpj', cnpjFornecedor)
      .maybeSingle()

    let statusInicial = fornecedorExistente ? 'aguardando_mapeamento' : 'divergencias'

    // Auto-sugestão de mapeamento de produto por código/GTIN, só se o
    // fornecedor já é conhecido (senão não há de-para pra consultar).
    //
    // Usa duas consultas .in() separadas (nunca um filtro .or() montado por
    // concatenação de string) — código de produto e GTIN vêm do XML, ou seja,
    // são dado de fora do nosso controle, e um valor com vírgula/parêntese
    // dentro de um .or() concatenado poderia quebrar ou adulterar o filtro.
    let itensParaInserir = parsed.itens
    if (fornecedorExistente) {
      const codigos = [...new Set(parsed.itens.map((i) => i.codigo_fornecedor).filter(Boolean))]
      const gtins = [...new Set(parsed.itens.map((i) => i.gtin).filter(Boolean))]

      const [porCodigo, porGtin] = await Promise.all([
        codigos.length
          ? supabase.from('produto_fornecedor_mapa').select('*').eq('fornecedor_id', fornecedorExistente.id).in('codigo_produto_fornecedor', codigos)
          : Promise.resolve({ data: [] }),
        gtins.length
          ? supabase.from('produto_fornecedor_mapa').select('*').eq('fornecedor_id', fornecedorExistente.id).in('gtin', gtins)
          : Promise.resolve({ data: [] }),
      ])

      const mapas = [...(porCodigo.data || []), ...(porGtin.data || [])]

      itensParaInserir = parsed.itens.map((item) => {
        const mapa = (mapas || []).find(
          (m) => (item.codigo_fornecedor && m.codigo_produto_fornecedor === item.codigo_fornecedor) ||
                 (item.gtin && m.gtin === item.gtin)
        )
        if (mapa) {
          return {
            ...item,
            produto_id: mapa.produto_id,
            fator_conversao: mapa.fator_conversao,
            quantidade_convertida: item.quantidade_fornecedor * mapa.fator_conversao,
            mapeado: true,
          }
        }
        return item
      })

      const algumNaoMapeado = itensParaInserir.some((i) => !i.mapeado)
      statusInicial = algumNaoMapeado ? 'aguardando_mapeamento' : 'pronta_para_entrada'
    }

    const { data: notaInserida, error: errNota } = await supabase
      .from('nfe_entradas')
      .insert({
        fornecedor_id: fornecedorExistente?.id || null,
        chave_acesso: parsed.chave_acesso,
        numero: parsed.numero,
        serie: parsed.serie,
        protocolo_autorizacao: parsed.protocolo_autorizacao,
        natureza_operacao: parsed.natureza_operacao,
        data_emissao: parsed.data_emissao,
        data_entrada: new Date().toISOString().slice(0, 10),
        ambiente: parsed.ambiente,
        origem: 'upload_manual',
        status: statusInicial,
        xml_resumo: `${parsed.fornecedor.razao_social} - NF ${parsed.numero}/${parsed.serie} - R$ ${parsed.valores.valor_total}`,
        xml_completo: xml,
        hash_xml: hash,
        valor_produtos: parsed.valores.valor_produtos,
        valor_frete: parsed.valores.valor_frete,
        valor_seguro: parsed.valores.valor_seguro,
        valor_desconto: parsed.valores.valor_desconto,
        valor_outras_despesas: parsed.valores.valor_outras_despesas,
        valor_ipi: parsed.valores.valor_ipi,
        valor_icms: parsed.valores.valor_icms,
        valor_total: parsed.valores.valor_total,
        importado_por: req.user?.id,
      })
      .select()
      .single()

    if (errNota) throw errNota

    const itensPayload = itensParaInserir.map((item) => ({
      nfe_entrada_id: notaInserida.id,
      numero_item: item.numero_item,
      codigo_fornecedor: item.codigo_fornecedor,
      descricao_fornecedor: item.descricao_fornecedor,
      ncm: item.ncm,
      cfop: item.cfop,
      gtin: item.gtin,
      unidade_fornecedor: item.unidade_fornecedor,
      quantidade_fornecedor: item.quantidade_fornecedor,
      valor_unitario_fornecedor: item.valor_unitario_fornecedor,
      valor_total_item: item.valor_total_item,
      valor_icms: item.valor_icms,
      valor_ipi: item.valor_ipi,
      valor_pis: item.valor_pis,
      valor_cofins: item.valor_cofins,
      valor_desconto_item: item.valor_desconto_item,
      produto_id: item.produto_id || null,
      fator_conversao: item.fator_conversao || 1,
      quantidade_convertida: item.quantidade_convertida || null,
      mapeado: !!item.mapeado,
    }))

    const { error: errItens } = await supabase.from('nfe_entrada_itens').insert(itensPayload)
    if (errItens) throw errItens

    await supabase.from('nfe_entrada_eventos').insert({
      nfe_entrada_id: notaInserida.id,
      tipo_evento: 'importacao_xml_manual',
      status_novo: statusInicial,
      usuario_id: req.user?.id,
      detalhes: { fornecedor_encontrado: !!fornecedorExistente, itens_auto_mapeados: itensPayload.filter((i) => i.mapeado).length, total_itens: itensPayload.length },
    })

    res.status(201).json({
      ...notaInserida,
      itens: itensPayload,
      requer_confirmacao_fornecedor: !fornecedorExistente,
      fornecedor_sugerido: !fornecedorExistente ? parsed.fornecedor : null,
      duplicatas_sugeridas_xml: parsed.duplicatas,
    })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// POST /api/nfe-entradas/:id/confirmar-fornecedor — resolve o fornecedor
// pendente de uma nota importada por XML. Ação SEMPRE explícita do usuário:
// ou ele escolhe um fornecedor já cadastrado (fornecedor_id), ou ele manda
// criar um novo com os dados extraídos do XML (criar: true + dados).
router.post('/:id/confirmar-fornecedor', async (req, res) => {
  try {
    const { fornecedor_id, criar } = req.body

    const { data: nota, error: errNota } = await supabase
      .from('nfe_entradas')
      .select('*')
      .eq('id', req.params.id)
      .single()

    if (errNota) throw errNota
    if (!nota) return res.status(404).json({ erro: 'Nota de entrada não encontrada' })

    let fornecedorId = fornecedor_id

    if (criar) {
      const cnpjNormalizado = normalizarCnpj(criar.cnpj)
      const { data: novoFornecedor, error: errFornecedor } = await supabase
        .from('fornecedores')
        .insert({
          cnpj: cnpjNormalizado,
          razao_social: criar.razao_social,
          nome_fantasia: criar.nome_fantasia || criar.razao_social,
          ie: criar.ie || null,
          endereco: criar.endereco || {},
          origem: 'xml_nfe',
          criado_por: req.user?.id,
        })
        .select()
        .single()

      if (errFornecedor) throw errFornecedor
      fornecedorId = novoFornecedor.id
    }

    if (!fornecedorId) {
      return res.status(400).json({ erro: 'Informe "fornecedor_id" (vincular a um existente) ou "criar" (dados do novo fornecedor)' })
    }

    // Recalcula status: se todos os itens já mapeados, vai pra pronta_para_entrada
    const { data: itens } = await supabase
      .from('nfe_entrada_itens')
      .select('mapeado')
      .eq('nfe_entrada_id', req.params.id)

    const todosMapeados = (itens || []).every((i) => i.mapeado)

    const { data: notaAtualizada, error } = await supabase
      .from('nfe_entradas')
      .update({ fornecedor_id: fornecedorId, status: todosMapeados ? 'pronta_para_entrada' : 'aguardando_mapeamento', atualizado_em: new Date().toISOString() })
      .eq('id', req.params.id)
      .select()
      .single()

    if (error) throw error

    await supabase.from('nfe_entrada_eventos').insert({
      nfe_entrada_id: req.params.id,
      tipo_evento: 'vinculo_fornecedor',
      status_anterior: nota.status,
      status_novo: notaAtualizada.status,
      usuario_id: req.user?.id,
      detalhes: { fornecedor_id: fornecedorId, criado_agora: !!criar },
    })

    res.json(notaAtualizada)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/nfe-entradas/sugestao-mapeamento?fornecedor_id=&codigo=&gtin= —
// consulta o de-para aprendido (produto_fornecedor_mapa) pra UI sugerir
// automaticamente o produto ao mapear um item.
router.get('/utilitarios/sugestao-mapeamento', async (req, res) => {
  try {
    const { fornecedor_id, codigo, gtin } = req.query
    if (!fornecedor_id) return res.status(400).json({ erro: '"fornecedor_id" é obrigatório' })

    let query = supabase.from('produto_fornecedor_mapa').select('*, produtos(id, nome, sku, unidade)').eq('fornecedor_id', fornecedor_id)

    if (codigo) query = query.eq('codigo_produto_fornecedor', codigo)
    else if (gtin) query = query.eq('gtin', gtin)
    else return res.status(400).json({ erro: 'Informe "codigo" ou "gtin"' })

    const { data, error } = await query.maybeSingle()
    if (error) throw error

    res.json({ encontrado: !!data, mapa: data || null })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// PATCH /api/nfe-entradas/:id/itens/:itemId — mapeia um item pro produto
// interno (de-para), com fator de conversão de unidade e lote/validade.
// Depois de mapear, aprende o de-para em produto_fornecedor_mapa pra não
// precisar mapear de novo na próxima compra do mesmo fornecedor.
router.patch('/:id/itens/:itemId', async (req, res) => {
  try {
    const { produto_id, fator_conversao = 1, lote, data_fabricacao, data_validade, localizacao_estoque } = req.body

    if (!produto_id) {
      return res.status(400).json({ erro: '"produto_id" é obrigatório para mapear o item' })
    }

    const { data: item, error: errItem } = await supabase
      .from('nfe_entrada_itens')
      .select('*')
      .eq('id', req.params.itemId)
      .eq('nfe_entrada_id', req.params.id)
      .single()

    if (errItem) throw errItem
    if (!item) return res.status(404).json({ erro: 'Item não encontrado nesta nota' })

    const quantidadeConvertida = Number(item.quantidade_fornecedor) * Number(fator_conversao)

    const { data: itemAtualizado, error } = await supabase
      .from('nfe_entrada_itens')
      .update({
        produto_id,
        fator_conversao,
        quantidade_convertida: quantidadeConvertida,
        mapeado: true,
        lote: lote || null,
        data_fabricacao: data_fabricacao || null,
        data_validade: data_validade || null,
        localizacao_estoque: localizacao_estoque || null,
      })
      .eq('id', req.params.itemId)
      .select()
      .single()

    if (error) throw error

    // Aprende o de-para pra próxima vez, se a nota já tem fornecedor vinculado
    const { data: nota } = await supabase.from('nfe_entradas').select('fornecedor_id').eq('id', req.params.id).single()
    if (nota?.fornecedor_id && (item.codigo_fornecedor || item.gtin)) {
      await supabase
        .from('produto_fornecedor_mapa')
        .upsert(
          {
            fornecedor_id: nota.fornecedor_id,
            codigo_produto_fornecedor: item.codigo_fornecedor || null,
            descricao_fornecedor: item.descricao_fornecedor,
            gtin: item.gtin || null,
            unidade_fornecedor: item.unidade_fornecedor,
            fator_conversao,
            produto_id,
            usuario_id: req.user?.id,
          },
          { onConflict: 'fornecedor_id,codigo_produto_fornecedor', ignoreDuplicates: false }
        )
    }

    // Recalcula status da nota
    const { data: todosItens } = await supabase.from('nfe_entrada_itens').select('mapeado').eq('nfe_entrada_id', req.params.id)
    const todosMapeados = (todosItens || []).every((i) => i.mapeado)

    if (todosMapeados && nota?.fornecedor_id) {
      await supabase.from('nfe_entradas').update({ status: 'pronta_para_entrada', atualizado_em: new Date().toISOString() }).eq('id', req.params.id)
    }

    res.json(itemAtualizado)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// POST /api/nfe-entradas/:id/confirmar — CONFIRMAR ENTRADA. Ação irreversível
// (baixa estoque + gera contas a pagar), por isso restrita a admin. Roda tudo
// numa única transação Postgres (fn_confirmar_nfe_entrada) — se algo falhar
// no meio, a função inteira é revertida (nada fica pela metade).
router.post('/:id/confirmar', adminOnly, async (req, res) => {
  try {
    const { parcelas } = req.body

    const { data, error } = await supabase.rpc('fn_confirmar_nfe_entrada', {
      p_nfe_entrada_id: req.params.id,
      p_usuario_id: req.user?.id,
      p_parcelas: parcelas || null,
    })

    if (error) throw error

    const { data: notaCompleta } = await supabase
      .from('nfe_entradas')
      .select('*, fornecedores(razao_social)')
      .eq('id', req.params.id)
      .single()

    res.json({ ...data, nota: notaCompleta })
  } catch (err) {
    res.status(400).json({ erro: err.message })
  }
})

// POST /api/nfe-entradas/:id/cancelar — cancela a nota. Se ainda não foi
// confirmada, é um cancelamento simples de status. Se já foi confirmada
// (estoque baixado, financeiro gerado), passa pelo estorno transacional
// completo — que é bloqueado se já existir parcela paga (aí precisa de
// ajuste manual do financeiro).
router.post('/:id/cancelar', adminOnly, async (req, res) => {
  try {
    const { motivo } = req.body
    if (!motivo) return res.status(400).json({ erro: '"motivo" do cancelamento é obrigatório' })

    const { data: nota, error: errNota } = await supabase
      .from('nfe_entradas')
      .select('*')
      .eq('id', req.params.id)
      .single()

    if (errNota) throw errNota
    if (!nota) return res.status(404).json({ erro: 'Nota de entrada não encontrada' })

    if (nota.status === 'confirmada') {
      const { data, error } = await supabase.rpc('fn_estornar_nfe_entrada_confirmada', {
        p_nfe_entrada_id: req.params.id,
        p_usuario_id: req.user?.id,
        p_motivo: motivo,
      })
      if (error) throw error
      return res.json(data)
    }

    const statusAnterior = nota.status
    const { data: notaCancelada, error } = await supabase
      .from('nfe_entradas')
      .update({ status: 'cancelada', cancelada_em: new Date().toISOString(), motivo_cancelamento: motivo })
      .eq('id', req.params.id)
      .select()
      .single()

    if (error) throw error

    await supabase.from('nfe_entrada_eventos').insert({
      nfe_entrada_id: req.params.id,
      tipo_evento: 'cancelamento',
      status_anterior: statusAnterior,
      status_novo: 'cancelada',
      usuario_id: req.user?.id,
      detalhes: { motivo },
    })

    res.json(notaCancelada)
  } catch (err) {
    res.status(400).json({ erro: err.message })
  }
})

export default router
