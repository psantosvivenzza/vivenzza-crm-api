// Voice AI MVP — inspeção de WAV sem depender de sox/soxi (não disponível
// no lado Windows desta máquina). Parser RIFF/WAVE mínimo, só o suficiente
// pra validar uma gravação antes de mandar pro STT: existe, tem tamanho,
// tem duração, formato/sample rate/canais coerentes.
import { readFileSync, statSync } from 'node:fs'

export function inspecionarWav(caminho) {
  const stat = statSync(caminho) // lança ENOENT se não existir — deixa o chamador tratar
  if (stat.size === 0) {
    return { existe: true, tamanhoBytes: 0, valido: false, motivo: 'arquivo vazio' }
  }

  const buffer = readFileSync(caminho)
  if (buffer.length < 44) {
    return { existe: true, tamanhoBytes: buffer.length, valido: false, motivo: 'menor que header WAV mínimo (44 bytes)' }
  }
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    return { existe: true, tamanhoBytes: buffer.length, valido: false, motivo: 'não é RIFF/WAVE' }
  }

  const numChannels = buffer.readUInt16LE(22)
  const sampleRate = buffer.readUInt32LE(24)
  const bitsPerSample = buffer.readUInt16LE(34)

  let offset = 12
  let dataSize = 0
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4)
    const chunkSize = buffer.readUInt32LE(offset + 4)
    if (chunkId === 'data') {
      dataSize = chunkSize
      break
    }
    offset += 8 + chunkSize + (chunkSize % 2)
  }

  const bytesPerSample = bitsPerSample / 8
  const duracaoMs = dataSize > 0 && sampleRate > 0 && numChannels > 0 && bytesPerSample > 0
    ? Math.round((dataSize / (numChannels * bytesPerSample) / sampleRate) * 1000)
    : 0

  return {
    existe: true,
    tamanhoBytes: buffer.length,
    numChannels,
    sampleRate,
    bitsPerSample,
    dataSize,
    duracaoMs,
    valido: dataSize > 0 && duracaoMs > 0,
    motivo: dataSize > 0 && duracaoMs > 0 ? null : 'sem dados de áudio (data chunk vazio ou ausente)',
  }
}
