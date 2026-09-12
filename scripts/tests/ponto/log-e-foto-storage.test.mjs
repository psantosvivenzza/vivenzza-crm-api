// Testes unitários (sem banco, sem servidor): log sanitizado nunca ecoa
// dado bruto, e o armazenamento local de foto (usado em teste no lugar do
// Supabase Storage real) valida formato/tamanho e faz round-trip completo.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
process.env.LOCAL_PG_URL = process.env.LOCAL_PG_URL || 'postgres://postgres:x@127.0.0.1:1/nao_usado_neste_arquivo'
process.env.PONTO_FOTOS_LOCAL_DIR = path.join(__dirname, '..', '..', '..', '.localdev', 'ponto-fotos-teste-unitario')

const { logarErroPonto } = await import('../../../src/lib/ponto/log.js')
const { validarFotoBuffer, uploadFoto, gerarUrlAssinada } = await import('../../../src/lib/ponto/fotoStorage.js')

test('logarErroPonto nunca imprime texto livre — só etapa fixa + código filtrado por allowlist', () => {
  const linhas = []
  const originalError = console.error
  console.error = (msg) => linhas.push(msg)
  try {
    logarErroPonto('teste_etapa', 'DETALHE: Key (foto_base64)=(dadoSensivel) already exists')
    logarErroPonto('teste_etapa_2', '23505')
    logarErroPonto('teste_etapa_3', undefined)
  } finally {
    console.error = originalError
  }

  assert.equal(linhas.length, 3)
  assert.ok(!linhas[0].includes('dadoSensivel'), 'mensagem de erro bruta nunca deve aparecer no log')
  assert.ok(linhas[0].includes('nao_informado'), 'código fora do formato allowlist vira nao_informado')
  assert.ok(linhas[1].includes('23505'), 'código dentro do formato allowlist (SQLSTATE/PostgREST) é preservado')
  assert.ok(linhas[2].includes('nao_informado'))
})

test('validarFotoBuffer aceita JPEG/PNG com assinatura correta e rejeita o resto', () => {
  const jpegValido = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x00])
  const pngValido = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
  const falsoJpeg = Buffer.from('nao e uma imagem')
  const vazio = Buffer.alloc(0)
  const grandeDemais = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(6 * 1024 * 1024)])

  assert.equal(validarFotoBuffer(jpegValido, 'image/jpeg').valido, true)
  assert.equal(validarFotoBuffer(pngValido, 'image/png').valido, true)
  assert.equal(validarFotoBuffer(falsoJpeg, 'image/jpeg').valido, false)
  assert.equal(validarFotoBuffer(vazio, 'image/jpeg').valido, false)
  assert.equal(validarFotoBuffer(grandeDemais, 'image/jpeg').valido, false)
  assert.equal(validarFotoBuffer(jpegValido, 'image/gif').valido, false, 'formato fora da allowlist é rejeitado mesmo com assinatura JPEG válida')
})

test('upload local + geração de URL "assinada" fazem round-trip sem tocar Storage real', async () => {
  const buffer = Buffer.from([0xff, 0xd8, 0xff, 0x01, 0x02, 0x03])
  const { storagePath } = await uploadFoto({ usuarioId: 'usuario-teste-unitario', buffer, mimeType: 'image/jpeg' })
  assert.ok(storagePath.startsWith('usuario-teste-unitario/'))

  const assinada = await gerarUrlAssinada(storagePath)
  assert.ok(assinada.url.startsWith('local-test://'), 'em modo local/teste nunca deve gerar URL real do Supabase Storage')
  assert.ok(new Date(assinada.expiraEm).getTime() > Date.now())
})
