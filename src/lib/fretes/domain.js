import { paraJidWhatsapp } from '../telefone.js'

export const FRETE_INSTANCE = 'vivenzza-financeiro'
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export class FreteError extends Error {
  constructor(message, status = 400) { super(message); this.status = status }
}
const falhar = (m) => { throw new FreteError(m) }
function texto(v, nome, max = 300, obrigatorio = true) {
  if (typeof v !== 'string' || v.trim().length > max || (obrigatorio && !v.trim())) falhar(`${nome}: informe um texto válido (até ${max} caracteres).`)
  return v.trim()
}
function numero(v, nome, max, inteiro = false, zero = false) {
  if (v === null || v === '' || typeof v === 'boolean' || !['string', 'number'].includes(typeof v)) falhar(`${nome}: informe um número.`)
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0 || (!zero && n === 0) || n > max || (inteiro && !Number.isInteger(n))) falhar(`${nome}: valor fora do intervalo permitido.`)
  return n
}
function parte(v, nome, local = true, aceitarCpf = false) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) falhar(`${nome}: dados obrigatórios.`)
  const cnpj = texto(v.cnpj, `${nome} CNPJ`, 25).replace(/\D/g, '')
  if (cnpj.length !== 14 && !(aceitarCpf && cnpj.length===11)) falhar(`${nome}: informe CNPJ de 14 dígitos${aceitarCpf?' ou CPF de 11 dígitos':''}.`)
  const p = { nome: texto(v.nome, nome, 180), cnpj }
  if (local) {
    const cep = texto(v.cep, `${nome} CEP`, 12).replace(/\D/g, '')
    if (cep.length !== 8) falhar(`${nome}: CEP deve conter 8 dígitos.`)
    p.cep = cep
    p.endereco = texto(v.endereco, `${nome} endereço`, 350)
  }
  return p
}
export function validarCotacao(body) {
  if(!body) falhar('Informe os dados da cotação.')
  const agregado=body.modo_volumes==='cubagem_total'
  if(!agregado && (!Array.isArray(body.volumes)||body.volumes.length<1||body.volumes.length>30))falhar('Informe de 1 a 30 grupos de volumes.')
  if(body.pedido_origem && (typeof body.pedido_origem!=='object'||!UUID.test(body.pedido_origem.id??'')||!/^\d{1,3}-\d{1,10}$/.test(body.pedido_origem.referencia??'')))falhar('Pedido de origem inválido.')
  if(body.pedido_origem && body.dados_importados_conferidos!==true)falhar('Confira os dados importados, as unidades kg/m³, a carga embalada e o valor da mercadoria antes de salvar.')
  const ids = body.transportadora_ids
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 50 || ids.some(id => typeof id !== 'string' || !UUID.test(id)) || new Set(ids).size !== ids.length) falhar('Selecione de 1 a 50 transportadoras distintas.')
  return {
    descricao: texto(body.descricao, 'Mercadoria', 300),
    valor_mercadoria: Math.round(numero(body.valor_mercadoria, 'Valor da mercadoria', 1e9) * 100) / 100,
    peso_kg: numero(body.peso_kg, 'Peso bruto total', 1e6),
    modo_volumes:agregado?'cubagem_total':'medidas',
    ...(agregado?{quantidade_volumes:numero(body.quantidade_volumes,'Quantidade de volumes',10000,true),cubagem_m3:numero(Number(numero(body.cubagem_m3,'Cubagem total em m³',1e6).toFixed(6)),'Cubagem total em m³',1e6)}:{}),
    ...(body.pedido_origem?{pedido_origem:{id:body.pedido_origem.id,referencia:body.pedido_origem.referencia},dados_importados_conferidos:true}:{}),
    volumes: agregado ? [] : body.volumes.map(v => ({
      quantidade: numero(v?.quantidade, 'Quantidade', 10000, true),
      comprimento_cm: numero(v?.comprimento_cm, 'Comprimento em cm', 3000),
      largura_cm: numero(v?.largura_cm, 'Largura em cm', 3000),
      altura_cm: numero(v?.altura_cm, 'Altura em cm', 3000),
    })),
    retirada: parte(body.retirada, 'Retirada'), entrega: parte(body.entrega, 'Entrega',true,true), pagador: parte(body.pagador, 'Pagador', false),
    max_prazo_dias: body.max_prazo_dias == null || body.max_prazo_dias === '' ? null : numero(body.max_prazo_dias, 'Prazo desejado', 365, true, true),
    observacoes: texto(body.observacoes ?? '', 'Observações', 1000, false),
    transportadora_ids: ids,
  }
}
export function normalizarTelefoneFrete(v) {
  if (typeof v !== 'string') falhar('Informe o WhatsApp com DDD.')
  const tel = paraJidWhatsapp(v)
  if (!/^55\d{2}(?:\d{8}|9\d{8})$/.test(tel)) falhar('Informe um WhatsApp brasileiro com DDD e nono dígito válido.')
  return tel
}
export function validarConfigTransportadora(body) {
  for (const key of ['participa_cotacao_frete', 'cotacao_frete_consentimento']) {
    if (typeof body?.[key] !== 'boolean') falhar(`${key}: escolha sim ou não.`)
  }
  const tel = body.telefone_cotacao_frete ? normalizarTelefoneFrete(body.telefone_cotacao_frete) : null
  if (body.participa_cotacao_frete && !tel) falhar('Informe o WhatsApp para habilitar cotações.')
  return { participa_cotacao_frete: body.participa_cotacao_frete, telefone_cotacao_frete: tel, cotacao_frete_consentimento: body.cotacao_frete_consentimento }
}
export function cubagemM3(volumes) {
  return volumes.reduce((s, v) => s + v.quantidade * v.comprimento_cm * v.largura_cm * v.altura_cm / 1e6, 0)
}
export function montarSolicitacao(d, referencia) {
  const dinheiro = Number(d.valor_mercadoria).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
  return [
    `Olá! Sou o assistente de cotações da Vivenzza. Solicitação de frete ${referencia}.`,
    `Mercadoria: ${d.descricao}. Valor transportado: ${dinheiro}. Peso bruto TOTAL: ${d.peso_kg} kg.`,
    ...(d.modo_volumes==='cubagem_total'?[`${d.quantidade_volumes} volume(s); cubagem física total informada: ${d.cubagem_m3} m³. Medidas individuais não informadas.`]:d.volumes.map(v => `${v.quantidade} volume(s) de ${v.comprimento_cm} × ${v.largura_cm} × ${v.altura_cm} cm.`)),
    d.modo_volumes==='cubagem_total'?null:`Cubagem física total: ${cubagemM3(d.volumes).toFixed(4)} m³.`,
    `Retirada: ${d.retirada.nome}, CNPJ ${d.retirada.cnpj}, CEP ${d.retirada.cep}, ${d.retirada.endereco}.`,
    `Entrega: ${d.entrega.nome}, ${d.entrega.cnpj.length===11?'CPF':'CNPJ'} ${d.entrega.cnpj}, CEP ${d.entrega.cep}, ${d.entrega.endereco}.`,
    `Pagador do frete: ${d.pagador.nome}, CNPJ ${d.pagador.cnpj}.`,
    d.max_prazo_dias == null ? null : `Prazo desejado: até ${d.max_prazo_dias} dia(s) úteis.`,
    d.observacoes ? `Observações: ${d.observacoes}` : null,
    'Favor informar preço TOTAL com taxas, prazo em dias úteis, validade e protocolo. Esta solicitação não confirma contratação ou coleta. Para falar com o financeiro, solicite atendimento humano.',
  ].filter(Boolean).join('\n')
}
export function validarProposta(body) {
  if (typeof body?.completa !== 'boolean') falhar('Confirme se o valor inclui todas as taxas.')
  const valor_total = body.valor_total == null || body.valor_total === '' ? null : Math.round(numero(body.valor_total, 'Valor total', 1e9) * 100) / 100
  const prazo_dias = body.prazo_dias == null || body.prazo_dias === '' ? null : numero(body.prazo_dias, 'Prazo', 365, true, true)
  let validade = null
  if (body.validade) {
    if (typeof body.validade !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(body.validade) || !Number.isFinite(Date.parse(body.validade))) falhar('Validade: informe data e hora com fuso.')
    validade = new Date(body.validade).toISOString()
  }
  if (body.completa && (valor_total == null || prazo_dias == null || validade == null)) falhar('Proposta completa exige total, prazo e validade confirmados.')
  if (body.ia_pausada !== undefined && typeof body.ia_pausada !== 'boolean') falhar('Pausa do assistente inválida.')
  return { valor_total, prazo_dias, validade, completa: body.completa, protocolo: texto(body.protocolo ?? '', 'Protocolo', 100, false), observacoes: texto(body.observacoes ?? '', 'Observações', 1000, false), ia_pausada: body.completa ? true : (body.ia_pausada ?? true) }
}
export function compararPropostas(propostas, { max_prazo_dias = null } = {}, now = new Date()) {
  const validas = propostas.filter(p => p.completa === true && ['recebida', 'encerrada'].includes(p.status) && Number(p.valor_total) > 0 && p.prazo_dias != null && Number.isInteger(Number(p.prazo_dias)) && Number(p.prazo_dias) >= 0 && p.validade && Date.parse(p.validade) > +now)
    .map(p => ({ ...p, valor_total: Number(p.valor_total), prazo_dias: Number(p.prazo_dias) }))
  const preco = [...validas].sort((a, b) => a.valor_total - b.valor_total || a.prazo_dias - b.prazo_dias || a.id.localeCompare(b.id))
  const prazo = [...validas].sort((a, b) => a.prazo_dias - b.prazo_dias || a.valor_total - b.valor_total || a.id.localeCompare(b.id))
  const elegiveis = max_prazo_dias == null ? preco : preco.filter(p => p.prazo_dias <= max_prazo_dias)
  return {
    menor_valor: preco[0] ?? null, menor_prazo: prazo[0] ?? null, melhor_custo_beneficio: elegiveis[0] ?? null,
    media_valor: validas.length ? Math.round(validas.reduce((s, p) => s + Math.round(p.valor_total * 100), 0) / validas.length) / 100 : null,
    quantidade_completas: validas.length,
    quantidade_vencidas: propostas.filter(p=>p.completa&&p.validade&&Date.parse(p.validade)<=+now).length,
    motivo: !validas.length ? 'Ainda não há propostas completas e válidas.' : max_prazo_dias == null ? 'Sem prazo desejado: recomendação pelo menor preço total confirmado.' : !elegiveis.length ? 'Nenhuma proposta atende ao prazo desejado. O menor preço permanece visível.' : `Menor preço total que atende ao prazo desejado de ${max_prazo_dias} dia(s) úteis.`,
  }
}
