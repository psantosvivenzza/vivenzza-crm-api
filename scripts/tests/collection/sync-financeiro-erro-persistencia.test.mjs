// Fase 2B (2026-09-03) — hardening do tratamento de erro em
// executarSincronizacaoFinanceira(). Achado real da Fase 2A: os dois UPDATEs
// finais em sincronizacoes_financeiro (conclusão e fallback de falha)
// espalhavam `{ error }` sem checar o retorno — quando a migration da coluna
// total_telefone_atualizado ainda não tinha sido aplicada em produção, o
// UPDATE de conclusão falhava (42703) SILENCIOSAMENTE: a função retornava
// como se tivesse dado certo, logava "concluído", e a linha ficava presa em
// 'executando' pra sempre (nenhuma vez virou 'falhou' em toda a tabela real).
//
// Contra código real (executarSincronizacaoFinanceira de verdade) e Postgres
// local — nunca Supabase/NetVision/Evolution reais em nenhum cenário. Falhas
// são simuladas interceptando supabase.from('sincronizacoes_financeiro') /
// supabase.from('sincronizacao_financeiro_erros') pontualmente (mesmo padrão
// já usado em dnc-guard-real-dispatch.test.mjs, teste 14).
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { PG_USER, PG_PASSWORD, PG_PORT, PG_DATABASE } from '../../localdb-config.mjs'
process.env.NODE_ENV = 'test'
process.env.LOCAL_PG_URL = `postgres://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${PG_DATABASE}`

const { supabase } = await import('../../../src/lib/supabase-admin.server.js')
const { executarSincronizacaoFinanceira } = await import('../../../src/jobs/sync-financeiro-legado.js')
const { criarContaDeTeste, telefoneDeTeste } = await import('./_setup.mjs')

