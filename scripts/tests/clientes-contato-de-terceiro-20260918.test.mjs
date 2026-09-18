// Guard de contato de terceiro: um telefone que já identifica OUTRO cliente
// nunca é acrescentado. Quem herda número errado é cobrado no lugar de quem
// deve — expor dívida a terceiro é o que o art. 42 do CDC pune.
//
// A varredura de 18/09/2026 achou o caso real que motivou isto: duas clientes
// distintas com o MESMO celular e o MESMO e-mail no cadastro do NetVision.
import 'dotenv/config'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mesclarContatosAditivo, chaveContato } from '../../src/jobs/sync-clientes-legado.js'

const dono = new Map([['tel:51996757534', '001572'], ['email:andressa@exemplo.com', '001572']])

test('número que já é de outro cliente NÃO entra — vira conflito', () => {
  const r = mesclarContatosAditivo([], { Celular: '(51) 99675-7534', Fone: '', e_mail: '' }, { donoDaChave: dono, legacyId: '002275' })
  assert.equal(r.alterado, false)
  assert.deepEqual(r.contatos, [])
  assert.equal(r.conflitos.length, 1)
  assert.equal(r.conflitos[0].ja_pertence_a, '001572')
})

test('o próprio dono do número não é bloqueado por si mesmo', () => {
  const r = mesclarContatosAditivo([], { Celular: '51996757534', Fone: '', e_mail: '' }, { donoDaChave: dono, legacyId: '001572' })
  assert.equal(r.alterado, true)
  assert.equal(r.conflitos.length, 0)
})

test('bloqueia o conflitante e acrescenta o legítimo na mesma passada', () => {
  const r = mesclarContatosAditivo(
    [],
    { Celular: '51996757534', Fone: '5133334444', e_mail: '' },
    { donoDaChave: dono, legacyId: '002275' }
  )
  assert.equal(r.conflitos.length, 1)
  assert.deepEqual(r.acrescentados, [{ tipo: 'fone', valor: '5133334444' }])
})

test('e-mail de outro cliente também é bloqueado', () => {
  const r = mesclarContatosAditivo([], { Celular: '', Fone: '', e_mail: 'ANDRESSA@exemplo.com' }, { donoDaChave: dono, legacyId: '002275' })
  assert.equal(r.alterado, false)
  assert.equal(r.conflitos.length, 1)
})

test('sem donoDaChave o merge se comporta como antes (compatível)', () => {
  const r = mesclarContatosAditivo([], { Celular: '51996757534', Fone: '', e_mail: '' })
  assert.equal(r.alterado, true)
  assert.equal(r.conflitos.length, 0)
})

// --- lixo de cadastro ---
// A primeira versão devolvia a chave `tel:` para qualquer valor sem dígito.
// Efeito: 32 clientes apareceram como "mesmo telefone" na varredura só porque
// todos tinham telefone vazio. Um falso positivo desses no guard bloquearia
// contato legítimo de gente sem nenhuma relação entre si.
test('telefone sem dígito nenhum não gera chave', () => {
  assert.equal(chaveContato('celular', '( )'), '')
  assert.equal(chaveContato('fone', '-'), '')
  assert.equal(chaveContato('celular', 'sem telefone'), '')
})

test('número curto demais para ser discável não gera chave', () => {
  assert.equal(chaveContato('celular', '0'), '')
  assert.equal(chaveContato('celular', '9999'), '')
  assert.equal(chaveContato('fone', '33334444'), 'tel:33334444', 'fixo sem DDD tem 8 dígitos e é válido')
})

test('texto sem arroba não vira chave de e-mail', () => {
  assert.equal(chaveContato('email', 'nao tem'), '')
  assert.equal(chaveContato('email', 'a@b.com'), 'email:a@b.com')
})

// --- ambiguidade na origem ---
// Este é o guard que torna a decisão ESTÁVEL. Sem ele, o número volta a ser
// dado a quem for processado primeiro, e a correção da execução anterior é
// desfeita na execução seguinte — 30 minutos depois.
test('contato repetido em dois cadastros do NetVision é bloqueado para os DOIS', () => {
  const ambiguos = new Set(['tel:51996757534'])
  for (const legacyId of ['001572', '002275']) {
    const r = mesclarContatosAditivo([], { Celular: '51996757534', Fone: '', e_mail: '' }, { ambiguosNaOrigem: ambiguos, legacyId })
    assert.equal(r.alterado, false, `${legacyId} não pode receber número ambíguo na origem`)
    assert.equal(r.conflitos[0].ambiguo_na_origem, true)
    assert.equal(r.conflitos[0].ja_pertence_a, null, 'não há dono a eleger — nem a origem sabe')
  }
})

test('ambiguidade na origem bloqueia mesmo quando ninguém no CRM tem o número ainda', () => {
  const r = mesclarContatosAditivo(
    [],
    { Celular: '51996757534', Fone: '', e_mail: '' },
    { donoDaChave: new Map(), ambiguosNaOrigem: new Set(['tel:51996757534']), legacyId: '001572' }
  )
  assert.equal(r.alterado, false)
})

test('bloqueio da ambiguidade é idempotente: rodar de novo não muda nada', () => {
  const ambiguos = new Set(['tel:51996757534'])
  const row = { Celular: '51996757534', Fone: '', e_mail: '' }
  const primeira = mesclarContatosAditivo([], row, { ambiguosNaOrigem: ambiguos, legacyId: '001572' })
  const segunda = mesclarContatosAditivo(primeira.contatos, row, { ambiguosNaOrigem: ambiguos, legacyId: '001572' })
  assert.equal(segunda.alterado, false)
  assert.deepEqual(segunda.contatos, [])
})

test('dois clientes com telefone vazio não colidem entre si', () => {
  const donoVazio = new Map()
  const k = chaveContato('celular', '( )')
  if (k) donoVazio.set(k, '000001')
  const r = mesclarContatosAditivo([], { Celular: '51999998888', Fone: '', e_mail: '' }, { donoDaChave: donoVazio, legacyId: '000002' })
  assert.equal(r.alterado, true, 'lixo de cadastro alheio não pode bloquear número legítimo')
  assert.equal(r.conflitos.length, 0)
})
