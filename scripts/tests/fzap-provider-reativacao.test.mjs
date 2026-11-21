import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../../src/routes/reativacao.js', import.meta.url), 'utf8')
const functionText = source.slice(source.indexOf('export async function enviarMensagemReativacao('), source.indexOf('// Trava de reentrância')).replace('export ', '')
function fixture({ owner = 'fzap', ownershipCode, lookupError = false, fenceError = false, generationError = false, sendSuccess = false, sentUpdateEmpty = false, sentUpdateError = false, concurrentFence = false, sendCode = 'FZAP_UNCERTAIN', existing = [] } = {}) {
  const rows = [...existing], events = []
  let sends = 0
  const db = { from(table) {
    if (!sendSuccess) assert.equal(table, 'reativacao_fila', 'no lead/business status changes on uncertainty')
    let insert, update, filters = []
    const query = {
      select() { return this }, single() { return this }, eq(key, value) { filters.push([key, value]); return this }, limit() { return this }, abortSignal() { return this },
      insert(value) { insert = value; return this },
      update(value) { update = value; return this },
      then(resolve) {
        if (update) {
          const isSent = table === 'reativacao_fila' && update.status === 'enviado'
          const matches = table === 'reativacao_fila' ? rows.filter(row => filters.every(([key, value]) => row[key] === value)) : []
          if (isSent && (sentUpdateEmpty || sentUpdateError)) return Promise.resolve({ data: [], error: sentUpdateError ? {message:'isolated sent write failure'} : null }).then(resolve)
          for (const row of matches) Object.assign(row, update)
          return Promise.resolve({ data: matches.map(row=>({...row})), error: null }).then(resolve)
        }
        if (insert) {
          const failed = insert.mensagem_enviada === 'FZAP_UNCERTAIN' && fenceError
          const row = { id: 'fence-' + rows.length, ...insert }
          if (!failed && table === 'reativacao_fila') { rows.push(row); events.push('insert:' + (insert.mensagem_enviada || 'error')) }
          return Promise.resolve({ data: row, error: failed ? { message: 'isolated db failure' } : null }).then(resolve)
        }
        return Promise.resolve({ data: rows.filter(row => filters.every(([key, value]) => row[key] === value)), error: lookupError ? { message: 'isolated lookup failure' } : null }).then(resolve)
      },
    }
    return query
  } }
  const context = vm.createContext({ Date, AbortSignal,
    EVOLUTION_INSTANCE: 'vivenzza', MAX_TENTATIVAS: 3,
    dentroDaJanelaReativacao: () => true,
    ultimasMensagens: async () => [], resumirHistorico: () => '',
    gerarMensagemReativacao: async () => { if (generationError) throw new Error('isolated deterministic generation failure'); return 'Mensagem fictícia' },
    whatsappTransportFor: async () => { if (ownershipCode) throw Object.assign(new Error('isolated config'),{code:ownershipCode});return owner }, supabase: db,
    incrementarMetrica: async () => {},
    console: { log() {}, error() {} },
    evolutionApi: { async post() { sends++; events.push('send'); if (concurrentFence) rows.push({id:'other-fence',lead_id:'fictitious-lead',tentativa:1,status:'erro',mensagem_enviada:'FZAP_UNCERTAIN'});if (sendSuccess) return {data:{key:{id:'fictitious-provider-id'}}}; throw Object.assign(new Error('isolated provider failure'), { code: sendCode }) } },
  })
  vm.runInContext(functionText + '\nglobalThis.send = enviarMensagemReativacao', context)
  return { send: context.send, rows, events, get sends() { return sends } }
}
const lead = { id: 'fictitious-lead', telefone: '5511000000000', nome: 'Fictício', qtd_followups_automaticos: 0, ultima_mensagem_em: '2026-10-01T00:00:00Z' }
test('uncertain FZAP reactivation is durably fenced before dispatch and not requeued', async () => {
  const f = fixture()
  assert.equal(await f.send(lead), null)
  assert.equal(await f.send(lead), null)
  assert.equal(f.sends, 1)
  assert.deepEqual(f.events.slice(0, 2), ['insert:FZAP_UNCERTAIN', 'send'])
  assert.ok(f.rows.some(row => row.lead_id === lead.id && row.tentativa === 1 && row.status === 'erro' && row.mensagem_enviada === 'FZAP_UNCERTAIN'))
})
test('guard database failure or fence write failure prevents provider call', async () => {
  for (const options of [{ lookupError: true }, { fenceError: true }]) {
    const f = fixture(options)
    assert.equal(await f.send(lead), null); assert.equal(f.sends, 0)
  }
})
test('deterministic AI failure does not create an uncertain dispatch marker', async () => {
  const f = fixture({ generationError: true })
  await f.send(lead)
  assert.equal(f.sends, 0)
  assert.equal(f.rows.some(row => row.mensagem_enviada === 'FZAP_UNCERTAIN'), false)
})
test('uncertainty from another cadence does not block this attempt', async () => {
  const f = fixture({ existing: [{ lead_id: lead.id, tentativa: 2, status: 'erro', mensagem_enviada: 'FZAP_UNCERTAIN' }] })
  await f.send(lead); assert.equal(f.sends, 1)
})
test('Evolution behavior is preserved without adding FZAP uncertainty fences', async () => {
  const f = fixture({ owner: 'evolution' })
  await f.send(lead); await f.send(lead)
  assert.equal(f.sends, 2)
  assert.equal(f.rows.some(row => row.mensagem_enviada === 'FZAP_UNCERTAIN'), false)
})
test('definitive provider rejection or pre-send failure releases only this fence for future cadence attempt', async () => {
  for (const sendCode of ['FZAP_REJECTED', 'FZAP_UNAVAILABLE', 'FZAP_IDENTITY']) {
    const f = fixture({ sendCode })
    await f.send(lead); await f.send(lead)
    assert.equal(f.sends, 2)
    assert.equal(f.rows.some(row => row.mensagem_enviada === 'FZAP_UNCERTAIN'), false)
    assert.equal(f.rows.filter(row => row.mensagem_enviada === 'FZAP_REJECTED').length, 2)
  }
})
test('successful FZAP dispatch promotes the same fence row without an error or duplicate sent row', async () => {
  const f = fixture({ sendSuccess: true })
  const result = await f.send(lead)
  assert.equal(result.evolutionId, 'fictitious-provider-id')
  assert.equal(f.rows.length, 1)
  assert.equal(f.rows[0].status, 'enviado')
  assert.equal(f.rows[0].mensagem_enviada, 'Mensagem fictícia')
  assert.equal(f.events.filter(event => event.startsWith('insert:')).length, 1)
})
test('configuration or ownership unavailability before dispatch produces no queue error flood', async () => {
  for (const ownershipCode of ['FZAP_CONFIG','FZAP_OWNERSHIP']) {
    const f = fixture({ownershipCode})
    await f.send(lead);await f.send(lead)
    assert.equal(f.sends,0);assert.equal(f.rows.length,0)
  }
})
test('definitive rejection only releases the exact fence created by this dispatch', async () => {
  const f = fixture({sendCode:'FZAP_REJECTED',concurrentFence:true})
  await f.send(lead)
  assert.equal(f.rows.find(row=>row.id==='fence-0').mensagem_enviada,'FZAP_REJECTED')
  assert.equal(f.rows.find(row=>row.id==='other-fence').mensagem_enviada,'FZAP_UNCERTAIN')
})
test('zero-row or failed sent persistence preserves uncertainty, without duplicate sent/error insert', async () => {
  for (const options of [{sentUpdateEmpty:true},{sentUpdateError:true}]) {
    const f = fixture({sendSuccess:true,...options})
    assert.equal(await f.send(lead),null)
    assert.equal(f.sends,1);assert.equal(f.rows.length,1)
    assert.equal(f.rows[0].status,'erro');assert.equal(f.rows[0].mensagem_enviada,'FZAP_UNCERTAIN')
  }
})
