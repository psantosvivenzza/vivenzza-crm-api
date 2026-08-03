// Testes de integração do módulo NF-e contra o Supabase real (padrão já usado
// no módulo de Pedidos: dados sintéticos marcados "TESTE APAGAR", limpos no
// finally). Roda com `railway run --service vivenzza-crm-api node scripts/...`
// — precisa das env vars reais (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY).
//
// Cobre o que dá pra testar SEM certificado A1 real nem chamada à SEFAZ:
//   - criação de NF-e bloqueia CNPJ/CPF de destinatário inválido
//   - fluxo completo de Nota Interna (série 99): nunca gera chave/protocolo/XML
//     fiscal, gera comissão imediatamente, cancelamento estorna a comissão e
//     marca o pedido como 'cancelado'
//   - a trava de concorrência (compare-and-swap) usada em POST /:id/emitir:
//     duas atualizações simultâneas na mesma nota só deixam UMA vencer
//
// Fora de escopo aqui (precisam de certificado A1 + rede SEFAZ homologação,
// que não está disponível neste ambiente de teste): emissão real série 1,
// autorização/rejeição/denegação vindas da SEFAZ, reconciliação pós-timeout.
import express from 'express'
import { supabase } from '../src/lib/supabase-admin.server.js'
import nfeRouter from '../src/routes/nfe.js'

let falhas = 0
function check(nome, cond, detalhe) {
  if (cond) console.log(`OK — ${nome}`)
  else { falhas++; console.log(`FALHOU — ${nome}${detalhe ? ' — ' + JSON.stringify(detalhe) : ''}`) }
}

const criados = { pedidos: [], nfes: [] }

async function subirAppTeste(usuarioId) {
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.user = { id: usuarioId, role: 'admin' }; next() })
  app.use('/api/nfe', nfeRouter)
  return new Promise(resolve => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }))
  })
}

