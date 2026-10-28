import test from 'node:test'
import assert from 'node:assert/strict'
import { avaliarProgressoFinanceiro } from '../lib/financeiro-progress-health.mjs'

const agora = Date.parse('2026-10-19T01:00:00.000Z')
const evento = (evento, minutos, etapa = 'sincronizacao_incremental', extra = {}) => JSON.stringify({ tipo: 'financeiro_etapa', etapa, evento, em: new Date(agora - minutos * 60000).toISOString(), ...extra })
const avaliar = (...linhas) => avaliarProgressoFinanceiro(linhas.join('\n'), { agora })

test('heartbeat e texto de rodando não comprovam progresso', () => {
  assert.equal(avaliar('Rodando', '{"Estado":"Rodando","Pid":42}').estado, 'inconclusivo')
})
test('fim recente confirma progresso e janela pode começar no fim da etapa', () => {
  assert.equal(avaliar(evento('fim', 1)).estado, 'ok')
})
test('processo vivo não compensa conclusão antiga ou etapa presa', () => {
  assert.equal(avaliar(evento('fim', 11), 'Rodando').estado, 'atrasado')
  assert.equal(avaliar(evento('fim', 15), evento('inicio', 11)).estado, 'atrasado')
})
test('etapa em curso não renova o prazo da última conclusão', () => {
  assert.equal(avaliar(evento('fim', 11), evento('inicio', 1)).estado, 'atrasado')
  assert.equal(avaliar(evento('fim', 2), evento('inicio', 1)).estado, 'ok')
})
test('início isolado nunca é sucesso, e expira após dez minutos', () => {
  assert.equal(avaliar(evento('inicio', 1)).estado, 'inconclusivo')
  assert.equal(avaliar(evento('inicio', 11)).estado, 'atrasado')
})
test('erro é falha até etapa posterior concluir com sucesso', () => {
  assert.equal(avaliar(evento('erro', 1)).estado, 'erro')
  assert.equal(avaliar(evento('erro', 3), evento('inicio', 2), evento('fim', 1)).estado, 'ok')
})
test('sucesso incremental não apaga erro da conferência; só a mesma etapa recupera', () => {
  const erro = evento('erro', 5, 'conferencia')
  assert.equal(avaliar(erro, evento('fim', 3)).estado, 'erro')
  assert.deepEqual(avaliar(erro, evento('fim', 3)).etapas_com_erro, ['conferencia'])
  assert.equal(avaliar(erro, evento('fim', 3), evento('fim', 1, 'conferencia')).estado, 'ok')
})
test('evento prefixado ou malformado não pode ocultar falha atrás de um fim recente', () => {
  assert.equal(avaliar(evento('fim', 2), '[wrapper] ' + evento('erro', 1)).estado, 'inconclusivo')
  assert.equal(avaliar(evento('fim', 2), '{"tipo":"financeiro_etapa"').estado, 'inconclusivo')
})
test('timestamp futuro, regressivo ou malformado não confirma saúde', () => {
  for (const linhas of [[evento('fim', -1)], [evento('fim', 1), evento('fim', 2)], [evento('fim', 1, undefined, { em: 'ontem' })]]) {
    assert.equal(avaliar(...linhas).estado, 'inconclusivo')
  }
})
test('eventos sobrepostos ou de etapa diferente não confirmam saúde', () => {
  assert.equal(avaliar(evento('inicio', 3), evento('inicio', 2), evento('fim', 1)).estado, 'inconclusivo')
  assert.equal(avaliar(evento('inicio', 2), evento('fim', 1, 'conferencia')).estado, 'inconclusivo')
})
test('saída não inclui campos extras, nomes, valores, PID ou texto privado', () => {
  const r = avaliar(evento('fim', 1, undefined, { cliente: 'DADO_PRIVADO', mensagem: 'SEGREDO', valor: 777, pid: 123 }))
  assert.equal(r.estado, 'ok')
  assert.doesNotMatch(JSON.stringify(r), /DADO_PRIVADO|SEGREDO|777|123/)
})
test('limite temporal inclui exatamente dez minutos e rejeita relógio inválido', () => {
  assert.equal(avaliar(evento('fim', 10)).estado, 'ok')
  assert.equal(avaliarProgressoFinanceiro(evento('fim', 1), { agora: NaN }).estado, 'inconclusivo')
})
