// Lógica de negócio do componente de equipamento — chamada tanto pelas
// rotas reais (todas atrás do gate EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA em
// src/lib/ponto/equipamento.js, inalcançáveis enquanto ele for false) quanto
// diretamente pelos testes (scripts/tests/ponto/*), sem precisar passar
// pela rota HTTP nem pelo gate — testes de unidade/integração desta camada
// provam que o MECANISMO funciona de verdade contra um Postgres real,
// independente de quando (ou se) o gate um dia for aberto por uma mudança
// de código separada e revisada.
import { supabase } from '../supabase-admin.server.js'
import {
  gerarCodigoVinculo,
  gerarSegredoHmacBase64,
  gerarNonce,
  verificarAssinaturaEquipamento,
  assinarDesafio,
} from './assinaturaEquipamento.js'
import crypto from 'node:crypto'

const CODIGO_VINCULO_VALIDADE_MS = 10 * 60 * 1000
const DESAFIO_VALIDADE_MS = 60 * 1000

class ErroEquipamento extends Error {
  constructor(codigo, status) {
    super(codigo)
    this.codigoEquipamento = codigo
    this.status = status
  }
}

// Passo 1 do protocolo — só um admin pode chamar isto (rota que envolve
// esta função exige adminOnly). Gera o código de uso único que o
// colaborador vai colar no serviço local.
export async function iniciarVinculoEquipamento({ equipamentoId, criadoPor }) {
  const { data: equipamento, error: erroEquip } = await supabase
    .from('ponto_equipamentos')
    .select('id, status')
    .eq('id', equipamentoId)
    .maybeSingle()
  if (erroEquip) throw erroEquip
  if (!equipamento || equipamento.status !== 'ativo') {
    throw new ErroEquipamento('equipamento_nao_encontrado', 404)
  }

  const codigo = gerarCodigoVinculo()
  const expiraEm = new Date(Date.now() + CODIGO_VINCULO_VALIDADE_MS).toISOString()

  const { data, error } = await supabase
    .from('ponto_equipamento_vinculos')
    .insert({ equipamento_id: equipamentoId, codigo, criado_por: criadoPor, expira_em: expiraEm })
    .select('id, codigo, expira_em')
    .single()
  if (error) throw error

  return data
}

