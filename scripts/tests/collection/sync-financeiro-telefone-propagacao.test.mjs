// CORREÇÃO 2026-09-02 — auditoria da FASE de "REVISÃO DE CONTATOS" achou que
// um título JÁ EXISTENTE nunca tinha telefone_cobranca reatualizado pelo sync
// financeiro: só o caminho de CRIAÇÃO de título novo usava telefoneDoCliente()
// (sync-financeiro-legado.js linha ~363); a RPC fn_sincronizar_baixa_legado,
// chamada pra títulos existentes, só recebe parâmetros de pagamento/status,
// nunca telefone. Isso prova, contra código real (executarSincronizacaoFinanceira
// de verdade, Postgres local), que a correção fecha esse gap — e que ela NUNCA
// toca em DNC/campos financeiros/valor quando a fonte vem vazia.
//
// Sem rede real: pool E01 injetado (poolE01), imita só o suficiente de
// node-postgres (.query()) pra alimentar detectarColunas()/normalizarLinhaLegado()
// com um schema mínimo válido. Nenhum WhatsApp em nenhum cenário (este job não
// chama Evolution em nenhum ponto).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PG_USER, PG_PASSWORD, PG_PORT, PG_DATABASE } from '../../localdb-config.mjs'
process.env.NODE_ENV = 'test'
process.env.LOCAL_PG_URL = `postgres://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${PG_DATABASE}`

const { supabase } = await import('../../../src/lib/supabase-admin.server.js')
const { executarSincronizacaoFinanceira } = await import('../../../src/jobs/sync-financeiro-legado.js')
const { criarContaDeTeste, telefoneDeTeste } = await import('./_setup.mjs')

// Schema mínimo válido: NumeroTitulo/Sequencia (obrigatórias) + ValorPago
// (sinal de pagamento obrigatório) — só o suficiente pra detectarColunas()
// não abortar. `linhas` já vem no formato de linha crua do driver pg (chaves
// = nomes de coluna do NetVision).
function criarPoolE01Fake(linhas) {
  const colunas = ['NumeroTitulo', 'Sequencia', 'ValorPago', 'CodigoCliente']
  return {
    async query(sql) {
      if (sql.includes('information_schema.columns')) {
        return { rows: colunas.map((c) => ({ column_name: c })) }
      }
      return { rows: linhas }
    },
    async end() {},
  }
}

async function criarClienteComContatos(codigoCliente, contatos) {
  await supabase.from('clientes_erp').insert({ legacy_id: codigoCliente, tipo: 'PJ', razao_social: `Cliente ${codigoCliente}`, ativo: true, contatos })
}

async function limparTudo() {
  await supabase.from('contas_financeiras').delete().like('legacy_id', 'cr-999%')
  await supabase.from('clientes_erp').delete().like('legacy_id', 'CLI-TEL-%')
  await supabase.from('collection_do_not_contact').delete().neq('id', '00000000-0000-0000-0000-000000000000')
  await supabase.from('sincronizacoes_financeiro').delete().neq('id', '00000000-0000-0000-0000-000000000000')
}

