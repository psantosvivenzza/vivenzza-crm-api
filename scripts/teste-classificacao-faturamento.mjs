// Testes da fatia "vínculo pedido ↔ NF-e Série 1 autorizada + classificação de
// faturamento" (venda / bonificação / outra_operacao / nao_fiscal), pedida pra
// o Dashboard do CRM conseguir separar venda real de bonificação e Série 99 no
// card "Pedidos do Mês". Roda com `railway run --service vivenzza-crm-api`.
//
// Não chama a SEFAZ de verdade (emissão Série 1 real segue bloqueada até o
// contador liberar a numeração — configuracoes_fiscais.serie1_numeracao_liberada).
// O caminho de autorização é exercitado chamando vincularSerie1Autorizada()
// diretamente com um objeto NFe sintético, do mesmo jeito que POST /:id/emitir e
// o job de reconciliação chamam depois de uma autorização real ou simulada.
import { supabase } from '../src/lib/supabase-admin.server.js'
import { classificarOperacaoPedido } from '../src/lib/cfop.js'
import { vincularSerie1Autorizada, vincularSerie99Interna, desvincularSeForAAtual } from '../src/lib/pedidoFiscal.js'

let falhas = 0
function check(nome, cond, detalhe) {
  if (cond) console.log(`OK — ${nome}`)
  else { falhas++; console.log(`FALHOU — ${nome}${detalhe ? ' — ' + JSON.stringify(detalhe) : ''}`) }
}

const criados = { pedidos: [], nfes: [] }

// pedidos.nfe_id tem FK pra public.nfe(id) — precisa de uma linha real pra
// referenciar, um uuid solto falharia a constraint.
async function criarNfeSintetica(serie, status) {
  const { data, error } = await supabase.from('nfe').insert({
    tipo: 'nfe', serie, tipo_documento: serie === 99 ? 'nota_interna' : 'nfe_sefaz', status,
    natureza_operacao: 'VENDA DE MERCADORIA', finalidade: 1, forma_pagamento: '01',
    dest_nome: 'TESTE APAGAR - Classificação Faturamento', valor_produtos: 100, valor_total: 100,
    observacoes: 'TESTE APAGAR — usada só pra testar vínculo/classificação, nunca emitida de verdade',
  }).select().single()
  if (error) throw error
  criados.nfes.push(data.id)
  return data.id
}

