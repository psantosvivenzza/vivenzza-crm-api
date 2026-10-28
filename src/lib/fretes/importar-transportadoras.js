import { normalizarCnpj, validarCnpj } from '../cnpj.js'

const texto = v => String(v ?? '').trim()

// Só cadastra empresas identificáveis. CPF, documento inválido ou cadastro
// ambíguo ficam para revisão; nunca inventar CNPJ nem consentimento.
export function planejarTransportadoras(origem, existentes) {
  const conhecidos = new Set(existentes.map(f => normalizarCnpj(f.cnpj)))
  const grupos = new Map()
  const resumo = { origem: origem.length, existentes: 0, invalidos: 0, ambiguos: 0, repetidos: 0 }
  for (const r of origem) {
    const cnpj = normalizarCnpj(r.CGC_CPF)
    if (!validarCnpj(cnpj) || !texto(r.Nome) || texto(r.Nome).length > 180) { resumo.invalidos++; continue }
    if (conhecidos.has(cnpj)) { resumo.existentes++; continue }
    if (!grupos.has(cnpj)) grupos.set(cnpj, [])
    grupos.get(cnpj).push(r)
  }
  const novos = []
  for (const [cnpj, rows] of grupos) {
    // Mesmo CNPJ com nomes distintos exige revisão humana, não fusão por nome.
    if (new Set(rows.map(r => texto(r.Nome).toUpperCase())).size > 1) { resumo.ambiguos += rows.length; continue }
    resumo.repetidos += rows.length - 1
    const r = rows[0]
    const contatos = []
    for (const [campo, tipo] of [['Celular', 'celular'], ['Fone', 'fone'], ['e_mail', 'email']]) {
      const valor = texto(r[campo])
      if (valor) contatos.push({ tipo, valor })
    }
    novos.push({ cnpj, razao_social: texto(r.Nome), nome_fantasia: texto(r.NomeFantasia) || null,
      ie: texto(r.InscricaoEstadual) || null, origem: 'legado', ativo: Number(r.Inativo || 0) === 0,
      contatos, endereco: { logradouro: texto(r.Endereco), numero: texto(r.Numero), complemento: texto(r.Complemento), bairro: texto(r.Bairro), cidade: texto(r.Cidade), uf: texto(r.Estado), cep: texto(r.CEP) },
      participa_cotacao_frete: false, telefone_cotacao_frete: null, cotacao_frete_consentimento: false })
  }
  return { novos, resumo: { ...resumo, novos: novos.length } }
}
