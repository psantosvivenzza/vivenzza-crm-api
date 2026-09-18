// Política de contato do sync de clientes (decidida em 18/09/2026): somar o
// que vem do NetVision, NUNCA apagar o que o CRM já tem. Estes testes travam
// as duas metades — a que resolve o problema real (número novo chega) e a
// que impede o dano oposto (correção feita no CRM ser sobrescrita).
// `dotenv` primeiro: o módulo do job importa o client do Supabase no topo e
// esse client exige configuração na importação. Estes testes são puros (só
// exercitam a função de merge) e nunca tocam o banco.
import 'dotenv/config'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mesclarContatosAditivo } from '../../src/jobs/sync-clientes-legado.js'

test('acrescenta o celular novo do NetVision mantendo o número que já estava no CRM', () => {
  const r = mesclarContatosAditivo(
    [{ tipo: 'celular', valor: '51995398108' }],
    { Celular: '51998163780', Fone: '', e_mail: '' }
  )
  assert.equal(r.alterado, true)
  assert.deepEqual(r.contatos, [
    { tipo: 'celular', valor: '51995398108' },
    { tipo: 'celular', valor: '51998163780' },
  ])
})

test('cliente sem nenhum contato no CRM recebe os do NetVision', () => {
  const r = mesclarContatosAditivo([], { Celular: '18997049159', Fone: '1833334444', e_mail: 'a@b.com' })
  assert.equal(r.alterado, true)
  assert.equal(r.contatos.length, 3)
})

test('máscara diferente do MESMO número não vira contato duplicado', () => {
  const r = mesclarContatosAditivo(
    [{ tipo: 'celular', valor: '(51) 99539-8108' }],
    { Celular: '51995398108', Fone: '', e_mail: '' }
  )
  assert.equal(r.alterado, false)
  assert.equal(r.contatos.length, 1)
})

test('mesmo número vindo como Fone quando o CRM já tem como celular não duplica', () => {
  const r = mesclarContatosAditivo(
    [{ tipo: 'celular', valor: '4933292747' }],
    { Celular: '', Fone: '4933292747', e_mail: '' }
  )
  assert.equal(r.alterado, false)
})

test('e-mail compara sem diferenciar maiúscula de minúscula', () => {
  const r = mesclarContatosAditivo(
    [{ tipo: 'email', valor: 'Cliente@Exemplo.COM' }],
    { Celular: '', Fone: '', e_mail: 'cliente@exemplo.com' }
  )
  assert.equal(r.alterado, false)
})

test('NUNCA remove, substitui nem reordena o que o CRM já tinha', () => {
  const originais = [
    { tipo: 'celular', valor: '51999990000' },
    { tipo: 'email', valor: 'antigo@exemplo.com' },
  ]
  const r = mesclarContatosAditivo(originais, { Celular: '51988887777', Fone: '', e_mail: '' })
  assert.deepEqual(r.contatos.slice(0, 2), originais, 'os contatos do CRM saem primeiro, intactos e na ordem original')
  assert.equal(r.contatos.length, 3)
})

test('origem sem nenhum contato não altera nada (não grava por grava)', () => {
  const originais = [{ tipo: 'celular', valor: '51999990000' }]
  const r = mesclarContatosAditivo(originais, { Celular: '   ', Fone: null, e_mail: undefined })
  assert.equal(r.alterado, false)
  assert.deepEqual(r.contatos, originais)
})

test('contatos nulo ou malformado no CRM não quebra o merge', () => {
  const r = mesclarContatosAditivo(null, { Celular: '51999990000', Fone: '', e_mail: '' })
  assert.equal(r.alterado, true)
  assert.deepEqual(r.contatos, [{ tipo: 'celular', valor: '51999990000' }])
})