async function main() {
  // --- Classificador puro (lê cfops.categoria_faturamento, real, sem mock) ---
  check('CFOP 5102 (venda) classifica como "venda"',
    await classificarOperacaoPedido([{ cfop: '5102' }]) === 'venda')
  check('CFOP 5910 (bonificação/doação/brinde) classifica como "bonificacao"',
    await classificarOperacaoPedido([{ cfop: '5910' }]) === 'bonificacao')
  check('CFOP 6911 (amostra grátis, interestadual) classifica como "bonificacao"',
    await classificarOperacaoPedido([{ cfop: '6911' }]) === 'bonificacao')
  check('CFOP 5151 (transferência) classifica como "outra_operacao"',
    await classificarOperacaoPedido([{ cfop: '5151' }]) === 'outra_operacao')
  check('CFOP 5949 (outra saída não especificada) classifica como "outra_operacao"',
    await classificarOperacaoPedido([{ cfop: '5949' }]) === 'outra_operacao')
  check('nota mista venda+bonificação classifica como "venda" (precedência — é receita real)',
    await classificarOperacaoPedido([{ cfop: '5910' }, { cfop: '5102' }]) === 'venda')
  check('nota mista bonificação+outra_operacao classifica como "bonificacao" (precedência)',
    await classificarOperacaoPedido([{ cfop: '5151' }, { cfop: '5910' }]) === 'bonificacao')
  check('CFOP não cadastrado (ex: "9999") cai em "outra_operacao" por padrão conservador — nunca "venda" silenciosamente',
    await classificarOperacaoPedido([{ cfop: '9999' }]) === 'outra_operacao')
  check('lista de itens vazia classifica como "outra_operacao"',
    await classificarOperacaoPedido([]) === 'outra_operacao')

  // --- Setup: pedido sintético (sem vendedor — não precisa de comissão aqui) ---
  const { data: pedido, error: errPedido } = await supabase
    .from('pedidos')
    .insert({
      status: 'confirmado', total: 500, status_fiscal: 'nao_faturado',
      cliente_nome_origem: 'TESTE APAGAR - Classificação Faturamento',
      observacoes: 'TESTE APAGAR — gerado por scripts/teste-classificacao-faturamento.mjs',
    })
    .select().single()
  if (errPedido) throw errPedido
  criados.pedidos.push(pedido.id)

  // --- vincularSerie99Interna: nota interna nunca é venda fiscal -------------
  const nfeSerie99Id = await criarNfeSintetica(99, 'emitida_interna')
  await vincularSerie99Interna(pedido.id, nfeSerie99Id)
  const { data: pedidoAposSerie99 } = await supabase.from('pedidos').select('nfe_id, classificacao_faturamento').eq('id', pedido.id).single()
  check('vincularSerie99Interna grava nfe_id da nota interna', pedidoAposSerie99.nfe_id === nfeSerie99Id)
  check('vincularSerie99Interna classifica como "nao_fiscal"', pedidoAposSerie99.classificacao_faturamento === 'nao_fiscal')

  // --- vincularSerie1Autorizada SOBRESCREVE o vínculo da nota interna --------
  // (uma Série 1 autorizada depois é sempre o documento fiscal definitivo).
  const nfeSerie1Id = await criarNfeSintetica(1, 'autorizada')
  const nfeSerie1Fake = { id: nfeSerie1Id, nfe_itens: [{ cfop: '5102' }] }
  const classificacaoRetornada = await vincularSerie1Autorizada(pedido.id, nfeSerie1Fake)
  check('vincularSerie1Autorizada retorna a classificação calculada ("venda")', classificacaoRetornada === 'venda')

  const { data: pedidoAposSerie1 } = await supabase.from('pedidos').select('nfe_id, classificacao_faturamento').eq('id', pedido.id).single()
  check('vincularSerie1Autorizada sobrescreve nfe_id (agora aponta pra Série 1, não mais a nota interna)',
    pedidoAposSerie1.nfe_id === nfeSerie1Fake.id && pedidoAposSerie1.nfe_id !== nfeSerie99Id)
  check('vincularSerie1Autorizada sobrescreve classificacao_faturamento para "venda"',
    pedidoAposSerie1.classificacao_faturamento === 'venda')

  // --- desvincularSeForAAtual: só limpa se a NF-e ainda for a vinculada ------
  await desvincularSeForAAtual(pedido.id, nfeSerie99Id) // já não é mais a atual (foi sobrescrita pela Série 1 acima)
  const { data: pedidoAposDesvinculoErrado } = await supabase.from('pedidos').select('nfe_id, classificacao_faturamento').eq('id', pedido.id).single()
  check('desvincularSeForAAtual NÃO limpa se a nfe_id passada não é mais a atual (evita corrida apagando vínculo mais novo)',
    pedidoAposDesvinculoErrado.nfe_id === nfeSerie1Fake.id && pedidoAposDesvinculoErrado.classificacao_faturamento === 'venda')

  await desvincularSeForAAtual(pedido.id, nfeSerie1Fake.id) // essa É a atual — deve limpar
  const { data: pedidoAposDesvinculoCerto } = await supabase.from('pedidos').select('nfe_id, classificacao_faturamento').eq('id', pedido.id).single()
  check('desvincularSeForAAtual limpa nfe_id e classificacao_faturamento quando a NF-e passada é a atualmente vinculada',
    pedidoAposDesvinculoCerto.nfe_id === null && pedidoAposDesvinculoCerto.classificacao_faturamento === null)

  // --- Confirma que histórico (pedido sem NF-e vinculada) continua NULL ------
  const { data: pedidoTeste, error: errPedidoNunca } = await supabase
    .from('pedidos')
    .insert({
      status: 'faturado', total: 1000, status_fiscal: 'nao_faturado',
      cliente_nome_origem: 'TESTE APAGAR - Pedido "legado" (nunca recebe classificação)',
      observacoes: 'TESTE APAGAR — simula um pedido faturado fora deste fluxo (ex: legado NetVision)',
    })
    .select().single()
  if (errPedidoNunca) throw errPedidoNunca
  criados.pedidos.push(pedidoTeste.id)
  check('pedido "faturado" que nunca passou pelo fluxo de NF-e do sistema fica com classificacao_faturamento NULL (histórico não é reclassificado)',
    pedidoTeste.classificacao_faturamento === null && pedidoTeste.nfe_id === null)
}

async function limpar() {
  // pedidos primeiro (nfe_id referencia nfe — evita depender da ordem de FK).
  for (const id of criados.pedidos) { try { await supabase.from('pedidos').delete().eq('id', id) } catch {} }
  for (const id of criados.nfes) { try { await supabase.from('nfe').delete().eq('id', id) } catch {} }
  console.log('\nLimpeza concluída — dados sintéticos removidos.')
}

main()
  .then(async () => {
    await limpar()
    console.log(`\n${falhas === 0 ? 'TODOS OS TESTES PASSARAM' : `${falhas} TESTE(S) FALHARAM`}`)
    process.exit(falhas === 0 ? 0 : 1)
  })
  .catch(async err => {
    await limpar()
    console.error('ERRO FATAL NO TESTE:', err)
    process.exit(1)
  })
