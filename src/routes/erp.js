import { Router } from 'express'
import { supabase } from '../lib/supabase-admin.server.js'
import { buscarCidadesAtendimento, liberarCidades, definirCidadesAtendimento } from '../lib/territorios.js'

const router = Router()

// Datas de corte "sem comprar há Xd" — calculadas no momento da requisição,
// nunca hardcoded como valor de data.
function diasAtras(dias) {
  const d = new Date()
  d.setDate(d.getDate() - Number(dias))
  return d.toISOString().slice(0, 10)
}

// Sanitiza um valor antes de interpolar numa string de filtro .or() do
// PostgREST — remove vírgula/ponto/parênteses (caracteres que quebrariam o
// parser de filtro) pra nunca montar uma condição a partir de valor não
// confiável vindo de query string.
function sanitizarValorFiltro(v) {
  return String(v).replace(/[,.()]/g, '')
}

// GET /api/admin/erp/clientes — filtros rápidos (Fase 1): pesquisa geral
// (normalizada via função clientes_erp_busca — nome/fantasia/CNPJ-CPF/
// telefone/celular/email/código, com ou sem máscara), estado, cidade
// (múltiplas), vendedor responsável (por usuario_id ou "sem vendedor"),
// situação (ativo/inativo) e última compra (nunca comprou / dias sem
// comprar). Todas as opções de filtro vêm de dados reais — ver
// GET /clientes/filtros-opcoes.
router.get('/clientes', async (req, res) => {
  try {
    const {
      q, estado, cidade, vendedor_usuario_id, sem_vendedor, situacao,
      nunca_comprou, dias_sem_comprar,
      page = 1, limit = 50,
    } = req.query
    const offset = (Number(page) - 1) * Number(limit)

    let query = supabase
      .from('clientes_erp')
      .select('id, legacy_id, tipo, razao_social, nome_fantasia, cnpj_cpf, ie, data_cadastro, ativo, em_revisao, endereco, data_ultima_compra, vendedor_responsavel_usuario_id, vendedor_responsavel, usuarios:vendedor_responsavel_usuario_id(nome, ativo)', { count: 'exact' })
      .order('razao_social')
      .range(offset, offset + Number(limit) - 1)

    if (q) {
      // A coluna CÓDIGO da própria tela mostra o código como "#001286" — é
      // natural o usuário copiar/digitar com o "#". `legacy_id` no banco
      // nunca tem esse caractere, então "#001286" não batia com nada (achado
      // real, 2026-10-01: Quais buscou e não encontrou). Remove um "#" no
      // início do termo antes de mandar pra busca.
      const termoBusca = String(q).trim().replace(/^#/, '')
      const { data: idsBusca, error: erroBusca } = await supabase.rpc('clientes_erp_busca', { termo: termoBusca })
      if (erroBusca) throw erroBusca
      const ids = (idsBusca || []).map((r) => r.id)
      // Sem resultado nenhum: força um IN vazio pra retornar lista vazia em
      // vez de ignorar o filtro (comportamento correto de busca sem match).
      query = query.in('id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000'])
    }

    // Estado/cidade: multi-seleção real via jsonb ->> , nunca lista fixa.
    // "__sem_endereco__" pode vir combinado com UFs reais no mesmo filtro
    // (multi-seleção) — nesse caso o OR precisa cobrir as duas condições,
    // não só uma ou outra.
    if (estado) {
      const estados = String(estado).split(',').filter(Boolean)
      const semEndereco = estados.includes('__sem_endereco__')
      const ufsReais = estados.filter(uf => uf !== '__sem_endereco__').map(sanitizarValorFiltro).filter(Boolean)
      if (semEndereco && ufsReais.length) {
        const condicoesUf = ufsReais.map(uf => `endereco->>estado.eq.${uf}`).join(',')
        query = query.or(`endereco->>estado.is.null,endereco->>estado.eq.,${condicoesUf}`)
      } else if (semEndereco) {
        query = query.or(`endereco->>estado.is.null,endereco->>estado.eq.`)
      } else if (ufsReais.length) {
        query = query.in('endereco->>estado', ufsReais)
      }
    }
    if (cidade) {
      const cidades = String(cidade).split(',').filter(Boolean)
      query = query.in('endereco->>cidade', cidades)
    }

    if (sem_vendedor === 'true') {
      query = query.is('vendedor_responsavel_usuario_id', null)
    } else if (vendedor_usuario_id) {
      query = query.eq('vendedor_responsavel_usuario_id', vendedor_usuario_id)
    }

    if (situacao === 'ativo') query = query.eq('ativo', true)
    if (situacao === 'inativo') query = query.eq('ativo', false)

    if (nunca_comprou === 'true') {
      query = query.is('data_ultima_compra', null)
    } else if (dias_sem_comprar) {
      query = query.not('data_ultima_compra', 'is', null).lte('data_ultima_compra', diasAtras(dias_sem_comprar))
    }

    const { data, error, count } = await query
    if (error) throw error
    res.json({ data, total: count, page: Number(page), limit: Number(limit) })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/admin/erp/clientes/filtros-opcoes — opções reais pros filtros
// rápidos (estado, cidade, vendedor), derivadas dos dados de clientes_erp e
// usuarios. Nunca lista fixa — se um estado/cidade some da base, some daqui
// também na próxima chamada.
router.get('/clientes/filtros-opcoes', async (req, res) => {
  try {
    const [{ data: enderecos, error: erroEnd }, { data: idsVendedorCliente, error: erroIds }] = await Promise.all([
      supabase.from('clientes_erp').select('endereco'),
      supabase.from('clientes_erp').select('vendedor_responsavel_usuario_id').not('vendedor_responsavel_usuario_id', 'is', null),
    ])
    if (erroEnd) throw erroEnd
    if (erroIds) throw erroIds

    // disponivel_como_vendedor=true sozinho esconde vendedor inativo/legado do
    // filtro (ex-funcionário, distribuidor antigo) mesmo quando ele ainda é o
    // responsável histórico de clientes reais — sem aparecer aqui, não dá pra
    // filtrar "clientes da Fulana" pra saber quem reatribuir. Inclui também
    // quem já é vendedor_responsavel_usuario_id de algum cliente, ativo ou não.
    // A trava de segurança (não pode REATRIBUIR cliente pra vendedor inelegível)
    // continua só em disponivel_como_vendedor, na rota PUT /clientes/:id/vendedor —
    // isso aqui é só visibilidade pra filtro/consulta, nunca vira alvo de troca.
    const idsComClientes = [...new Set((idsVendedorCliente || []).map((r) => r.vendedor_responsavel_usuario_id))]
    const filtroVendedores = idsComClientes.length
      ? `disponivel_como_vendedor.eq.true,id.in.(${idsComClientes.join(',')})`
      : 'disponivel_como_vendedor.eq.true'
    const { data: vendedores, error: erroVend } = await supabase
      .from('usuarios')
      .select('id, nome, ativo')
      .or(filtroVendedores)
      .order('nome')
    if (erroVend) throw erroVend

    const estados = new Set()
    const cidadesPorEstado = {}
    let semEndereco = 0
    for (const c of enderecos || []) {
      const uf = c.endereco?.estado
      const cidade = c.endereco?.cidade
      if (!uf && !cidade) { semEndereco++; continue }
      if (uf) {
        estados.add(uf)
        if (cidade) {
          cidadesPorEstado[uf] = cidadesPorEstado[uf] || new Set()
          cidadesPorEstado[uf].add(cidade)
        }
      }
    }

    res.json({
      estados: [...estados].sort(),
      cidades_por_estado: Object.fromEntries(
        Object.entries(cidadesPorEstado).map(([uf, set]) => [uf, [...set].sort()])
      ),
      clientes_sem_endereco: semEndereco,
      vendedores: vendedores || [],
    })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/admin/erp/clientes/:id/pedidos-abertos — contagem de pedidos em
// aberto (rascunho/confirmado) do cliente, usada como aviso antes de trocar o
// vendedor responsável (spec: "mostrar quantidade de pedidos abertos do
// cliente como aviso"). Distribuição de status confirmada em produção:
// faturado 8699, rascunho 395, confirmado 54, cancelado 3 — "aberto" =
// rascunho + confirmado (ainda não faturado, ainda não cancelado).
router.get('/clientes/:id/pedidos-abertos', async (req, res) => {
  try {
    const { count, error } = await supabase
      .from('pedidos')
      .select('id', { count: 'exact', head: true })
      .eq('cliente_erp_id', req.params.id)
      .in('status', ['rascunho', 'confirmado'])
    if (error) throw error
    res.json({ pedidos_abertos: count || 0 })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/admin/erp/clientes/:id/historico-vendedor — histórico de trocas de
// vendedor responsável do cliente (nunca sobrescrito, só inserido).
router.get('/clientes/:id/historico-vendedor', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('clientes_vendedor_historico')
      .select(`
        id, motivo, origem, criado_em,
        vendedor_anterior:vendedor_anterior_id(id, nome),
        vendedor_novo:vendedor_novo_id(id, nome),
        usuario_alterou:usuario_alterou_id(id, nome)
      `)
      .eq('cliente_erp_id', req.params.id)
      .order('criado_em', { ascending: false })
    if (error) throw error
    res.json(data || [])
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// PUT /api/admin/erp/clientes/:id/vendedor — troca do vendedor responsável
// atual do cliente. Regra de negócio (spec do Peterson): vale só daqui pra
// frente — NUNCA toca pedidos existentes, NF-e emitidas, comissões ou contas
// financeiras já lançadas. O vendedor gravado em `pedidos.vendedor_id` (e o
// snapshot em `comissoes.vendedor_nome_snapshot`) é histórico e permanente,
// independente do que este endpoint muda aqui. Exige motivo. Rota já protegida
// por adminOnly no mount (index.js: app.use('/api/admin/erp', auth, adminOnly, ...)).
router.put('/clientes/:id/vendedor', async (req, res) => {
  try {
    const { vendedor_novo_id, motivo, origem = 'individual' } = req.body

    if (!motivo || !String(motivo).trim()) {
      return res.status(400).json({ erro: 'motivo é obrigatório' })
    }
    const origensValidas = ['individual', 'lote', 'importacao', 'integracao', 'processo_administrativo']
    if (!origensValidas.includes(origem)) {
      return res.status(400).json({ erro: `origem inválida — use um de: ${origensValidas.join(', ')}` })
    }

    // vendedor_novo_id é opcional (permite "Sem representante"), mas se vier,
    // precisa ser um usuário real disponível como vendedor — nunca aceita
    // qualquer usuário (ex.: um admin sem essa flag) sem checar antes.
    if (vendedor_novo_id) {
      const { data: usuarioNovo, error: erroUsuarioNovo } = await supabase
        .from('usuarios')
        .select('id, nome, ativo, disponivel_como_vendedor')
        .eq('id', vendedor_novo_id)
        .maybeSingle()
      if (erroUsuarioNovo) throw erroUsuarioNovo
      if (!usuarioNovo || !usuarioNovo.disponivel_como_vendedor) {
        return res.status(400).json({ erro: 'vendedor_novo_id não corresponde a um vendedor válido' })
      }
    }

    const { data: clienteAtual, error: erroCliente } = await supabase
      .from('clientes_erp')
      .select('id, vendedor_responsavel_usuario_id')
      .eq('id', req.params.id)
      .maybeSingle()
    if (erroCliente) throw erroCliente
    if (!clienteAtual) return res.status(404).json({ erro: 'Cliente não encontrado' })

    const vendedorAnteriorId = clienteAtual.vendedor_responsavel_usuario_id || null
    const vendedorNovoId = vendedor_novo_id || null

    // Sem mudança real: não grava histórico nem faz update à toa.
    if (vendedorAnteriorId === vendedorNovoId) {
      return res.json({ alterado: false, mensagem: 'Vendedor responsável já é este — nenhuma alteração feita.' })
    }

    // Atualiza SOMENTE clientes_erp.vendedor_responsavel_usuario_id — nunca
    // toca pedidos/comissoes/contas_financeiras, por regra explícita.
    const { data: clienteAtualizado, error: erroUpdate } = await supabase
      .from('clientes_erp')
      .update({ vendedor_responsavel_usuario_id: vendedorNovoId })
      .eq('id', req.params.id)
      .select('id, vendedor_responsavel_usuario_id')
      .single()
    if (erroUpdate) throw erroUpdate

    const { error: erroHistorico } = await supabase
      .from('clientes_vendedor_historico')
      .insert({
        cliente_erp_id: req.params.id,
        vendedor_anterior_id: vendedorAnteriorId,
        vendedor_novo_id: vendedorNovoId,
        usuario_alterou_id: req.user?.id !== 'api-user' ? req.user?.id : null,
        motivo: String(motivo).trim(),
        origem,
      })
    if (erroHistorico) throw erroHistorico

    res.json({ alterado: true, cliente: clienteAtualizado })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/admin/erp/clientes/:id — detalhe + histórico de vendas
//
// Unificação de cadastro CRM/ERP (2026-10-01): classificação comercial e
// território de distribuidor vivem só no lead vinculado
// (`leads.cliente_erp_id`), que desde o backfill de 2026-10-01 existe pra
// todo clientes_erp — nunca um campo duplicado em clientes_erp. Esta rota
// devolve `lead_vinculado` (id + tipo) pro frontend exibir/editar esse dado
// aqui mesmo (ver PUT /clientes/:id/classificacao) sem duplicar a coluna.
router.get('/clientes/:id', async (req, res) => {
  try {
    const [clienteRes, vendasRes] = await Promise.all([
      // Embute nome/situação do vendedor responsável atual (join por FK) —
      // o frontend precisa disso pra exibir o nome e avisar se está inativo,
      // sem ter que fazer uma segunda chamada.
      supabase.from('clientes_erp').select('*, vendedor_responsavel_atual:vendedor_responsavel_usuario_id(id, nome, ativo)').eq('id', req.params.id).single(),
      supabase
        .from('vendas_legado')
        .select('id, numero_nf, serie, data_emissao, valor_total, status')
        .eq('cliente_erp_id', req.params.id)
        .order('data_emissao', { ascending: false })
        .limit(30),
    ])
    if (clienteRes.error) throw clienteRes.error

    const { data: lead } = clienteRes.data?.legacy_id
      ? await supabase.from('leads').select('id, tipo, ativo').eq('cliente_erp_id', clienteRes.data.legacy_id).maybeSingle()
      : { data: null }

    const cidadesAtendimento = lead?.tipo === 'distribuidor'
      ? await buscarCidadesAtendimento({ leadId: lead.id })
      : []

    res.json({ cliente: clienteRes.data, vendas: vendasRes.data || [], lead_vinculado: lead || null, cidades_atendimento: cidadesAtendimento })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// PUT /api/admin/erp/clientes/:id — edição de cadastro (dados fiscais/
// contato/endereço). Classificação comercial e cidades de atendimento
// continuam fora daqui, de propósito — ver PUT /clientes/:id/classificacao,
// que escreve no MESMO lead vinculado (nunca um campo duplicado em
// clientes_erp). `classificacao_comercial` no corpo é ignorado (não quebra
// clientes antigos do frontend em cache durante o deploy).
router.put('/clientes/:id', async (req, res) => {
  try {
    const {
      razao_social, nome_fantasia, cnpj_cpf, ie,
      telefone, celular, email,
      logradouro, numero, complemento, bairro, cidade, estado, cep, pais,
      observacoes, ativo,
    } = req.body

    if (!razao_social) return res.status(400).json({ erro: 'razao_social é obrigatório' })

    // contatos/endereco são JSONB — o form manda o estado completo, então
    // reconstrói os dois objetos inteiros em vez de fazer merge parcial.
    const contatos = [
      telefone && { tipo: 'telefone', valor: telefone },
      celular && { tipo: 'celular', valor: celular },
      email && { tipo: 'email', valor: email },
    ].filter(Boolean)

    const endereco = {
      logradouro: logradouro || null,
      numero: numero || null,
      complemento: complemento || null,
      bairro: bairro || null,
      cidade: cidade || null,
      estado: estado || null,
      cep: cep || null,
      pais: pais || null,
    }

    const { data, error } = await supabase
      .from('clientes_erp')
      .update({ razao_social, nome_fantasia, cnpj_cpf, ie, contatos, endereco, observacoes, ativo })
      .eq('id', req.params.id)
      .select()
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ erro: 'Cliente não encontrado' })

    const { data: lead } = data.legacy_id
      ? await supabase.from('leads').select('id, tipo').eq('cliente_erp_id', data.legacy_id).maybeSingle()
      : { data: null }
    const cidadesAtendimentoSalvas = lead?.tipo === 'distribuidor'
      ? await buscarCidadesAtendimento({ leadId: lead.id })
      : []

    res.json({ ...data, lead_vinculado: lead || null, cidades_atendimento: cidadesAtendimentoSalvas })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// PUT /api/admin/erp/clientes/:id/classificacao — edita classificação (tipo)
// e território (cidades de atendimento) direto da tela do ERP.
//
// Segunda ponta de entrada pro MESMO dado do PUT /api/leads/:id (mirror
// proposital da lógica lá) — acha o lead vinculado via
// clientes_erp.legacy_id = leads.cliente_erp_id e escreve nele. Não cria um
// campo novo em clientes_erp: é o pedido do Quais de 2026-10-01 ("não
// podemos ter dois cadastros em locais diferentes" é sobre o DADO, não
// sobre a TELA — editar daqui ou do Pipeline grava o mesmo registro).
router.put('/clientes/:id/classificacao', async (req, res) => {
  try {
    const { tipo, cidades_atendimento } = req.body

    const { data: cliente, error: erroCliente } = await supabase
      .from('clientes_erp')
      .select('id, legacy_id')
      .eq('id', req.params.id)
      .maybeSingle()
    if (erroCliente) throw erroCliente
    if (!cliente) return res.status(404).json({ erro: 'Cliente não encontrado' })
    if (!cliente.legacy_id) return res.status(400).json({ erro: 'Cliente sem código legado — não é possível localizar o lead vinculado' })

    const { data: lead, error: erroLead } = await supabase
      .from('leads')
      .select('id, tipo, ativo')
      .eq('cliente_erp_id', cliente.legacy_id)
      .maybeSingle()
    if (erroLead) throw erroLead
    if (!lead) return res.status(404).json({ erro: 'Lead vinculado não encontrado — contate o suporte' })

    const tipoAnterior = lead.tipo
    const tipoNovo = tipo !== undefined ? (tipo || null) : tipoAnterior

    if (tipo !== undefined && tipoNovo !== tipoAnterior) {
      const { error: erroUpdateLead } = await supabase
        .from('leads')
        .update({ tipo: tipoNovo, updated_at: new Date().toISOString() })
        .eq('id', lead.id)
      if (erroUpdateLead) throw erroUpdateLead
    }

    // Deixou de ser distribuidor agora: libera o território automaticamente
    // (mesma regra do PUT /api/leads/:id).
    if (tipoAnterior === 'distribuidor' && tipoNovo !== 'distribuidor') {
      await liberarCidades({ leadId: lead.id })
    }

    let cidadesAtendimentoFinal
    if (tipoNovo === 'distribuidor') {
      if (Array.isArray(cidades_atendimento)) {
        try {
          cidadesAtendimentoFinal = await definirCidadesAtendimento({ leadId: lead.id }, cidades_atendimento)
        } catch (err) {
          if (err.code === 'TERRITORIO_OCUPADO') return res.status(409).json({ erro: err.message })
          throw err
        }
      } else {
        cidadesAtendimentoFinal = await buscarCidadesAtendimento({ leadId: lead.id })
      }
    } else {
      cidadesAtendimentoFinal = []
    }

    res.json({
      lead_vinculado: { id: lead.id, tipo: tipoNovo, ativo: lead.ativo },
      cidades_atendimento: cidadesAtendimentoFinal,
    })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/admin/erp/notas-legado — histórico unificado de duas fontes legadas:
// vendas_legado (série 99 — notas internas, migração validada) e nfe.serie=1
// (série "E" do NetVision — NF-e SEFAZ reais, legacy_id termina em "-E"). As
// demais séries em `nfe` (0,2,3,5,10,33,55,890) são artefato de importação sem
// cliente real vinculado e ficam de fora — ver notas_legado_unificado_view.sql.
router.get('/notas-legado', async (req, res) => {
  try {
    const { q, data_inicio, data_fim, status, serie, page = 1, limit = 50 } = req.query
    const offset = (Number(page) - 1) * Number(limit)
    let query = supabase
      .from('notas_legado_unificado')
      .select('id, origem, numero, serie, serie_label, data_emissao, valor_total, status, em_revisao, cliente_nome, cliente_cnpj, cliente_legacy_id', { count: 'exact' })
      .order('data_emissao', { ascending: false })
      .range(offset, offset + Number(limit) - 1)

    if (data_inicio) query = query.gte('data_emissao', data_inicio)
    if (data_fim) query = query.lte('data_emissao', data_fim)
    if (status) query = query.eq('status', status)
    // Trata qualquer valor "vazio" (string vazia, 'todas', 'null', 'undefined') como
    // "sem filtro" — mesma defesa já usada nos outros filtros de série do sistema.
    const serieValida = serie && !['todas', 'null', 'undefined'].includes(String(serie).toLowerCase())
    if (serieValida) query = query.eq('serie', serie)
    if (q) query = query.ilike('numero', `%${q}%`)

    const { data, error, count } = await query
    if (error) throw error
    res.json({ data, total: count, page: Number(page), limit: Number(limit) })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/admin/erp/notas-legado/:id — detalhe normalizado, funciona pras duas
// origens (tenta vendas_legado primeiro, depois nfe serie=1) sem o frontend
// precisar saber de qual tabela veio.
router.get('/notas-legado/:id', async (req, res) => {
  try {
    const { data: viaVendas, error: errV } = await supabase
      .from('vendas_legado')
      .select('*, clientes_erp(legacy_id, razao_social, cnpj_cpf, ie, endereco)')
      .eq('id', req.params.id)
      .maybeSingle()
    if (errV) throw errV

    if (viaVendas) {
      // itens é jsonb com chaves compactas (c/q/u/vd/vt/vu) — sem nome de produto,
      // só o código legado (limitação da fonte, não do backend).
      const itens = (viaVendas.itens || []).map(it => ({
        codigo: it.c,
        descricao: it.c,
        ncm: null,
        quantidade: it.q,
        valor_unitario: it.vu,
        valor_desconto: it.vd,
        valor_total: it.vt,
      }))
      return res.json({
        origem: 'vendas_legado',
        serie: '99',
        serie_label: 'Interna',
        numero_nf: viaVendas.numero_nf,
        modelo: viaVendas.modelo,
        data_emissao: viaVendas.data_emissao,
        natureza_operacao: viaVendas.natureza_operacao,
        status: viaVendas.status,
        em_revisao: viaVendas.em_revisao,
        valor_produtos: viaVendas.valor_produtos,
        valor_desconto: viaVendas.valor_desconto,
        valor_total: viaVendas.valor_total,
        clientes_erp: viaVendas.clientes_erp,
        itens,
      })
    }

    const { data: viaNfe, error: errN } = await supabase
      .from('nfe')
      .select('*, nfe_itens(*)')
      .eq('id', req.params.id)
      .eq('serie', 1)
      .maybeSingle()
    if (errN) throw errN
    if (!viaNfe) return res.status(404).json({ erro: 'Nota não encontrada' })

    const itens = (viaNfe.nfe_itens || [])
      .sort((a, b) => (a.numero_item || 0) - (b.numero_item || 0))
      .map(it => ({
        codigo: it.codigo,
        descricao: it.descricao,
        ncm: it.ncm,
        quantidade: it.quantidade,
        valor_unitario: it.valor_unitario,
        valor_desconto: it.valor_desconto,
        valor_total: it.valor_total,
      }))

    res.json({
      origem: 'nfe',
      serie: 'E',
      serie_label: 'NF-e SEFAZ',
      numero_nf: String(viaNfe.numero),
      modelo: '55',
      data_emissao: viaNfe.data_emissao,
      natureza_operacao: viaNfe.natureza_operacao,
      status: viaNfe.status,
      em_revisao: false,
      valor_produtos: viaNfe.valor_produtos,
      valor_desconto: viaNfe.valor_desconto,
      valor_total: viaNfe.valor_total,
      clientes_erp: { razao_social: viaNfe.dest_nome, cnpj_cpf: viaNfe.dest_cnpj_cpf, ie: viaNfe.dest_ie, endereco: null },
      itens,
    })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/admin/erp/financeiro — contas + totais
router.get('/financeiro', async (req, res) => {
  try {
    const { tipo, status, em_revisao, page = 1, limit = 100 } = req.query
    const offset = (Number(page) - 1) * Number(limit)
    let query = supabase
      .from('contas_financeiras')
      .select('*', { count: 'exact' })
      .order('vencimento')
      .range(offset, offset + Number(limit) - 1)
    if (tipo) query = query.eq('tipo', tipo)
    if (status) query = query.eq('status', status)
    if (em_revisao === 'true') query = query.eq('em_revisao', true)

    const [listRes, allRes] = await Promise.all([
      query,
      supabase.from('contas_financeiras').select('tipo, status, valor, vencimento, em_revisao'),
    ])
    if (listRes.error) throw listRes.error

    const contas = allRes.data || []
    const isAberta = s => ['aberta', 'aberto'].includes(s)
    const isVencida = s => ['vencida', 'vencido'].includes(s)
    const totais = {
      a_receber: contas.filter(c => c.tipo === 'receber' && isAberta(c.status)).reduce((s, c) => s + Number(c.valor || 0), 0),
      a_pagar:   contas.filter(c => c.tipo === 'pagar'   && isAberta(c.status)).reduce((s, c) => s + Number(c.valor || 0), 0),
      vencidos:  contas.filter(c => isVencida(c.status)).reduce((s, c) => s + Number(c.valor || 0), 0),
      em_revisao: contas.filter(c => c.em_revisao).length,
    }
    res.json({ data: listRes.data, total: listRes.count, page: Number(page), limit: Number(limit), totais })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/admin/erp/estoque — saldos com info do produto
router.get('/estoque', async (req, res) => {
  try {
    const { page = 1, limit = 100 } = req.query
    const offset = (Number(page) - 1) * Number(limit)
    const { data, error, count } = await supabase
      .from('estoque')
      .select('*, produtos(id, nome, sku, unidade, ncm, legacy_id)', { count: 'exact' })
      .order('quantidade')
      .range(offset, offset + Number(limit) - 1)
    if (error) throw error
    res.json({ data: data || [], total: count, page: Number(page), limit: Number(limit) })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

export default router