// Passos 2-4 do protocolo — chamado SEM sessão de usuário (o serviço local
// nunca tem o JWT do colaborador; ver docs/meu-ponto/PROTOCOLO_COMPONENTE_WINDOWS.md
// e a rota src/routes/ponto-equipamento.js). O único "segredo" que autentica
// esta chamada é o código de vínculo — de uso único, validade curta,
// gerado só por um admin.
//
// prova_posse: assinatura (mesmo formato/curva da assinatura de operação)
// sobre `meu-ponto-prova-posse|<codigo>`, feita com a chave que está sendo
// cadastrada — prova que quem está enviando a chave pública também controla
// a privada correspondente, sem exigir nenhuma operação adicional no CNG.
export async function completarVinculoEquipamento({ codigo, chavePublicaJwk, chaveHardwareBacked, provaPosseBase64 }) {
  if (typeof chaveHardwareBacked !== 'boolean') {
    throw new ErroEquipamento('chave_hardware_backed_obrigatorio', 400)
  }

  const { data: vinculo, error: erroVinculo } = await supabase
    .from('ponto_equipamento_vinculos')
    .select('id, equipamento_id, expira_em, usado_em')
    .eq('codigo', codigo)
    .maybeSingle()
  if (erroVinculo) throw erroVinculo
  // Mensagem genérica de propósito — não revela se o código nunca existiu,
  // já expirou, ou já foi usado (mesmo princípio de não vazar qual parte de
  // uma checagem composta falhou, já aplicado nas funções SQL deste módulo).
  if (!vinculo || vinculo.usado_em || new Date(vinculo.expira_em).getTime() < Date.now()) {
    throw new ErroEquipamento('codigo_invalido_expirado_ou_usado', 400)
  }

  let publicKey
  try {
    publicKey = crypto.createPublicKey({ key: chavePublicaJwk, format: 'jwk' })
  } catch {
    throw new ErroEquipamento('chave_publica_jwk_invalida', 400)
  }

  let assinatura
  try {
    assinatura = Buffer.from(provaPosseBase64, 'base64')
  } catch {
    throw new ErroEquipamento('prova_posse_invalida', 400)
  }
  const payloadProva = Buffer.from(`meu-ponto-prova-posse|${codigo}`, 'utf8')
  let provaValida = false
  try {
    provaValida = sig64(assinatura) && crypto.verify('sha256', payloadProva, { key: publicKey, dsaEncoding: 'ieee-p1363' }, assinatura)
  } catch {
    provaValida = false
  }
  if (!provaValida) {
    throw new ErroEquipamento('prova_posse_invalida', 400)
  }

  // Só agora consumimos o código — atomicamente, com o mesmo padrão
  // UPDATE...WHERE...IS NULL...RETURNING usado no resto do módulo. Uma
  // corrida entre duas chamadas concorrentes com o mesmo código faz a
  // segunda perder aqui (0 linhas afetadas), mesmo que ambas tenham passado
  // pela verificação de prova de posse acima.
  const { data: vinculoConsumido, error: erroConsumo } = await supabase
    .from('ponto_equipamento_vinculos')
    .update({ usado_em: new Date().toISOString() })
    .eq('codigo', codigo)
    .is('usado_em', null)
    .select('id, equipamento_id')
    .maybeSingle()
  if (erroConsumo) throw erroConsumo
  if (!vinculoConsumido) {
    throw new ErroEquipamento('codigo_invalido_expirado_ou_usado', 400)
  }

  const segredoHmac = gerarSegredoHmacBase64()

  const { data: equipamento, error: erroUpdate } = await supabase
    .from('ponto_equipamentos')
    .update({
      chave_publica_jwk: chavePublicaJwk,
      chave_hardware_backed: chaveHardwareBacked,
      desafio_hmac_secret: segredoHmac,
      modo: 'producao',
      vinculado_em: new Date().toISOString(),
    })
    .eq('id', vinculoConsumido.equipamento_id)
    .eq('status', 'ativo')
    .select('id, usuario_id')
    .maybeSingle()
  if (erroUpdate) throw erroUpdate
  if (!equipamento) {
    // Equipamento foi revogado entre o início e o fim deste fluxo — o
    // código já foi consumido (não reutilizável), mas nenhuma chave ficou
    // registrada. Admin precisa emitir um novo vínculo se ainda quiser
    // cadastrar este equipamento.
    throw new ErroEquipamento('equipamento_revogado_durante_vinculo', 409)
  }

  const { error: erroEvento } = await supabase
    .from('ponto_equipamento_eventos')
    .insert({
      equipamento_id: equipamento.id,
      usuario_id: equipamento.usuario_id,
      evento: 'chave_registrada',
      executado_por: equipamento.usuario_id,
      observacao: chaveHardwareBacked ? 'chave TPM-backed (CNG)' : 'chave software KSP (CNG, sem TPM)',
    })
  if (erroEvento) throw erroEvento

  return { equipamentoId: equipamento.id, usuarioId: equipamento.usuario_id, desafioHmacSecretBase64: segredoHmac }
}

function sig64(buf) {
  return Buffer.isBuffer(buf) && buf.length === 64
}

