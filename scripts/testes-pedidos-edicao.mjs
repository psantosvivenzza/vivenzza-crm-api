// Testes 9 e 11 dos 12 obrigatórios: histórico de edição e bloqueio de edição
// de pedido faturado/NFe autorizada. Sobe um Express local com o router real
// de pedidos.js, injeta req.user fake — mesma técnica usada nos testes de
// estorno financeiro. Dados sintéticos criados e apagados em finally.
import express from 'express'
import { supabase } from '../src/lib/supabase.js'
import pedidosRouter from '../src/routes/pedidos.js'

let falhas = 0
function check(nome, condicao, detalhe) {
  if (condicao) console.log(`OK — ${nome}`)
  else { falhas++; console.log(`FALHOU — ${nome}${detalhe ? ' — ' + detalhe : ''}`) }
}

function subirApp(usuarioFake) {
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.user = usuarioFake; next() })
  app.use('/api/pedidos', pedidosRouter)
  return new Promise(resolve => {
    const server = app.listen(0, () => resolve({ server, porta: server.address().port }))
  })
}

async function main() {
  const admin = { id: null, role: 'admin' }
  const { data: usuarioAdmin } = await supabase.from('usuarios').select('id').eq('role', 'admin').limit(1).single()
  admin.id = usuarioAdmin.id

  const { server, porta } = await subirApp(admin)
  const base = `http://127.0.0.1:${porta}/api/pedidos`
  let pedidoId, pedidoFaturadoId

  try {
    // Produto qualquer existente pra montar item válido
    const { data: produto } = await supabase.from('produtos').select('id, preco_b2c').limit(1).single()
    const { data: cliente } = await supabase.from('clientes_erp').select('id').limit(1).single()

    // ── Teste 9: edição local gera histórico ──────────────────────────────
    console.log('\n=== Teste 9: edição de pedido gera entrada em pedido_historico ===')
    const criar = await fetch(base, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cliente_erp_id: cliente.id, observacoes: 'TESTE PEDIDO EDICAO - APAGAR',
        itens: [{ produto_id: produto.id, quantidade: 2, preco_unitario: 10 }],
      }),
    })
    const pedidoCriado = await criar.json()
    pedidoId = pedidoCriado.id
    check('pedido de teste criado com sucesso', criar.status === 201, JSON.stringify(pedidoCriado))

    const editar = await fetch(`${base}/${pedidoId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ observacoes: 'TESTE PEDIDO EDICAO - EDITADO - APAGAR', desconto: 5 }),
    })
    const pedidoEditado = await editar.json()
    check('edição retornou 200', editar.status === 200, JSON.stringify(pedidoEditado))
    check('observação foi atualizada', pedidoEditado.observacoes === 'TESTE PEDIDO EDICAO - EDITADO - APAGAR')
    check('total foi recalculado no servidor (subtotal 20 - desconto 5 = 15)', Number(pedidoEditado.total) === 15)

    const { data: historico } = await supabase.from('pedido_historico').select('*').eq('pedido_id', pedidoId).order('criado_em')
    check('gerou entrada de histórico para "observacoes"', historico.some(h => h.campo === 'observacoes' && h.valor_novo === 'TESTE PEDIDO EDICAO - EDITADO - APAGAR'))
    check('gerou entrada de histórico para "desconto"', historico.some(h => h.campo === 'desconto' && h.valor_novo === '5'))
    check('gerou entrada de histórico para "total" (recalculado)', historico.some(h => h.campo === 'total'))
    check('histórico registra a origem "local"', historico.every(h => h.origem === 'local'))
    check('histórico registra o usuário responsável', historico.every(h => h.usuario_id === admin.id))

    check('quantidade zero é rejeitada (validação de item)', (await (async () => {
      const r = await fetch(`${base}/${pedidoId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itens: [{ produto_id: produto.id, quantidade: 0, preco_unitario: 10 }] }),
      })
      return r.status === 400
    })()))

    // ── Teste 11: pedido faturado bloqueia edição de itens/valores/cliente ──
    console.log('\n=== Teste 11: pedido faturado/NFe autorizada bloqueia edição de itens, valores e cliente ===')
    const criarFaturado = await fetch(base, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cliente_erp_id: cliente.id, observacoes: 'TESTE PEDIDO FATURADO - APAGAR',
        itens: [{ produto_id: produto.id, quantidade: 1, preco_unitario: 50 }],
      }),
    })
    const pedidoFaturado = await criarFaturado.json()
    pedidoFaturadoId = pedidoFaturado.id
    await supabase.from('pedidos').update({ status: 'faturado' }).eq('id', pedidoFaturadoId)

    const tentativaItens = await fetch(`${base}/${pedidoFaturadoId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itens: [{ produto_id: produto.id, quantidade: 5, preco_unitario: 50 }] }),
    })
    check('edição de itens em pedido faturado é bloqueada (400)', tentativaItens.status === 400)

    const tentativaCliente = await fetch(`${base}/${pedidoFaturadoId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cliente_erp_id: cliente.id }),
    })
    check('edição de cliente em pedido faturado é bloqueada (400)', tentativaCliente.status === 400)

    const tentativaDesconto = await fetch(`${base}/${pedidoFaturadoId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ desconto: 20 }),
    })
    check('edição de desconto em pedido faturado é bloqueada (400)', tentativaDesconto.status === 400)

    const tentativaSoft = await fetch(`${base}/${pedidoFaturadoId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ observacoes: 'TESTE PEDIDO FATURADO - OBS EDITADA - APAGAR' }),
    })
    const pedidoSoftEditado = await tentativaSoft.json()
    check('campo "soft" (observações) continua editável em pedido faturado', tentativaSoft.status === 200 && pedidoSoftEditado.observacoes === 'TESTE PEDIDO FATURADO - OBS EDITADA - APAGAR')

    const tentativaCancelado = await fetch(`${base}/${pedidoFaturadoId}/status`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'cancelado' }),
    })
    check('pedido pode ser cancelado normalmente', tentativaCancelado.status === 200)
    const tentativaEditarCancelado = await fetch(`${base}/${pedidoFaturadoId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ observacoes: 'NAO DEVERIA SALVAR' }),
    })
    check('pedido cancelado não pode mais ser editado', tentativaEditarCancelado.status === 400)
  } finally {
    server.close()
    if (pedidoId) {
      await supabase.from('pedido_historico').delete().eq('pedido_id', pedidoId)
      await supabase.from('pedido_itens').delete().eq('pedido_id', pedidoId)
      await supabase.from('pedidos').delete().eq('id', pedidoId)
    }
    if (pedidoFaturadoId) {
      await supabase.from('pedido_historico').delete().eq('pedido_id', pedidoFaturadoId)
      await supabase.from('pedido_itens').delete().eq('pedido_id', pedidoFaturadoId)
      await supabase.from('pedidos').delete().eq('id', pedidoFaturadoId)
    }
  }

  console.log(`\n${falhas === 0 ? 'TODOS OS TESTES DESTE ARQUIVO PASSARAM' : `${falhas} TESTE(S) FALHARAM`}`)
  process.exit(falhas === 0 ? 0 : 1)
}

main().catch(err => { console.error('ERRO FATAL:', err); process.exit(1) })
