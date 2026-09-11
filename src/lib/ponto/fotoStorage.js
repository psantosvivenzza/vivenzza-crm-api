// Armazenamento das fotos do piloto "Meu Ponto".
//
// Bucket privado no Supabase Storage (`ponto-fotos`) — SEM getPublicUrl
// (diferente do único precedente real do projeto, whatsapp-media, que usa
// URL pública sem expiração). Leitura é sempre via createSignedUrl, gerada
// sob demanda, expiração curta. Criação do bucket em si é um passo manual
// pendente (ver docs/meu-ponto/ESPECIFICACAO_MEU_PONTO.md, seção 2.4) — não
// existe policy versionada pra copiar neste projeto.
//
// Em ambiente local/teste (LOCAL_PG_URL definida — mesmo sinal que
// supabase-admin.server.js usa para trocar pelo compat client de Postgres),
// os bytes vão para disco dentro do próprio worktree, nunca para o Storage
// real: o compat client não implementa `.storage`, e testes não devem
// depender de integração externa nenhuma.
import { randomUUID } from 'crypto'
import fs from 'fs/promises'
import path from 'path'
import { supabase } from '../supabase-admin.server.js'

const BUCKET = 'ponto-fotos'
const TAMANHO_MAXIMO_BYTES = 5 * 1024 * 1024 // 5MB

const ASSINATURAS = {
  'image/jpeg': Buffer.from([0xff, 0xd8, 0xff]),
  'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
}

function usaArmazenamentoLocal() {
  return Boolean(process.env.LOCAL_PG_URL)
}

function diretorioLocal() {
  return process.env.PONTO_FOTOS_LOCAL_DIR || path.join(process.cwd(), '.localdev', 'ponto-fotos-teste')
}

// Validação real do formato (não confia no mime_type informado pelo
// cliente): confere os bytes iniciais contra a assinatura conhecida do tipo.
export function validarFotoBuffer(buffer, mimeType) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { valido: false, motivo: 'foto_vazia' }
  }
  if (buffer.length > TAMANHO_MAXIMO_BYTES) {
    return { valido: false, motivo: 'foto_excede_tamanho_maximo' }
  }
  const assinatura = ASSINATURAS[mimeType]
  if (!assinatura) {
    return { valido: false, motivo: 'formato_nao_suportado' }
  }
  if (!buffer.subarray(0, assinatura.length).equals(assinatura)) {
    return { valido: false, motivo: 'conteudo_nao_corresponde_ao_formato_declarado' }
  }
  return { valido: true }
}

export async function uploadFoto({ usuarioId, buffer, mimeType }) {
  const extensao = mimeType === 'image/png' ? 'png' : 'jpg'
  const caminho = `${usuarioId}/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.${extensao}`

  if (usaArmazenamentoLocal()) {
    const destino = path.join(diretorioLocal(), caminho)
    await fs.mkdir(path.dirname(destino), { recursive: true })
    await fs.writeFile(destino, buffer)
    return { storagePath: caminho }
  }

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(caminho, buffer, { contentType: mimeType, upsert: false })
  if (error) {
    const falha = new Error('falha_upload_foto')
    falha.codigoOriginal = error.statusCode || error.code
    throw falha
  }
  return { storagePath: caminho }
}

export async function gerarUrlAssinada(storagePath, { expiraEmSegundos = 300 } = {}) {
  if (usaArmazenamentoLocal()) {
    // Marcador claramente não-navegável — em teste/local não existe servidor
    // de arquivos servindo isso, só confirma que o caminho foi resolvido.
    return {
      url: `local-test://ponto-fotos/${storagePath}`,
      expiraEm: new Date(Date.now() + expiraEmSegundos * 1000).toISOString(),
    }
  }

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, expiraEmSegundos)
  if (error) {
    const falha = new Error('falha_gerar_url_assinada')
    falha.codigoOriginal = error.statusCode || error.code
    throw falha
  }
  return {
    url: data.signedUrl,
    expiraEm: new Date(Date.now() + expiraEmSegundos * 1000).toISOString(),
  }
}

export const PONTO_FOTOS_TAMANHO_MAXIMO_BYTES = TAMANHO_MAXIMO_BYTES