// Schema mínimo válido pro pool E01 fake — mesmo padrão de
// sync-financeiro-telefone-propagacao.test.mjs. DataAtualizacao incluída no
// schema detectado (col('atualizacao'), ver financeiroLegado.js) pra permitir
// ao teste 1 provar que cursor_final é persistido de verdade — só as linhas
// que realmente incluem essa chave são afetadas, as demais continuam com
// mapa.atualizacao apontando pra uma coluna cujo valor é undefined nelas.
function criarPoolE01Fake(linhas) {
  const colunas = ['NumeroTitulo', 'Sequencia', 'ValorPago', 'CodigoCliente', 'DataAtualizacao']
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

async function limparTudo() {
  await supabase.from('contas_financeiras').delete().like('legacy_id', 'cr-998%')
  await supabase.from('sincronizacao_financeiro_erros').delete().neq('id', '00000000-0000-0000-0000-000000000000')
  await supabase.from('sincronizacoes_financeiro').delete().neq('id', '00000000-0000-0000-0000-000000000000')
}

// Limpeza final — protege qualquer arquivo que rode depois deste na mesma
// bateria contra resíduo de contas_financeiras/sincronizacoes_financeiro
// (achado real desta própria fase: um DELETE que falha silenciosamente por
// FK deixa lixo que quebra a limpeza de OUTRO arquivo de teste depois — foi
// exatamente isso que causou as falhas pré-existentes observadas em
// sync-financeiro-telefone-propagacao.test.mjs nesta sessão, sem relação com
// este hardening).
after(limparTudo)

// Intercepta especificamente os UPDATEs em sincronizacoes_financeiro, sem
// afetar INSERT (precisa continuar criando a linha 'executando' normalmente)
// nem SELECT (cursorDaUltimaSincronizacao precisa continuar lendo o real).
// `falhas` controla, por ORDEM de chamada (1ª = conclusão, 2ª = fallback de
// falha), se aquela chamada específica deve falhar e com qual erro.
//
// Cada entrada de `chamadas` é { campos, coluna, valor } — coluna/valor são
// os argumentos recebidos em .eq(coluna, valor) (sempre 'id'/syncId no código
// real), capturados pra permitir consultar exatamente o registro afetado por
// aquela chamada específica, em vez de uma busca genérica. Quando a chamada
// NÃO deve falhar, delega pro builder real (.update(campos).eq(coluna,valor))
// — comportamento idêntico ao sem interceptação nenhuma.
function interceptarUpdatesSincronizacao({ falhas = [] } = {}) {
  const originalFrom = supabase.from
  const chamadas = []
  supabase.from = (tabela) => {
    if (tabela !== 'sincronizacoes_financeiro') return originalFrom(tabela)
    return {
      insert: (...args) => originalFrom(tabela).insert(...args),
      select: (...args) => originalFrom(tabela).select(...args),
      update: (campos) => {
        const numero = chamadas.length + 1
        const registro = { campos, coluna: null, valor: null }
        chamadas.push(registro)
        const erroDesejado = falhas[numero - 1]
        if (erroDesejado) {
          return {
            eq: (coluna, valor) => {
              registro.coluna = coluna
              registro.valor = valor
              return Promise.resolve({ data: null, error: erroDesejado })
            },
          }
        }
        const builderReal = originalFrom(tabela).update(campos)
        return {
          eq: (coluna, valor) => {
            registro.coluna = coluna
            registro.valor = valor
            return builderReal.eq(coluna, valor)
          },
        }
      },
    }
  }
  return { chamadas, restaurar: () => { supabase.from = originalFrom } }
}

function interceptarInsertErros(erroDesejado) {
  const originalFrom = supabase.from
  let chamadas = 0
  supabase.from = (tabela) => {
    if (tabela !== 'sincronizacao_financeiro_erros') return originalFrom(tabela)
    return {
      insert: (...args) => {
        chamadas++
        return Promise.resolve({ data: null, error: erroDesejado })
      },
    }
  }
  return { contarChamadas: () => chamadas, restaurar: () => { supabase.from = originalFrom } }
}

async function criarContaSemAlteracao(sufixo) {
  const conta = await criarContaDeTeste(supabase, {
    telefone_cobranca: telefoneDeTeste(), valor: 100, valor_pago: 0, status: 'aberta', vencimento: '2026-12-01', codigo_cliente: null,
  })
  await supabase.from('contas_financeiras').update({ legacy_id: `cr-998${sufixo}-1` }).eq('id', conta.id)
  return conta
}

test('Fase 2B — persistência de estado final de sincronizacoes_financeiro', async (t) => {
  await t.test('1. UPDATE final bem-sucedido: status concluido, concluido_em/cursor_final persistidos, função retorna sucesso', async () => {
    await limparTudo()
    await criarContaSemAlteracao('001')
    const dataAtualizacaoEsperada = '2026-01-15T10:00:00.000Z'
    const pool = criarPoolE01Fake([{ NumeroTitulo: '998001', Sequencia: '1', ValorPago: 0, CodigoCliente: null, DataAtualizacao: dataAtualizacaoEsperada }])

    const relatorio = await executarSincronizacaoFinanceira({ completo: true, poolE01: pool, dryRun: false, log: () => {} })
    assert.equal(relatorio.status, 'concluido')
    assert.ok(relatorio.sincronizacao_id)

    const { data: linha } = await supabase.from('sincronizacoes_financeiro').select('status, concluido_em, cursor_final').eq('id', relatorio.sincronizacao_id).single()
    assert.equal(linha.status, 'concluido')
    assert.ok(linha.concluido_em, 'concluido_em precisa estar preenchido')
    assert.ok(linha.cursor_final, 'cursor_final precisa estar preenchido')
    assert.equal(new Date(linha.cursor_final).toISOString(), dataAtualizacaoEsperada, 'cursor_final precisa refletir exatamente o DataAtualizacao lido do NetVision')
  })

  await t.test('2. UPDATE final de conclusão falha: não retorna sucesso, não loga "concluído", tenta marcar falhou com payload mínimo, propaga o erro original', async () => {
    await limparTudo()
    await criarContaSemAlteracao('002')
    const pool = criarPoolE01Fake([{ NumeroTitulo: '998002', Sequencia: '1', ValorPago: 0, CodigoCliente: null }])

    const logs = []
    const { chamadas, restaurar } = interceptarUpdatesSincronizacao({
      falhas: [{ message: 'erro simulado no UPDATE de conclusão' }],
    })

    let erroCapturado = null
    try {
      await executarSincronizacaoFinanceira({ completo: true, poolE01: pool, dryRun: false, log: (m) => logs.push(m) })
      assert.fail('deveria ter lançado — UPDATE de conclusão falhou e não pode virar sucesso silencioso')
    } catch (err) {
      erroCapturado = err
    } finally {
      restaurar()
    }

    assert.match(erroCapturado.message, /erro simulado no UPDATE de conclusão/, 'erro ORIGINAL precisa estar presente na exceção propagada ao chamador')
    assert.equal(logs.some((l) => /concluído:/.test(l)), false, 'nunca pode logar "concluído" quando a persistência do status final falhou')

    // 2ª chamada de update() nesta tabela é o fallback tentando marcar 'falhou'.
    assert.equal(chamadas.length, 2, 'esperava 1 chamada pra conclusão + 1 chamada de fallback')
    assert.equal(chamadas[1].campos.status, 'falhou')
    assert.match(chamadas[1].campos.mensagem_erro, /erro simulado no UPDATE de conclusão/)
  })

  await t.test('3. erro causado por chave/coluna adicional dos contadores: o fallback mínimo ainda consegue marcar falhou (prova que NÃO reusa ...contadores)', async () => {
    await limparTudo()
    await criarContaSemAlteracao('003')
    const pool = criarPoolE01Fake([{ NumeroTitulo: '998003', Sequencia: '1', ValorPago: 0, CodigoCliente: null }])

    // Simula exatamente o bug real: 42703 (coluna inexistente) no UPDATE de
    // conclusão — a 2ª chamada (fallback) NÃO tem essa falha configurada, e
    // portanto só pode ter sucesso se o payload dela for realmente mínimo
    // (sem a chave problemática espalhada de `...contadores`).
    const { chamadas, restaurar } = interceptarUpdatesSincronizacao({
      falhas: [{ code: '42703', message: 'column "total_telefone_atualizado" of relation "sincronizacoes_financeiro" does not exist' }],
    })

    let erroCapturado = null
    try {
      await executarSincronizacaoFinanceira({ completo: true, poolE01: pool, dryRun: false, log: () => {} })
      assert.fail('deveria ter lançado')
    } catch (err) {
      erroCapturado = err
    } finally {
      restaurar()
    }
    assert.match(erroCapturado.message, /42703|does not exist/)

    // Prova específica: o payload da 2ª chamada (fallback) não tem NENHUMA
    // das chaves de `contadores` (total_lido, total_atualizado, etc.) — só
    // status/concluido_em/mensagem_erro.
    assert.equal(chamadas.length, 2, 'esperava 1 chamada pra conclusão + 1 chamada de fallback')
    const payloadFallback = chamadas[1].campos
    const chavesProibidas = ['total_lido', 'total_atualizado', 'total_sem_alteracao', 'total_telefone_atualizado', 'cursor_final']
    for (const chave of chavesProibidas) {
      assert.equal(chave in payloadFallback, false, `fallback não pode reusar a chave "${chave}" de ...contadores`)
    }
    assert.deepEqual(Object.keys(payloadFallback).sort(), ['concluido_em', 'mensagem_erro', 'status'])

    // syncId EXATO afetado pelo fallback — capturado do próprio .eq('id', syncId)
    // da 2ª chamada, nunca uma busca genérica por "qualquer registro falhou"
    // (que poderia coincidir com resíduo de outro teste/execução).
    assert.equal(chamadas[1].coluna, 'id')
    const syncIdFallback = chamadas[1].valor
    assert.ok(syncIdFallback, 'a 2ª chamada precisa ter capturado o syncId usado em .eq()')

    // Como a 2ª chamada NÃO estava configurada pra falhar, ela deveria ter
    // ido pro Postgres local de verdade e conseguido marcar 'falhou' NESSE
    // registro específico.
    const { data: linha } = await supabase.from('sincronizacoes_financeiro').select('status, mensagem_erro').eq('id', syncIdFallback).single()
    assert.equal(linha.status, 'falhou', 'o fallback mínimo precisa ter conseguido persistir o status falhou de verdade, no registro exato desta execução')
    // A exceção lançada carrega err.message (nunca err.code) — o 42703
    // simulado chega aqui como texto da mensagem, não como código isolado.
    assert.match(linha.mensagem_erro, /total_telefone_atualizado.*does not exist/, 'mensagem_erro precisa conter o texto do erro 42703 simulado (a causa real do bug desta fase)')
  })

  await t.test('4. UPDATE de fallback também falha: erro secundário aparece no log, erro original continua sendo o erro lançado ao chamador', async () => {
    await limparTudo()
    await criarContaSemAlteracao('004')
    const pool = criarPoolE01Fake([{ NumeroTitulo: '998004', Sequencia: '1', ValorPago: 0, CodigoCliente: null }])

    const logs = []
    const { restaurar } = interceptarUpdatesSincronizacao({
      falhas: [
        { message: 'erro original da conclusão' },
        { message: 'erro secundário do fallback' },
      ],
    })

    let erroCapturado = null
    try {
      await executarSincronizacaoFinanceira({ completo: true, poolE01: pool, dryRun: false, log: (m) => logs.push(m) })
      assert.fail('deveria ter lançado')
    } catch (err) {
      erroCapturado = err
    } finally {
      restaurar()
    }

    assert.match(erroCapturado.message, /erro original da conclusão/, 'o erro propagado ao chamador precisa continuar sendo o ORIGINAL, nunca o do fallback')
    assert.doesNotMatch(erroCapturado.message, /erro secundário do fallback/, 'o erro secundário nunca pode mascarar/substituir o original na exceção lançada')

    const logCritico = logs.find((l) => /ERRO CRÍTICO/.test(l))
    assert.ok(logCritico, 'precisa existir um log explícito e inequívoco quando nem o fallback consegue persistir')
    assert.match(logCritico, /erro original da conclusão/)
    assert.match(logCritico, /erro secundário do fallback/)
  })

  await t.test('5. falha ao inserir sincronizacao_financeiro_erros: não é silenciosa (log explícito), mas não impede a conclusão do ciclo', async () => {
    await limparTudo()
    // Conta com pagamento MAIOR no CRM do que no "NetVision" — dispara
    // decidirAtualizacao() = 'conflito', que empurra pra `erros` e tenta
    // gravar em sincronizacao_financeiro_erros — sem depender de RPC nenhuma.
    const conta = await criarContaDeTeste(supabase, {
      telefone_cobranca: telefoneDeTeste(), valor: 100, valor_pago: 80, status: 'pago_parcial', codigo_cliente: null,
    })
    await supabase.from('contas_financeiras').update({ legacy_id: 'cr-998005-1' }).eq('id', conta.id)
    const pool = criarPoolE01Fake([{ NumeroTitulo: '998005', Sequencia: '1', ValorPago: 30, CodigoCliente: null }])

    const logs = []
    const { contarChamadas, restaurar } = interceptarInsertErros({ message: 'erro simulado ao inserir detalhe de erro' })

    let relatorio
    try {
      relatorio = await executarSincronizacaoFinanceira({ completo: true, poolE01: pool, dryRun: false, log: (m) => logs.push(m) })
    } finally {
      restaurar()
    }

    assert.equal(contarChamadas(), 1, 'confirma que o insert em sincronizacao_financeiro_erros realmente foi tentado e falhou')
    assert.equal(relatorio.status, 'concluido', 'falha ao gravar o DETALHE do erro não pode impedir a conclusão do ciclo (a decisão de negócio já foi aplicada)')
    const avisoConflito = logs.find((l) => /AVISO.*sincronizacao_financeiro_erros/.test(l))
    assert.ok(avisoConflito, 'precisa existir um log explícito avisando que o registro de detalhe do erro falhou — nunca silencioso')
    assert.match(avisoConflito, /erro simulado ao inserir detalhe de erro/)
  })

  await t.test('6. dry-run: continua sem criar ou atualizar registros de sincronização, mesmo com o hardening', async () => {
    await limparTudo()
    await criarContaSemAlteracao('006')
    const pool = criarPoolE01Fake([{ NumeroTitulo: '998006', Sequencia: '1', ValorPago: 0, CodigoCliente: null }])

    const { count: antes } = await supabase.from('sincronizacoes_financeiro').select('id', { count: 'exact', head: true })
    const relatorio = await executarSincronizacaoFinanceira({ completo: true, poolE01: pool, dryRun: true, log: () => {} })
    const { count: depois } = await supabase.from('sincronizacoes_financeiro').select('id', { count: 'exact', head: true })

    assert.equal(relatorio.sincronizacao_id, null)
    assert.equal(depois, antes, 'dry-run não pode criar nem atualizar nenhuma linha em sincronizacoes_financeiro')
  })
})
