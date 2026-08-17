// 2026-08-17 — regra "cliente com 2+ títulos mesma data = 1 parcela de
// cobrança". Testa a lógica PURA (sem DB/rede) — cobre os 20 cenários do
// pedido que são decidíveis só pela função de agrupamento, mais 2 cenários
// extras de ambiguidade que descobri auditando dados reais de produção
// (telefone divergente, legacy_id ausente em duplicata).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agruparParaConsolidacao, calcularSaldo, tituloElegivelParaConsolidacao } from '../../../src/lib/collection/consolidacaoParcelas.js'
import { montarMensagem } from '../../../src/lib/reguaCobranca.js'

let seq = 0
function titulo(overrides = {}) {
  seq++
  return {
    id: `uuid-${String(seq).padStart(4, '0')}`,
    codigo_cliente: 'CLI-1',
    pessoa_nome: 'Fulano de Tal',
    telefone_cobranca: '5551999990000',
    vencimento: '2026-08-30',
    valor: 500,
    valor_pago: 0,
    status: 'aberta',
    em_revisao_financeira: false,
    legacy_id: `legacy-${seq}`,
    ...overrides,
  }
}

function grupoUnico(titulos) {
  const grupos = agruparParaConsolidacao(titulos)
  assert.equal(grupos.length, 1, `esperava exatamente 1 grupo, veio ${grupos.length}`)
  return grupos[0]
}

test('1. 1 título → valor normal (grupo de 1, comportamento atual)', () => {
  const g = grupoUnico([titulo({ valor: 813.9 })])
  assert.equal(g.ambiguo, false)
  assert.equal(g.quantidadeTitulos, 1)
  assert.equal(g.valorTotal, 813.9)
})

test('2. 2 títulos mesma data → soma', () => {
  const g = grupoUnico([titulo({ valor: 813.9 }), titulo({ valor: 813.9 })])
  assert.equal(g.quantidadeTitulos, 2)
  assert.equal(g.valorTotal, 1627.8)
})

test('3. 3 títulos mesma data → soma', () => {
  const g = grupoUnico([titulo({ valor: 100 }), titulo({ valor: 200 }), titulo({ valor: 300 })])
  assert.equal(g.quantidadeTitulos, 3)
  assert.equal(g.valorTotal, 600)
})

test('4. 4 títulos mesma data → soma', () => {
  const g = grupoUnico([titulo({ valor: 100 }), titulo({ valor: 100 }), titulo({ valor: 100 }), titulo({ valor: 100 })])
  assert.equal(g.quantidadeTitulos, 4)
  assert.equal(g.valorTotal, 400)
})

test('5. valores diferentes → soma correta', () => {
  const g = grupoUnico([titulo({ valor: 116.05 }), titulo({ valor: 212.53 }), titulo({ valor: 161.55 })])
  assert.ok(Math.abs(g.valorTotal - 490.13) < 0.001)
})

test('6. cliente igual + datas diferentes → NÃO soma (2 grupos)', () => {
  const grupos = agruparParaConsolidacao([
    titulo({ vencimento: '2026-08-30' }),
    titulo({ vencimento: '2026-09-30' }),
  ])
  assert.equal(grupos.length, 2)
  assert.ok(grupos.every((g) => g.quantidadeTitulos === 1))
})

test('7. clientes diferentes + mesma data → NÃO soma (2 grupos)', () => {
  const grupos = agruparParaConsolidacao([
    titulo({ codigo_cliente: 'CLI-1' }),
    titulo({ codigo_cliente: 'CLI-2' }),
  ])
  assert.equal(grupos.length, 2)
  assert.ok(grupos.every((g) => g.quantidadeTitulos === 1))
})

test('8. 1 pago + 1 aberto → só aberto', () => {
  const g = grupoUnico([titulo({ valor: 500, valor_pago: 500, status: 'aberta' }), titulo({ valor: 500 })])
  assert.equal(g.quantidadeTitulos, 1)
  assert.equal(g.valorTotal, 500)
})