// Passo 3 do protocolo — pedido de desafio pelo colaborador logado
// (usuarioId sempre de req.user.id na rota real, nunca do corpo).
export async function emitirDesafio({ usuarioId, equipamentoId, tipo, hashConteudo }) {
  const { data: equipamento, error } = await supabase
    .from('ponto_equipamentos')
    .select('id, usuario_id, status, modo, desafio_hmac_secret')
    .eq('id', equipamentoId)
    .maybeSingle()
  if (error) throw error
  if (!equipamento || equipamento.usuario_id !== usuarioId || equipamento.status !== 'ativo' || equipamento.modo !== 'producao') {
    throw new ErroEquipamento('equipamento_invalido_ou_revogado', 403)
  }

  const nonce = gerarNonce()
  const expiraEm = new Date(Date.now() + DESAFIO_VALIDADE_MS).toISOString()
  const assinaturaServidor = assinarDesafio({ segredoHmacBase64: equipamento.desafio_hmac_secret, nonce, equipamentoId, usuarioId, tipo, hashConteudo, expiraEmISO: expiraEm })

  const { data: desafio, error: erroInsert } = await supabase
    .from('ponto_desafios')
    .insert({ equipamento_id: equipamentoId, usuario_id: usuarioId, tipo, hash_conteudo: hashConteudo, nonce, expira_em: expiraEm, assinatura_servidor: assinaturaServidor })
    .select('nonce, expira_em, assinatura_servidor')
    .single()
  if (erroInsert) throw erroInsert

  return desafio
}

// Passos 5-6 do protocolo. Verificação de assinatura acontece aqui, em
// Node/OpenSSL, ANTES de chamar a função Postgres — se a assinatura for
// inválida, o nonce nunca é tocado (permite nova tentativa legítima). A
// função Postgres (ponto_registrar_marcacao_assinada) cuida da parte
// atômica: consumo do nonce + revalidação fresca + inserção da marcação —
// ver o comentário no topo da migration 053 sobre essa fronteira.
export async function registrarMarcacaoAssinada({
  usuarioId, equipamentoId, nonce, operacaoId, tipo, hashConteudo, assinaturaBase64,
  fotoId, ip, sinalizadoParaRevisao, motivoSinalizacao,
}) {
  const { data: equipamento, error: erroEquip } = await supabase
    .from('ponto_equipamentos')
    .select('id, chave_publica_jwk, status, modo, usuario_id')
    .eq('id', equipamentoId)
    .maybeSingle()
  if (erroEquip) throw erroEquip
  if (!equipamento || !equipamento.chave_publica_jwk) {
    throw new ErroEquipamento('equipamento_invalido_ou_revogado', 403)
  }

  const assinaturaValida = verificarAssinaturaEquipamento({
    chavePublicaJwk: equipamento.chave_publica_jwk,
    nonce, equipamentoId, usuarioId, operacaoId, tipo, hashConteudo,
    assinaturaBase64,
  })
  if (!assinaturaValida) {
    throw new ErroEquipamento('assinatura_invalida', 401)
  }

  const { data, error } = await supabase.rpc('ponto_registrar_marcacao_assinada', {
    p_nonce: nonce,
    p_equipamento_id: equipamentoId,
    p_usuario_id: usuarioId,
    p_operacao_id: operacaoId,
    p_tipo: tipo,
    p_hash_conteudo: hashConteudo,
    p_foto_id: fotoId || null,
    p_ip_registro: ip || null,
    p_sinalizado_para_revisao: Boolean(sinalizadoParaRevisao),
    p_motivo_sinalizacao: motivoSinalizacao || null,
  })
  if (error) {
    const mapeado = mapearErroRegistro(error.message)
    if (mapeado) throw new ErroEquipamento(error.message, mapeado.status)
    throw error
  }

  return Array.isArray(data) ? data[0] : data
}

export function mapearErroRegistro(mensagem) {
  const mapa = {
    piloto_desativado: 403,
    usuario_invalido_ou_inativo: 403,
    desafio_nao_encontrado: 404,
    desafio_ja_usado: 409,
    desafio_expirado: 410,
    conteudo_nao_confere: 409,
    equipamento_invalido_ou_revogado: 403,
    operacao_id_conteudo_diferente: 409,
  }
  const status = mapa[mensagem]
  return status ? { status } : null
}

export { ErroEquipamento }
