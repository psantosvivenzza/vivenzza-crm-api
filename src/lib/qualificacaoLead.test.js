import test from 'node:test'
import assert from 'node:assert/strict'
import { cnpjValido, cidadeOcupada, avaliarLead } from './qualificacaoLead.js'

const territorio = [
  { cidade: 'Pelotas', estado: 'RS' },
  { cidade: 'Parnaíba', estado: 'PI' },
  { cidade: "Sant'Ana do Livramento", estado: 'RS' },
]

test('cnpjValido confere dígitos verificadores', () => {
  assert.equal(cnpjValido('11.222.333/0001-81'), true)
  assert.equal(cnpjValido('11222333000181'), true)
  assert.equal(cnpjValido('11.222.333/0001-82'), false)
  assert.equal(cnpjValido('00000000000000'), false)
  assert.equal(cnpjValido('123'), false)
})

test('cidadeOcupada ignora acento/caixa e respeita UF', () => {
  assert.equal(cidadeOcupada('parnaiba', 'pi', territorio), true)
  assert.equal(cidadeOcupada('Pelotas', 'SC', territorio), false)
  assert.equal(cidadeOcupada('Curitiba', 'PR', territorio), false)
  assert.equal(cidadeOcupada('', 'RS', territorio), null)
})

test('distribuidor sério, CNPJ ativo, região livre, R$ 6 mil => quente', () => {
  const r = avaliarLead(
    { perfil: 'distribuidor', cnpj: 'sim', cidade: 'Curitiba', estado: 'PR', volume_mensal: 6000 },
    { territorio, cnpjStatus: 'ativo' }
  )
  assert.equal(r.faixa, 'quente')
  assert.ok(r.nota >= 85)
  assert.equal(r.repassar_vendedora, true)
})

test('curioso sem CNPJ e sem volume => frio', () => {
  const r = avaliarLead({ perfil: 'indefinido', cnpj: 'nao' }, { territorio })
  assert.equal(r.faixa, 'frio')
  assert.ok(r.nota < 40)
})

test('consumidor final => frio, mas ainda vai para a vendedora', () => {
  const r = avaliarLead({ perfil: 'consumidor_final', cnpj: 'nao', volume_mensal: 200 }, { territorio })
  assert.equal(r.faixa, 'frio')
  assert.equal(r.repassar_vendedora, true)
})

test('região já ocupada por distribuidor nunca fica quente', () => {
  const r = avaliarLead(
    { perfil: 'distribuidor', cnpj: 'sim', cidade: 'Pelotas', estado: 'RS', volume_mensal: 8000 },
    { territorio, cnpjStatus: 'ativo' }
  )
  assert.notEqual(r.faixa, 'quente')
  assert.equal(r.regiao_valida, false)
})

test('volume abaixo de R$ 3 mil nunca fica quente', () => {
  const r = avaliarLead(
    { perfil: 'distribuidor', cnpj: 'sim', cidade: 'Curitiba', estado: 'PR', volume_mensal: 2000 },
    { territorio, cnpjStatus: 'ativo' }
  )
  assert.notEqual(r.faixa, 'quente')
})

test('CNPJ inativo => bloqueado e NÃO repassa para vendedora', () => {
  const r = avaliarLead(
    { perfil: 'distribuidor', cnpj: 'sim', volume_mensal: 9000 },
    { territorio, cnpjStatus: 'inativo' }
  )
  assert.equal(r.faixa, 'bloqueado')
  assert.equal(r.repassar_vendedora, false)
})

test('débito vencido conosco => bloqueado', () => {
  const r = avaliarLead(
    { perfil: 'salao', cnpj: 'sim', volume_mensal: 4000 },
    { territorio, cnpjStatus: 'ativo', inadimplente: true }
  )
  assert.equal(r.faixa, 'bloqueado')
  assert.equal(r.motivo, 'debito_vencido')
})

test('lixo na entrada não quebra', () => {
  const r = avaliarLead({ perfil: 'xyz', cnpj: 'talvez', volume_mensal: 'muito' }, {})
  assert.equal(r.faixa, 'frio')
})