test('Propagação de telefone NetVision -> cobrança, em título já existente', async (t) => {
  await t.test('1. PROVA: título existente, sem NENHUMA mudança financeira, ainda assim recebe o telefone novo do NetVision', async () => {
    await limparTudo()
    const telefoneA = telefoneDeTeste()
    const telefoneB = telefoneDeTeste()
    const codigo = `CLI-TEL-${Date.now()}`
    await criarClienteComContatos(codigo, [{ tipo: 'celular', valor: telefoneB }])

    const conta = await criarContaDeTeste(supabase, {
      codigo_cliente: codigo, telefone_cobranca: telefoneA, valor: 100, valor_pago: 0, status: 'aberta', vencimento: '2026-12-01',
    })
    await supabase.from('contas_financeiras').update({ legacy_id: 'cr-999001-1' }).eq('id', conta.id)

    // Linha do "NetVision" com o MESMO valor pago (0) — decidirAtualizacao()
    // vai retornar 'nenhuma' (nenhuma mudança financeira), e MESMO ASSIM o
    // telefone precisa propagar.
    const pool = criarPoolE01Fake([{ NumeroTitulo: '999001', Sequencia: '1', ValorPago: 0, CodigoCliente: codigo }])

    const relatorio = await executarSincronizacaoFinanceira({ completo: true, poolE01: pool, dryRun: false, log: () => {} })
    assert.equal(relatorio.total_sem_alteracao, 1, 'nenhuma mudança financeira — prova que o telefone propaga de forma INDEPENDENTE do pagamento')
    assert.equal(relatorio.total_telefone_atualizado, 1)

    const { data: depois } = await supabase.from('contas_financeiras').select('telefone_cobranca, valor, valor_pago, status, vencimento, em_revisao_financeira').eq('id', conta.id).single()
    assert.equal(depois.telefone_cobranca, telefoneB, 'telefone_cobranca precisa ter virado B — ANTES desta correção, continuava A pra sempre')
    assert.equal(Number(depois.valor), 100, 'campo financeiro nunca tocado por esta correção')
    assert.equal(Number(depois.valor_pago), 0)
    assert.equal(depois.status, 'aberta')
    assert.equal(new Date(depois.vencimento).toISOString().slice(0, 10), '2026-12-01')
    assert.equal(depois.em_revisao_financeira, false)
  })

  await t.test('2. fonte SEM contato válido (contatos vazio) -> telefone existente NUNCA é apagado', async () => {
    await limparTudo()
    const telefoneA = telefoneDeTeste()
    const codigo = `CLI-TEL-${Date.now()}`
    await criarClienteComContatos(codigo, [])

    const conta = await criarContaDeTeste(supabase, { codigo_cliente: codigo, telefone_cobranca: telefoneA, valor: 50, valor_pago: 0, status: 'aberta' })
    await supabase.from('contas_financeiras').update({ legacy_id: 'cr-999002-1' }).eq('id', conta.id)

    const pool = criarPoolE01Fake([{ NumeroTitulo: '999002', Sequencia: '1', ValorPago: 0, CodigoCliente: codigo }])
    const relatorio = await executarSincronizacaoFinanceira({ completo: true, poolE01: pool, dryRun: false, log: () => {} })
    assert.equal(relatorio.total_telefone_atualizado, 0, 'sem contato válido na fonte — nada a atualizar, nunca apaga o que já existe')

    const { data: depois } = await supabase.from('contas_financeiras').select('telefone_cobranca').eq('id', conta.id).single()
    assert.equal(depois.telefone_cobranca, telefoneA, 'telefone válido existente precisa permanecer intocado quando a fonte vem vazia')
  })

  await t.test('3. DNC do telefone ANTIGO preservado; telefone NOVO nunca herda o DNC do antigo (contato independente)', async () => {
    await limparTudo()
    const telefoneA = telefoneDeTeste()
    const telefoneB = telefoneDeTeste()
    const codigo = `CLI-TEL-${Date.now()}`
    await criarClienteComContatos(codigo, [{ tipo: 'celular', valor: telefoneB }])

    const conta = await criarContaDeTeste(supabase, { codigo_cliente: codigo, telefone_cobranca: telefoneA, valor: 100, valor_pago: 0, status: 'vencida' })
    await supabase.from('contas_financeiras').update({ legacy_id: 'cr-999003-1' }).eq('id', conta.id)

    // Quarentena temporária ativa em A (número inválido) + opt-out permanente
    // num telefone C qualquer, sem relação nenhuma com este título.
    const quarentenaExpiraEm = new Date(Date.now() + 20 * 86400000).toISOString()
    await supabase.from('collection_do_not_contact').insert({ cliente_telefone: telefoneA, canal: 'whatsapp', motivo: 'numero_invalido_whatsapp', expira_em: quarentenaExpiraEm })
    const telefoneOptOut = telefoneDeTeste()
    await supabase.from('collection_do_not_contact').insert({ cliente_telefone: telefoneOptOut, canal: 'todos', motivo: 'pedido do cliente', expira_em: null })

    const { data: dncAntes } = await supabase.from('collection_do_not_contact').select('*').order('cliente_telefone')

    const pool = criarPoolE01Fake([{ NumeroTitulo: '999003', Sequencia: '1', ValorPago: 0, CodigoCliente: codigo }])
    await executarSincronizacaoFinanceira({ completo: true, poolE01: pool, dryRun: false, log: () => {} })

    const { data: dncDepois } = await supabase.from('collection_do_not_contact').select('*').order('cliente_telefone')
    assert.deepEqual(dncAntes, dncDepois, 'nenhuma linha de DNC pode mudar — nem a quarentena de A, nem o opt-out de C — a sincronização de telefone nunca toca collection_do_not_contact')

    const { data: dncNovo } = await supabase.from('collection_do_not_contact').select('*').eq('cliente_telefone', telefoneB)
    assert.equal(dncNovo.length, 0, 'telefone B (novo) é um contato independente — nunca herda o DNC de A automaticamente')

    const { data: conta_depois } = await supabase.from('contas_financeiras').select('telefone_cobranca').eq('id', conta.id).single()
    assert.equal(conta_depois.telefone_cobranca, telefoneB, 'confirma que o telefone realmente propagou neste cenário')
  })

  await t.test('4. dry-run: conta o que mudaria, mas não escreve nada', async () => {
    await limparTudo()
    const telefoneA = telefoneDeTeste()
    const telefoneB = telefoneDeTeste()
    const codigo = `CLI-TEL-${Date.now()}`
    await criarClienteComContatos(codigo, [{ tipo: 'celular', valor: telefoneB }])
    const conta = await criarContaDeTeste(supabase, { codigo_cliente: codigo, telefone_cobranca: telefoneA, valor: 100, valor_pago: 0, status: 'aberta' })
    await supabase.from('contas_financeiras').update({ legacy_id: 'cr-999004-1' }).eq('id', conta.id)

    const pool = criarPoolE01Fake([{ NumeroTitulo: '999004', Sequencia: '1', ValorPago: 0, CodigoCliente: codigo }])
    const relatorio = await executarSincronizacaoFinanceira({ completo: true, poolE01: pool, dryRun: true, log: () => {} })
    assert.equal(relatorio.total_telefone_atualizado, 1, 'dry-run ainda reporta quantos telefones mudariam')

    const { data: depois } = await supabase.from('contas_financeiras').select('telefone_cobranca').eq('id', conta.id).single()
    assert.equal(depois.telefone_cobranca, telefoneA, 'dry-run nunca escreve — telefone continua A')
  })

  await t.test('5. contador persiste em sincronizacoes_financeiro (não é só um número no retorno da função)', async () => {
    await limparTudo()
    const telefoneA = telefoneDeTeste()
    const telefoneB = telefoneDeTeste()
    const codigo = `CLI-TEL-${Date.now()}`
    await criarClienteComContatos(codigo, [{ tipo: 'celular', valor: telefoneB }])
    const conta = await criarContaDeTeste(supabase, { codigo_cliente: codigo, telefone_cobranca: telefoneA, valor: 100, valor_pago: 0, status: 'aberta' })
    await supabase.from('contas_financeiras').update({ legacy_id: 'cr-999005-1' }).eq('id', conta.id)

    const pool = criarPoolE01Fake([{ NumeroTitulo: '999005', Sequencia: '1', ValorPago: 0, CodigoCliente: codigo }])
    const relatorio = await executarSincronizacaoFinanceira({ completo: true, poolE01: pool, dryRun: false, log: () => {} })

    const { data: linhaSync } = await supabase.from('sincronizacoes_financeiro').select('total_telefone_atualizado').eq('id', relatorio.sincronizacao_id).single()
    assert.equal(linhaSync.total_telefone_atualizado, 1)
  })
})