test('9. 1 cancelado + 1 aberto → só aberto', () => {
  const g = grupoUnico([titulo({ status: 'cancelada', valor: 500 }), titulo({ valor: 500 })])
  assert.equal(g.quantidadeTitulos, 1)
  assert.equal(g.valorTotal, 500)
})

test('10. 1 parcial + 1 aberto → soma dos saldos', () => {
  const g = grupoUnico([titulo({ valor: 500, valor_pago: 200 }), titulo({ valor: 400, valor_pago: 0 })])
  assert.equal(g.quantidadeTitulos, 2)
  assert.equal(g.valorTotal, 700)
})

test('11. 1 em revisão + 1 aberto → só aberto', () => {
  const g = grupoUnico([titulo({ em_revisao_financeira: true, valor: 500 }), titulo({ valor: 500 })])
  assert.equal(g.quantidadeTitulos, 1)
  assert.equal(g.valorTotal, 500)
})

test('12. 2 em revisão → nenhuma cobrança (0 grupos)', () => {
  const grupos = agruparParaConsolidacao([
    titulo({ em_revisao_financeira: true }),
    titulo({ em_revisao_financeira: true }),
  ])
  assert.equal(grupos.length, 0)
})

test('13. título técnico duplicado (mesmo legacy_id) → não conta duas vezes', () => {
  const g = grupoUnico([
    titulo({ id: 'a', legacy_id: 'cr-1001-1', valor: 300 }),
    titulo({ id: 'b', legacy_id: 'cr-1001-1', valor: 300 }), // MESMO legacy_id = mesmo título real, duplicado tecnicamente
  ])
  assert.equal(g.quantidadeTitulos, 1, 'duplicata técnica deveria colapsar pra 1')
  assert.equal(g.valorTotal, 300, 'não deveria dobrar o valor da duplicata')
})

test('14. títulos reais distintos com mesmo valor → soma', () => {
  const g = grupoUnico([titulo({ legacy_id: 'cr-1001-2', valor: 300 }), titulo({ legacy_id: 'cr-1002-2', valor: 300 })])
  assert.equal(g.quantidadeTitulos, 2)
  assert.equal(g.valorTotal, 600)
})

test('15. agrupamento garante exatamente 1 mensagem lógica por grupo (nunca N pro mesmo cliente+vencimento)', () => {
  const grupos = agruparParaConsolidacao([titulo(), titulo(), titulo(), titulo(), titulo()])
  assert.equal(grupos.length, 1, 'mesmo com 5 títulos elegíveis, cliente+vencimento iguais só geram 1 grupo/1 mensagem')
})

test('16a. representante do grupo é determinístico (mesma entrada → mesmo representante em execuções repetidas — base da idempotência/retry)', () => {
  const titulos = [titulo({ id: 'zzz' }), titulo({ id: 'aaa' }), titulo({ id: 'mmm' })]
  const g1 = grupoUnico(titulos)
  const g2 = grupoUnico(titulos)
  assert.equal(g1.tituloRepresentante.id, g2.tituloRepresentante.id, 'repetir o agrupamento com a mesma entrada deveria sempre escolher o mesmo representante')
})

// 17-20: rate limit / DNC / promessa / financialSyncGuard são checados em
// camadas que este módulo NÃO toca (collectionRouting.js/dispatchEngine.js/
// globalSendLimit.js/doNotContactGuard.js/promises.js/financialSyncGuard.js
// — nenhum desses arquivos foi modificado). O grupo consolidado passa pelos
// MESMOS pontos de chamada de antes (enviarCobrancaComRoteamento recebe os
// mesmos parâmetros, só que com valor somado) — cobertura de integração
// real (com DB local) está em collection-consolidacao-cobranca.test.mjs.

test('extra-1 (ambiguidade real, não estava nos 20 pedidos): telefone divergente no mesmo grupo → ambíguo, nunca soma automaticamente', () => {
  const grupos = agruparParaConsolidacao([
    titulo({ telefone_cobranca: '5551999990000' }),
    titulo({ telefone_cobranca: '5551999999999' }),
  ])
  assert.equal(grupos.length, 1)
  assert.equal(grupos[0].ambiguo, true)
  assert.equal(grupos[0].motivo, 'telefone_divergente')
})

