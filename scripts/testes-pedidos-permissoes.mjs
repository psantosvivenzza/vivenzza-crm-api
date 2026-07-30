// Teste 12 dos 12 obrigatórios: permissões — vendedor só vê/edita seus próprios
// pedidos, não sincroniza nem resolve conflito; admin pode tudo. Mesma técnica
// de Express local + injeção de req.user usada nos outros testes de pedidos.
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
  const { data: usuarioAdmin } = await supabase.from('usuarios').select('id').eq('role', 'admin').limit(1).single()
  const { data: vendedores } = await supabase.from('usuarios').select('id').eq('role', 'vendedor').limit(2)
  if (!vendedores || vendedores.length < 2) {
    console.log('Menos de 2 vendedores cadastrados — não é possível testar isolamento entre vendedores. Abortando teste 12.')
    process.exit(1)
  }
  const [vendedorA, vendedorB] = vendedores
  const admin = { id: usuarioAdmin.id, role: 'admin' }
  const userA = { id: vendedorA.id, role: 'vendedor' }
  const userB = { id: vendedorB.id, role: 'vendedor' }

  const { server: serverAdmin, porta: portaAdmin } = await subirApp(admin)
  const { server: serverA, porta: portaA } = await subirApp(userA)
  const { server: serverB, porta: portaB } = await subirApp(userB)
  const baseAdmin = `http://127.0.0.1:${portaAdmin}/api/pedidos`
  const baseA = `http://127.0.0.1:${portaA}/api/pedidos`
  const baseB = `http://127.0.0.1:${portaB}/api/pedidos`

  let pedidoDoVendedorA
  try {
    const { data: produto } = await supabase.from('produtos').select('id').limit(1).single()
    const { data: cliente } = await supabase.from('clientes_erp').select('id').limit(1).single()

    const criar = await fetch(baseAdmin, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cliente_erp_id: cliente.id, observacoes: 'TESTE PERMISSOES - APAGAR', vendedor_id: vendedorA.id,
        itens: [{ produto_id: produto.id, quantidade: 1, preco_unitario: 10 }],
      }),
    })
    pedidoDoVendedorA = (await criar.json()).id
    check('pedido de teste (vendedor A) criado', criar.status === 201)

    console.log('\n=== Teste 12: permissões — vendedor só acessa seus próprios pedidos ===')
    const verComoA = await fetch(`${baseA}/${pedidoDoVendedorA}`)
    check('vendedor A (dono) consegue ver o próprio pedido', verComoA.status === 200)

    const verComoB = await fetch(`${baseB}/${pedidoDoVendedorA}`)
    check('vendedor B (não-dono) recebe 403 ao tentar ver o pedido de A', verComoB.status === 403)

    const editarComoB = await fetch(`${baseB}/${pedidoDoVendedorA}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ observacoes: 'INVASAO' }),
    })
    check('vendedor B recebe 403 ao tentar editar o pedido de A', editarComoB.status === 403)

    const duplicarComoB = await fetch(`${baseB}/${pedidoDoVendedorA}/duplicar`, { method: 'POST' })
    check('vendedor B recebe 403 ao tentar duplicar o pedido de A', duplicarComoB.status === 403)

    const listaComoA = await fetch(`${baseA}?limit=200`)
    const { data: listaA } = await listaComoA.json()
    check('lista do vendedor A não inclui pedidos de outros vendedores', listaA.every(p => !p.vendedor_id || p.vendedor_id === vendedorA.id))

    console.log('\n=== Teste 12: permissões — sincronização e resolução de conflito são admin-only ===')
    const syncComoVendedor = await fetch(`${baseA}/sincronizar`, { method: 'POST' })
    check('vendedor recebe 403 ao tentar disparar sincronização', syncComoVendedor.status === 403)

    const logComoVendedor = await fetch(`${baseA}/sincronizacoes/log`)
    check('vendedor recebe 403 ao tentar ver o log de sincronização', logComoVendedor.status === 403)

    const vincularComoVendedor = await fetch(`${baseA}/${pedidoDoVendedorA}/vincular-cliente`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cliente_erp_id: cliente.id }),
    })
    check('vendedor recebe 403 ao tentar vincular cliente', vincularComoVendedor.status === 403)

    const resolverComoVendedor = await fetch(`${baseA}/${pedidoDoVendedorA}/resolver-conflito`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ acao: 'manter_local' }),
    })
    check('vendedor recebe 403 ao tentar resolver conflito de sincronização', resolverComoVendedor.status === 403)

    const syncComoAdmin = await fetch(`${baseAdmin}/sincronizacoes/log`)
    check('admin consegue ver o log de sincronização', syncComoAdmin.status === 200)

    const verComoAdmin = await fetch(`${baseAdmin}/${pedidoDoVendedorA}`)
    check('admin consegue ver pedido de qualquer vendedor', verComoAdmin.status === 200)
  } finally {
    serverAdmin.close(); serverA.close(); serverB.close()
    if (pedidoDoVendedorA) {
      await supabase.from('pedido_historico').delete().eq('pedido_id', pedidoDoVendedorA)
      await supabase.from('pedido_itens').delete().eq('pedido_id', pedidoDoVendedorA)
      await supabase.from('pedidos').delete().eq('id', pedidoDoVendedorA)
    }
  }

  console.log(`\n${falhas === 0 ? 'TODOS OS TESTES DESTE ARQUIVO PASSARAM' : `${falhas} TESTE(S) FALHARAM`}`)
  process.exit(falhas === 0 ? 0 : 1)
}

main().catch(err => { console.error('ERRO FATAL:', err); process.exit(1) })