async function main() {
  const { data: vendedor, error: errVendedor } = await supabase
    .from('usuarios').select('id, nome').eq('role', 'vendedor').eq('ativo', true).limit(1).maybeSingle()
  if (errVendedor || !vendedor) throw new Error('Nenhum vendedor ativo encontrado — não dá pra testar comissão sem um.')
  console.log(`Usando vendedor real (apenas leitura, não é alterado): ${vendedor.nome} (${vendedor.id})`)

  const { server, port } = await subirAppTeste(vendedor.id)
  const base = `http://127.0.0.1:${port}/api/nfe`

  try {
    // --- Teste 1: CNPJ/CPF inválido bloqueia a criação da NF-e -------------
    const respCnpjInvalido = await fetch(base, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        serie: 99, dest_nome: 'TESTE APAGAR', dest_cnpj_cpf: '11111111111111',
        natureza_operacao: 'VENDA DE MERCADORIA',
        itens: [{ descricao: 'Item teste', quantidade: 1, valor_unitario: 10, valor_total: 10 }],
      }),
    })
    check('POST /api/nfe rejeita CNPJ inválido (400)', respCnpjInvalido.status === 400, await respCnpjInvalido.json().catch(() => null))

    // --- Setup do pedido sintético usado nos testes de nota interna -------
    const { data: pedido, error: errPedido } = await supabase
      .from('pedidos')
      .insert({
        status: 'confirmado',
        total: 500,
        vendedor_id: vendedor.id,
        vendedor_nome: vendedor.nome,
        valor_base_comissao: 500,
        status_fiscal: 'nao_faturado',
        cliente_nome_origem: 'TESTE APAGAR - Cliente Fiscal NFe',
        observacoes: 'TESTE APAGAR — gerado por scripts/teste-nfe-serie99-e-concorrencia.mjs',
      })
      .select().single()
    if (errPedido) throw errPedido
    criados.pedidos.push(pedido.id)

    // --- Teste 2: Nota Interna (série 99) nunca chama a SEFAZ --------------
    const respCriar = await fetch(base, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        serie: 99, pedido_id: pedido.id,
        dest_nome: 'TESTE APAGAR - Cliente Fiscal NFe',
        natureza_operacao: 'VENDA DE MERCADORIA',
        itens: [{ descricao: 'Item teste TESTE APAGAR', quantidade: 1, valor_unitario: 500, valor_total: 500 }],
      }),
    })
    const notaInterna = await respCriar.json()
    check('Nota interna criada com sucesso (201)', respCriar.status === 201, notaInterna)
    if (notaInterna?.id) criados.nfes.push(notaInterna.id)

    check('Nota interna nasce com status "emitida_interna"', notaInterna.status === 'emitida_interna', notaInterna.status)
    check('Nota interna NUNCA tem chave de acesso (não é documento fiscal)', notaInterna.chave === null || notaInterna.chave === undefined)
    check('Nota interna NUNCA tem protocolo (nunca foi à SEFAZ)', notaInterna.protocolo === null || notaInterna.protocolo === undefined)
    check('Nota interna NUNCA tem XML enviado/autorizado (nunca foi à SEFAZ)',
      !notaInterna.xml_enviado && !notaInterna.xml_autorizado)

    // Comissão deve ter sido gerada IMEDIATAMENTE (gatilho da série 99, sem
    // esperar autorização — não existe autorização nesse fluxo).
    const { data: comissaoGerada } = await supabase
      .from('comissoes').select('*').eq('nfe_id', notaInterna.id).eq('vendedor_id', vendedor.id).maybeSingle()
    check('Comissão foi gerada imediatamente para a nota interna', !!comissaoGerada, comissaoGerada)
    check('Comissão gerada está com status "disponivel"', comissaoGerada?.status === 'disponivel', comissaoGerada?.status)
    check('Valor base da comissão bate com valor_base_comissao do pedido', Number(comissaoGerada?.valor_base) === 500)

    // Idempotência: chamar gerarComissao de novo pra mesma nota não deve duplicar
    // (mesmo mecanismo usado se o job de reconciliação ou um retry chamasse de novo).
    const { gerarComissao } = await import('../src/lib/comissoes.js')
    await gerarComissao(notaInterna.id)
    const { data: comissoesAposRetry } = await supabase.from('comissoes').select('id').eq('nfe_id', notaInterna.id)
    check('Chamar gerarComissao de novo NÃO duplica a comissão (idempotente)', (comissoesAposRetry?.length ?? 0) === 1, comissoesAposRetry)

    // --- Teste 3: cancelamento da nota interna estorna a comissão ----------
    const respCancelar = await fetch(`${base}/${notaInterna.id}/cancelar`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ justificativa: 'TESTE APAGAR — cancelamento automatizado do teste' }),
    })
    const retornoCancelar = await respCancelar.json()
    check('Cancelamento da nota interna retorna cancelado:true', retornoCancelar.cancelado === true, retornoCancelar)

    const { data: nfeAposCancelar } = await supabase.from('nfe').select('status').eq('id', notaInterna.id).single()
    check('Status vira "cancelada_interna" após cancelamento', nfeAposCancelar.status === 'cancelada_interna', nfeAposCancelar.status)

    const { data: comissaoAposCancelar } = await supabase.from('comissoes').select('status').eq('nfe_id', notaInterna.id).single()
    check('Comissão foi estornada (nunca deletada) após cancelamento', comissaoAposCancelar.status === 'estornada', comissaoAposCancelar.status)

    const { data: pedidoAposCancelar } = await supabase.from('pedidos').select('status_fiscal').eq('id', pedido.id).single()
    check('pedidos.status_fiscal vira "cancelado" após cancelamento da nota interna', pedidoAposCancelar.status_fiscal === 'cancelado', pedidoAposCancelar.status_fiscal)

    // Não pode cancelar de novo uma nota já cancelada.
    const respCancelarDeNovo = await fetch(`${base}/${notaInterna.id}/cancelar`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ justificativa: 'TESTE APAGAR — segunda tentativa, deve falhar' }),
    })
    check('Cancelar uma nota interna JÁ cancelada é bloqueado (400)', respCancelarDeNovo.status === 400)

    // --- Teste 4: trava de concorrência (compare-and-swap) ------------------
    // Simula exatamente o UPDATE usado em POST /:id/emitir (nfe.js:285-291),
    // sem precisar de certificado/SEFAZ: cria uma NF-e sintética série 1 em
    // 'rascunho' e dispara duas atualizações concorrentes pro mesmo status alvo.
    const { data: nfeConcorrencia, error: errNfeConc } = await supabase
      .from('nfe')
      .insert({
        tipo: 'nfe', serie: 1, tipo_documento: 'nfe_sefaz', status: 'rascunho',
        natureza_operacao: 'VENDA DE MERCADORIA', finalidade: 1, forma_pagamento: '01',
        dest_nome: 'TESTE APAGAR - Concorrência', valor_produtos: 100, valor_total: 100,
        observacoes: 'TESTE APAGAR — usada só para testar a trava de concorrência, nunca emitida de verdade',
      })
      .select().single()
    if (errNfeConc) throw errNfeConc
    criados.nfes.push(nfeConcorrencia.id)

    // Mesmo UPDATE usado de fato em POST /:id/emitir (nfe.js:285-291), agora com
    // fidelidade total (enviada_em já existe depois da migration nfe_colunas_reconciliacao.sql).
    const casUpdate = () => supabase
      .from('nfe')
      .update({ status: 'enviada', enviada_em: new Date().toISOString() })
      .eq('id', nfeConcorrencia.id)
      .eq('status', 'rascunho')
      .select('id')
      .maybeSingle()

    const [resultadoA, resultadoB] = await Promise.all([casUpdate(), casUpdate()])
    const vitoriosos = [resultadoA, resultadoB].filter(r => r.data).length
    check('Exatamente UMA das duas atualizações concorrentes vence a corrida (compare-and-swap)', vitoriosos === 1, { a: resultadoA.data, b: resultadoB.data })

    const { data: nfeConcorrenciaFinal } = await supabase.from('nfe').select('status, enviada_em').eq('id', nfeConcorrencia.id).single()
    check('Status final é "enviada" uma única vez (sem número/chave duplicados)', nfeConcorrenciaFinal.status === 'enviada')
    check('enviada_em foi gravado (coluna nova da migration de reconciliação)', !!nfeConcorrenciaFinal.enviada_em)

    // --- Teste 5: log de auditoria append-only (nfe_eventos) ----------------
    // Agora que a tabela existe, confirma que os eventos de criação/cancelamento
    // do teste 2-3 realmente ficaram registrados (antes só falhavam silenciosamente,
    // por design — registrarEvento nunca derruba a operação fiscal).
    const { data: eventosNotaInterna } = await supabase
      .from('nfe_eventos').select('tipo_evento, status_anterior, status_novo').eq('nfe_id', notaInterna.id).order('criado_em')
    const tipos = (eventosNotaInterna || []).map(e => e.tipo_evento)
    check('nfe_eventos registrou "criacao" para a nota interna', tipos.includes('criacao'), tipos)
    check('nfe_eventos registrou "cancelamento" para a nota interna', tipos.includes('cancelamento'), tipos)
    check('nfe_eventos registrou "estorno_comissao" para a nota interna', tipos.includes('estorno_comissao'), tipos)

    // Append-only de verdade: UPDATE/DELETE direto devem ser rejeitados pelo
    // próprio banco (REVOKE da migration), não só por convenção da aplicação.
    const { error: erroUpdateEvento } = await supabase
      .from('nfe_eventos').update({ motivo: 'tentativa de alterar histórico' }).eq('nfe_id', notaInterna.id)
    check('UPDATE direto em nfe_eventos é rejeitado pelo banco (append-only real)', !!erroUpdateEvento, erroUpdateEvento?.message)
  } finally {
    server.close()
    for (const id of criados.nfes) {
      await supabase.from('nfe_itens').delete().eq('nfe_id', id)
      await supabase.from('comissoes').delete().eq('nfe_id', id)
      await supabase.from('nfe').delete().eq('id', id)
    }
    for (const id of criados.pedidos) {
      await supabase.from('pedidos').delete().eq('id', id)
    }
    console.log('\nLimpeza concluída — dados sintéticos removidos.')
  }
}

main()
  .then(() => {
    console.log(`\n${falhas === 0 ? 'TODOS OS TESTES PASSARAM' : `${falhas} TESTE(S) FALHARAM`}`)
    process.exit(falhas === 0 ? 0 : 1)
  })
  .catch(err => {
    console.error('ERRO FATAL NO TESTE:', err)
    process.exit(1)
  })