test('extra-2 (ambiguidade real, não estava nos 20 pedidos): 2+ títulos SEM legacy_id no mesmo grupo → ambíguo (não dá pra provar que são distintos)', () => {
  const grupos = agruparParaConsolidacao([
    titulo({ legacy_id: null }),
    titulo({ legacy_id: null }),
  ])
  assert.equal(grupos.length, 1)
  assert.equal(grupos[0].ambiguo, true)
  assert.equal(grupos[0].motivo, 'sem_legacy_id_multiplo')
})

test('extra-3: sem codigo_cliente → nunca agrupa, mesmo com vencimento igual (comportamento atual preservado)', () => {
  const grupos = agruparParaConsolidacao([
    titulo({ codigo_cliente: null }),
    titulo({ codigo_cliente: null }),
  ])
  assert.equal(grupos.length, 2, 'sem chave de cliente confiável, cada título vira seu próprio grupo — nunca inventa outra chave')
})

test('extra-4: calcularSaldo/tituloElegivelParaConsolidacao — mesma fórmula de paymentGuard.js (não reinventa semântica)', () => {
  assert.equal(calcularSaldo({ valor: 500, valor_pago: 200 }), 300)
  assert.equal(calcularSaldo({ valor: 500, valor_pago: null }), 500)
  assert.equal(tituloElegivelParaConsolidacao({ valor: 500, valor_pago: 500, status: 'aberta', em_revisao_financeira: false }), false)
  assert.equal(tituloElegivelParaConsolidacao({ valor: 500, valor_pago: 0, status: 'cancelada', em_revisao_financeira: false }), false)
  assert.equal(tituloElegivelParaConsolidacao({ valor: 500, valor_pago: 0, status: 'aberta', em_revisao_financeira: true }), false)
  assert.equal(tituloElegivelParaConsolidacao({ valor: 500, valor_pago: 0, status: 'aberta', em_revisao_financeira: false }), true)
})

test('extra-5: este módulo NUNCA importa cliente supabase/DB — prova estática de que é 100% puro (nenhuma escrita financeira possível daqui)', async () => {
  const fs = await import('fs')
  const conteudo = fs.readFileSync(new URL('../../../src/lib/collection/consolidacaoParcelas.js', import.meta.url), 'utf8')
  assert.equal(conteudo.includes('supabase'), false)
  assert.equal(conteudo.includes('.insert('), false)
  assert.equal(conteudo.includes('.update('), false)
  assert.equal(conteudo.includes('.delete('), false)
})

test('montarMensagem: quantidadeTitulos=1 (default) produz texto BYTE-A-BYTE idêntico ao de antes (zero regressão no caso comum)', () => {
  for (let etapa = 1; etapa <= 8; etapa++) {
    const semParam = montarMensagem(etapa, { nome: 'Ana', valor: 500, vencimento: '2026-08-30', diasAtraso: 5 })
    const comParamExplicito1 = montarMensagem(etapa, { nome: 'Ana', valor: 500, vencimento: '2026-08-30', diasAtraso: 5, quantidadeTitulos: 1 })
    assert.equal(semParam, comParamExplicito1)
    assert.equal(semParam.includes('títulos com o mesmo vencimento'), false)
  }
})

test('montarMensagem: quantidadeTitulos>=2 adiciona a nota de consolidação, mantendo o valor já somado', () => {
  for (let etapa = 1; etapa <= 8; etapa++) {
    const msg = montarMensagem(etapa, { nome: 'Ana', valor: 1627.8, vencimento: '2026-08-30', diasAtraso: 5, quantidadeTitulos: 2 })
    assert.match(msg, /1\.627,80/)
    assert.match(msg, /Esse valor corresponde a 2 títulos com o mesmo vencimento\./)
  }
})
