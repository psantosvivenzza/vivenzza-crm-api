// Testes do componente de equipamento — mecanismo real (desafio, assinatura,
// atomicidade) contra Postgres real, chamando as funções de serviço
// DIRETAMENTE (não a rota HTTP) — ver comentário no topo de
// src/lib/ponto/equipamentoService.js sobre por quê: EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA
// nunca é alterado (nem aqui, nem em nenhum outro teste deste projeto) —
// os testes provam que o MECANISMO funciona de verdade, não que a rota
// pública está aberta (ela nunca está — ver componente-equipamento-gate-http.test.mjs).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import {
  subirServidorDeTeste, pararServidorDeTeste, obterSupabaseDeTeste,
  criarUsuarioDeTeste, habilitarPontoDeTeste, definirPilotoAtivoDeTeste, definirHabilitacaoDeTeste,
  criarEquipamentoDeTeste, vincularEquipamentoDeTesteComChaveNode, revogarEquipamentoDeTeste,
  limparVinculosCircularesDeTeste, instalarFalhaForcadaDeInsert, removerFalhaForcadaDeInsert,
  criarPapelPostgresDeTeste, apagarPapelPostgresDeTeste, concederExecucaoDeTeste, concederAcessoTabelasPontoDeTeste, executarComoPapelDeTeste,
} from './_setup.mjs'

let usuario, admin
let supabase

before(async () => {
  await subirServidorDeTeste()
  supabase = obterSupabaseDeTeste()
  await definirPilotoAtivoDeTeste(true)
  admin = await criarUsuarioDeTeste({ role: 'admin' })
  usuario = await criarUsuarioDeTeste()
  await habilitarPontoDeTeste(usuario.id, true)
})

after(async () => {
  await limparVinculosCircularesDeTeste([usuario.id, admin.id])
  await supabase.from('ponto_marcacoes').delete().eq('usuario_id', usuario.id)
  await supabase.from('ponto_desafios').delete().eq('usuario_id', usuario.id)
  await supabase.from('ponto_equipamento_eventos').delete().eq('usuario_id', usuario.id)
  await supabase.from('ponto_equipamentos').delete().eq('usuario_id', usuario.id)
  await pararServidorDeTeste()
})

// Monta um equipamento vinculado (chave Node, não CNG — ver comentário em
// vincularEquipamentoDeTesteComChaveNode) pronto pra assinar.
async function montarEquipamentoAssinante({ hardwareBacked = false } = {}) {
  const { iniciarVinculoEquipamento } = await import('../../../src/lib/ponto/equipamentoService.js')
  const equipamentoId = await criarEquipamentoDeTeste({ usuarioId: usuario.id, cadastradoPor: admin.id })
  const { privateKey, publicJwk } = await vincularEquipamentoDeTesteComChaveNode({ equipamentoId, chaveHardwareBacked: hardwareBacked })
  return { equipamentoId, privateKey, publicJwk }
}

function assinar(privateKey, payloadBuffer) {
  return crypto.sign('sha256', payloadBuffer, { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64')
}

// ponto_marcacoes_normal_exige_foto exige foto_id real em toda marcação
// origem='normal' — aqui só testamos a camada de assinatura/desafio, então
// criamos uma linha mínima em ponto_fotos (sem bytes reais, sem tocar
// Storage) só pra satisfazer a FK/CHECK, igual ao resto do banco espera.
async function criarFotoDeTeste() {
  const { data, error } = await supabase
    .from('ponto_fotos')
    .insert({ usuario_id: usuario.id, storage_path: `teste/${crypto.randomUUID()}.jpg`, mime_type: 'image/jpeg', tamanho_bytes: 200, capturada_em: new Date().toISOString() })
    .select('id')
    .single()
  if (error) throw error
  return data.id
}

test('cadastro não supervisionado: código inexistente é rejeitado', async () => {
  const { completarVinculoEquipamento, ErroEquipamento } = await import('../../../src/lib/ponto/equipamentoService.js')
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = publicKey.export({ format: 'jwk' })
  const prova = crypto.sign('sha256', Buffer.from('meu-ponto-prova-posse|CODIGO-INEXISTENTE-000'), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64')

  await assert.rejects(
    () => completarVinculoEquipamento({ codigo: 'CODIGO-INEXISTENTE-000', chavePublicaJwk: jwk, chaveHardwareBacked: false, provaPosseBase64: prova }),
    (err) => { assert.ok(err instanceof ErroEquipamento); assert.equal(err.codigoEquipamento, 'codigo_invalido_expirado_ou_usado'); return true }
  )
})

test('cadastro supervisionado completo: fluxo real de vínculo com prova de posse', async () => {
  const { iniciarVinculoEquipamento, completarVinculoEquipamento } = await import('../../../src/lib/ponto/equipamentoService.js')
  const equipamentoId = await criarEquipamentoDeTeste({ usuarioId: usuario.id, cadastradoPor: admin.id })
  const vinculo = await iniciarVinculoEquipamento({ equipamentoId, criadoPor: admin.id })
  assert.ok(vinculo.codigo)

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = publicKey.export({ format: 'jwk' })
  const prova = crypto.sign('sha256', Buffer.from(`meu-ponto-prova-posse|${vinculo.codigo}`), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64')

  const resultado = await completarVinculoEquipamento({ codigo: vinculo.codigo, chavePublicaJwk: jwk, chaveHardwareBacked: true, provaPosseBase64: prova })
  assert.equal(resultado.equipamentoId, equipamentoId)
  assert.ok(resultado.desafioHmacSecretBase64)

  const { data: equip } = await supabase.from('ponto_equipamentos').select('modo, chave_hardware_backed').eq('id', equipamentoId).single()
  assert.equal(equip.modo, 'producao')
  assert.equal(equip.chave_hardware_backed, true)

  // Código já usado — segunda tentativa com o mesmo código falha, mesmo com prova válida.
  const prova2 = crypto.sign('sha256', Buffer.from(`meu-ponto-prova-posse|${vinculo.codigo}`), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64')
  await assert.rejects(() => completarVinculoEquipamento({ codigo: vinculo.codigo, chavePublicaJwk: jwk, chaveHardwareBacked: true, provaPosseBase64: prova2 }))
})

test('cadastro supervisionado: prova de posse com chave errada é rejeitada (não prova a mesma privada)', async () => {
  const { iniciarVinculoEquipamento, completarVinculoEquipamento } = await import('../../../src/lib/ponto/equipamentoService.js')
  const equipamentoId = await criarEquipamentoDeTeste({ usuarioId: usuario.id, cadastradoPor: admin.id })
  const vinculo = await iniciarVinculoEquipamento({ equipamentoId, criadoPor: admin.id })

  const par1 = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const par2 = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  // Envia a chave pública do par1, mas assina a prova com a privada do par2.
  const provaComOutraChave = crypto.sign('sha256', Buffer.from(`meu-ponto-prova-posse|${vinculo.codigo}`), { key: par2.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64')

  await assert.rejects(() => completarVinculoEquipamento({
    codigo: vinculo.codigo,
    chavePublicaJwk: par1.publicKey.export({ format: 'jwk' }),
    chaveHardwareBacked: false,
    provaPosseBase64: provaComOutraChave,
  }))

  // Código não deve ter sido consumido por uma tentativa com prova inválida.
  const { data } = await supabase.from('ponto_equipamento_vinculos').select('usado_em').eq('codigo', vinculo.codigo).single()
  assert.equal(data.usado_em, null)
})

test('assinatura válida: marcação é registrada com origem normal e equipamento_id', async () => {
  const { emitirDesafio, registrarMarcacaoAssinada } = await import('../../../src/lib/ponto/equipamentoService.js')
  const { calcularHashConteudo, payloadAssinaturaEquipamento } = await import('../../../src/lib/ponto/assinaturaEquipamento.js')
  const { equipamentoId, privateKey } = await montarEquipamentoAssinante()

  const hash = calcularHashConteudo(Buffer.from('foto-fake-1'))
  const desafio = await emitirDesafio({ usuarioId: usuario.id, equipamentoId, tipo: 'entrada', hashConteudo: hash })

  const operacaoId = crypto.randomUUID()
  const payload = payloadAssinaturaEquipamento({ nonce: desafio.nonce, equipamentoId, usuarioId: usuario.id, operacaoId, tipo: 'entrada', hashConteudo: hash })
  const assinatura = assinar(privateKey, payload)

  const resultado = await registrarMarcacaoAssinada({
    usuarioId: usuario.id, equipamentoId, nonce: desafio.nonce, operacaoId, tipo: 'entrada', hashConteudo: hash, assinaturaBase64: assinatura,
    fotoId: await criarFotoDeTeste(), ip: '127.0.0.1', sinalizadoParaRevisao: false, motivoSinalizacao: null,
  })
  assert.equal(resultado.resultado, 'registrada_agora')
  assert.equal(resultado.origem, 'normal')

  const { data: marcacao } = await supabase.from('ponto_marcacoes').select('equipamento_id, origem').eq('id', resultado.marcacao_id).single()
  assert.equal(marcacao.origem, 'normal')
  assert.equal(marcacao.equipamento_id, equipamentoId)
})

test('assinatura inválida: rejeitada e nonce NÃO é consumido (permite nova tentativa)', async () => {
  const { emitirDesafio, registrarMarcacaoAssinada, ErroEquipamento } = await import('../../../src/lib/ponto/equipamentoService.js')
  const { calcularHashConteudo } = await import('../../../src/lib/ponto/assinaturaEquipamento.js')
  const { equipamentoId } = await montarEquipamentoAssinante()

  const hash = calcularHashConteudo(Buffer.from('foto-fake-2'))
  const desafio = await emitirDesafio({ usuarioId: usuario.id, equipamentoId, tipo: 'entrada', hashConteudo: hash })
  const operacaoId = crypto.randomUUID()

  await assert.rejects(
    () => registrarMarcacaoAssinada({
      usuarioId: usuario.id, equipamentoId, nonce: desafio.nonce, operacaoId, tipo: 'entrada', hashConteudo: hash,
      assinaturaBase64: Buffer.alloc(64, 7).toString('base64'), fotoId: null, ip: null,
    }),
    (err) => { assert.ok(err instanceof ErroEquipamento); assert.equal(err.codigoEquipamento, 'assinatura_invalida'); return true }
  )

  const { data } = await supabase.from('ponto_desafios').select('usado_em').eq('nonce', desafio.nonce).single()
  assert.equal(data.usado_em, null, 'nonce deveria continuar livre após assinatura inválida')
})

test('usuário errado: nonce de outro usuário é rejeitado como desafio_nao_encontrado', async () => {
  const { emitirDesafio, registrarMarcacaoAssinada, ErroEquipamento } = await import('../../../src/lib/ponto/equipamentoService.js')
  const { calcularHashConteudo, payloadAssinaturaEquipamento } = await import('../../../src/lib/ponto/assinaturaEquipamento.js')
  const outroUsuario = await criarUsuarioDeTeste()
  const { equipamentoId, privateKey } = await montarEquipamentoAssinante()

  const hash = calcularHashConteudo(Buffer.from('foto-fake-3'))
  const desafio = await emitirDesafio({ usuarioId: usuario.id, equipamentoId, tipo: 'entrada', hashConteudo: hash })
  const operacaoId = crypto.randomUUID()
  const payload = payloadAssinaturaEquipamento({ nonce: desafio.nonce, equipamentoId, usuarioId: outroUsuario.id, operacaoId, tipo: 'entrada', hashConteudo: hash })
  const assinatura = assinar(privateKey, payload)

  await assert.rejects(
    () => registrarMarcacaoAssinada({ usuarioId: outroUsuario.id, equipamentoId, nonce: desafio.nonce, operacaoId, tipo: 'entrada', hashConteudo: hash, assinaturaBase64: assinatura }),
    (err) => { assert.ok(err instanceof ErroEquipamento); assert.equal(err.codigoEquipamento, 'desafio_nao_encontrado'); return true }
  )
  await supabase.from('ponto_marcacoes').delete().eq('usuario_id', outroUsuario.id)
})

test('equipamento errado: assinatura de um equipamento não confere contra a chave pública de outro', async () => {
  // Camada JS (verificarAssinaturaEquipamento): a verificação busca a chave
  // pública do equipamento INFORMADO no pedido (equipB) — uma assinatura
  // feita pela chave de outro equipamento (equipA) nunca bate contra ela,
  // então é rejeitada aqui, antes mesmo de chegar na função SQL. Ver o
  // próximo teste para a defesa equivalente DENTRO da função SQL, caso a
  // verificação em JS seja contornada (chamada direta da função).
  const { emitirDesafio, registrarMarcacaoAssinada, ErroEquipamento } = await import('../../../src/lib/ponto/equipamentoService.js')
  const { calcularHashConteudo, payloadAssinaturaEquipamento } = await import('../../../src/lib/ponto/assinaturaEquipamento.js')
  const { equipamentoId: equipA, privateKey: chaveA } = await montarEquipamentoAssinante()
  const { equipamentoId: equipB } = await montarEquipamentoAssinante()

  const hash = calcularHashConteudo(Buffer.from('foto-fake-4'))
  const desafio = await emitirDesafio({ usuarioId: usuario.id, equipamentoId: equipA, tipo: 'entrada', hashConteudo: hash })
  const operacaoId = crypto.randomUUID()
  const payload = payloadAssinaturaEquipamento({ nonce: desafio.nonce, equipamentoId: equipB, usuarioId: usuario.id, operacaoId, tipo: 'entrada', hashConteudo: hash })
  const assinatura = assinar(chaveA, payload)

  await assert.rejects(
    () => registrarMarcacaoAssinada({ usuarioId: usuario.id, equipamentoId: equipB, nonce: desafio.nonce, operacaoId, tipo: 'entrada', hashConteudo: hash, assinaturaBase64: assinatura }),
    (err) => { assert.ok(err instanceof ErroEquipamento); assert.equal(err.codigoEquipamento, 'assinatura_invalida'); return true }
  )
})

test('defesa em profundidade na função SQL: nonce de outro equipamento é rejeitado mesmo chamando a função direto (sem verificação de assinatura em JS)', async () => {
  const { emitirDesafio } = await import('../../../src/lib/ponto/equipamentoService.js')
  const { calcularHashConteudo } = await import('../../../src/lib/ponto/assinaturaEquipamento.js')
  const { equipamentoId: equipA } = await montarEquipamentoAssinante()
  const { equipamentoId: equipB } = await montarEquipamentoAssinante()

  const hash = calcularHashConteudo(Buffer.from('foto-fake-4b'))
  const desafio = await emitirDesafio({ usuarioId: usuario.id, equipamentoId: equipA, tipo: 'entrada', hashConteudo: hash })
  const operacaoId = crypto.randomUUID()

  // Chama a função Postgres DIRETO (supabase.rpc, como se algo tivesse
  // contornado inteiramente a verificação de assinatura em Node) informando
  // o nonce de equipA mas p_equipamento_id = equipB.
  const { data, error } = await supabase.rpc('ponto_registrar_marcacao_assinada', {
    p_nonce: desafio.nonce, p_equipamento_id: equipB, p_usuario_id: usuario.id, p_operacao_id: operacaoId,
    p_tipo: 'entrada', p_hash_conteudo: hash, p_foto_id: null, p_ip_registro: null,
    p_sinalizado_para_revisao: false, p_motivo_sinalizacao: null,
  })
  assert.equal(data, null)
  assert.ok(error)
  assert.equal(error.message, 'desafio_nao_encontrado')
})

test('conteúdo alterado após o desafio: hash diferente é rejeitado', async () => {
  const { emitirDesafio, registrarMarcacaoAssinada, ErroEquipamento } = await import('../../../src/lib/ponto/equipamentoService.js')
  const { calcularHashConteudo, payloadAssinaturaEquipamento } = await import('../../../src/lib/ponto/assinaturaEquipamento.js')
  const { equipamentoId, privateKey } = await montarEquipamentoAssinante()

  const hashOriginal = calcularHashConteudo(Buffer.from('foto-original'))
  const hashAdulterado = calcularHashConteudo(Buffer.from('foto-trocada'))
  const desafio = await emitirDesafio({ usuarioId: usuario.id, equipamentoId, tipo: 'entrada', hashConteudo: hashOriginal })
  const operacaoId = crypto.randomUUID()
  // O equipamento assina o hash ADULTERADO (simula uma tentativa de trocar a foto depois do desafio).
  const payload = payloadAssinaturaEquipamento({ nonce: desafio.nonce, equipamentoId, usuarioId: usuario.id, operacaoId, tipo: 'entrada', hashConteudo: hashAdulterado })
  const assinatura = assinar(privateKey, payload)

  await assert.rejects(
    () => registrarMarcacaoAssinada({ usuarioId: usuario.id, equipamentoId, nonce: desafio.nonce, operacaoId, tipo: 'entrada', hashConteudo: hashAdulterado, assinaturaBase64: assinatura }),
    (err) => { assert.ok(err instanceof ErroEquipamento); assert.equal(err.codigoEquipamento, 'conteudo_nao_confere'); return true }
  )
})

test('desafio expirado: rejeitado mesmo com assinatura válida', async () => {
  const { registrarMarcacaoAssinada, ErroEquipamento } = await import('../../../src/lib/ponto/equipamentoService.js')
  const { calcularHashConteudo, payloadAssinaturaEquipamento, gerarNonce } = await import('../../../src/lib/ponto/assinaturaEquipamento.js')
  const { equipamentoId, privateKey } = await montarEquipamentoAssinante()

  const hash = calcularHashConteudo(Buffer.from('foto-fake-5'))
  const nonce = gerarNonce()
  // Insere o desafio JÁ expirado direto (sem passar pelo emitirDesafio, que sempre usa validade futura).
  await supabase.from('ponto_desafios').insert({
    equipamento_id: equipamentoId, usuario_id: usuario.id, tipo: 'entrada', hash_conteudo: hash,
    nonce, expira_em: new Date(Date.now() - 1000).toISOString(), assinatura_servidor: 'irrelevante-neste-teste',
  })
  const operacaoId = crypto.randomUUID()
  const payload = payloadAssinaturaEquipamento({ nonce, equipamentoId, usuarioId: usuario.id, operacaoId, tipo: 'entrada', hashConteudo: hash })
  const assinatura = assinar(privateKey, payload)

  await assert.rejects(
    () => registrarMarcacaoAssinada({ usuarioId: usuario.id, equipamentoId, nonce, operacaoId, tipo: 'entrada', hashConteudo: hash, assinaturaBase64: assinatura }),
    (err) => { assert.ok(err instanceof ErroEquipamento); assert.equal(err.codigoEquipamento, 'desafio_expirado'); return true }
  )
})

test('replay: reenviar a mesma assinatura/nonce depois de consumido é rejeitado', async () => {
  const { emitirDesafio, registrarMarcacaoAssinada, ErroEquipamento } = await import('../../../src/lib/ponto/equipamentoService.js')
  const { calcularHashConteudo, payloadAssinaturaEquipamento } = await import('../../../src/lib/ponto/assinaturaEquipamento.js')
  const { equipamentoId, privateKey } = await montarEquipamentoAssinante()

  const hash = calcularHashConteudo(Buffer.from('foto-fake-6'))
  const desafio = await emitirDesafio({ usuarioId: usuario.id, equipamentoId, tipo: 'entrada', hashConteudo: hash })
  const operacaoId1 = crypto.randomUUID()
  const payload = payloadAssinaturaEquipamento({ nonce: desafio.nonce, equipamentoId, usuarioId: usuario.id, operacaoId: operacaoId1, tipo: 'entrada', hashConteudo: hash })
  const assinatura = assinar(privateKey, payload)

  const primeira = await registrarMarcacaoAssinada({ usuarioId: usuario.id, equipamentoId, nonce: desafio.nonce, operacaoId: operacaoId1, tipo: 'entrada', hashConteudo: hash, assinaturaBase64: assinatura, fotoId: await criarFotoDeTeste() })
  assert.equal(primeira.resultado, 'registrada_agora')

  // Replay com operacao_id DIFERENTE (tentando reaproveitar o nonce pra uma segunda marcação).
  const operacaoId2 = crypto.randomUUID()
  const payload2 = payloadAssinaturaEquipamento({ nonce: desafio.nonce, equipamentoId, usuarioId: usuario.id, operacaoId: operacaoId2, tipo: 'entrada', hashConteudo: hash })
  const assinatura2 = assinar(privateKey, payload2)
  await assert.rejects(
    () => registrarMarcacaoAssinada({ usuarioId: usuario.id, equipamentoId, nonce: desafio.nonce, operacaoId: operacaoId2, tipo: 'entrada', hashConteudo: hash, assinaturaBase64: assinatura2 }),
    (err) => { assert.ok(err instanceof ErroEquipamento); assert.equal(err.codigoEquipamento, 'desafio_ja_usado'); return true }
  )
})

test('recuperação após timeout: mesmo operacao_id devolve a marcação já registrada, idempotente', async () => {
  const { emitirDesafio, registrarMarcacaoAssinada } = await import('../../../src/lib/ponto/equipamentoService.js')
  const { calcularHashConteudo, payloadAssinaturaEquipamento } = await import('../../../src/lib/ponto/assinaturaEquipamento.js')
  const { equipamentoId, privateKey } = await montarEquipamentoAssinante()

  const hash = calcularHashConteudo(Buffer.from('foto-fake-7'))
  const desafio = await emitirDesafio({ usuarioId: usuario.id, equipamentoId, tipo: 'entrada', hashConteudo: hash })
  const operacaoId = crypto.randomUUID()
  const payload = payloadAssinaturaEquipamento({ nonce: desafio.nonce, equipamentoId, usuarioId: usuario.id, operacaoId, tipo: 'entrada', hashConteudo: hash })
  const assinatura = assinar(privateKey, payload)

  const fotoId = await criarFotoDeTeste()
  const primeira = await registrarMarcacaoAssinada({ usuarioId: usuario.id, equipamentoId, nonce: desafio.nonce, operacaoId, tipo: 'entrada', hashConteudo: hash, assinaturaBase64: assinatura, fotoId })
  // Simula timeout de rede: cliente nunca viu a resposta, tenta de novo com o MESMO operacao_id
  // (mesmo endpoint, mesmos dados — é exatamente o que um retry de timeout faria).
  const segunda = await registrarMarcacaoAssinada({ usuarioId: usuario.id, equipamentoId, nonce: desafio.nonce, operacaoId, tipo: 'entrada', hashConteudo: hash, assinaturaBase64: assinatura, fotoId })
  assert.equal(segunda.resultado, 'ja_registrada_antes')
  assert.equal(segunda.marcacao_id, primeira.marcacao_id)

  const { count } = await supabase.from('ponto_marcacoes').select('id', { count: 'exact', head: true }).eq('operacao_id', operacaoId)
  assert.equal(count, 1, 'nunca deve duplicar a marcação num retry de mesmo operacao_id')
})

// Correção estrutural (revisão de 2026-09-12): antes desta correção, reenviar
// o MESMO operacao_id com um TIPO diferente devolvia silenciosamente a
// marcação antiga com status 200/"ja_registrada_antes" — exatamente o tipo
// de "aceitar um payload diferente sob a mesma chave de idempotência" que a
// especificação (seção 2.3) proíbe explicitamente para /solicitacoes, mas
// que nunca tinha sido replicado aqui (POST /marcacoes real, hoje
// inatingível via HTTP, mas testado direto na camada de serviço).
test('idempotência: mesmo operacao_id com tipo DIFERENTE é conflito, nunca devolve a marcação antiga como se fosse a nova', async () => {
  const { emitirDesafio, registrarMarcacaoAssinada, ErroEquipamento } = await import('../../../src/lib/ponto/equipamentoService.js')
  const { calcularHashConteudo, payloadAssinaturaEquipamento } = await import('../../../src/lib/ponto/assinaturaEquipamento.js')
  const { equipamentoId, privateKey } = await montarEquipamentoAssinante()

  const hash1 = calcularHashConteudo(Buffer.from('foto-fake-conflito-1'))
  const desafio1 = await emitirDesafio({ usuarioId: usuario.id, equipamentoId, tipo: 'entrada', hashConteudo: hash1 })
  const operacaoId = crypto.randomUUID()
  const payload1 = payloadAssinaturaEquipamento({ nonce: desafio1.nonce, equipamentoId, usuarioId: usuario.id, operacaoId, tipo: 'entrada', hashConteudo: hash1 })
  const assinatura1 = assinar(privateKey, payload1)

  const primeira = await registrarMarcacaoAssinada({ usuarioId: usuario.id, equipamentoId, nonce: desafio1.nonce, operacaoId, tipo: 'entrada', hashConteudo: hash1, assinaturaBase64: assinatura1, fotoId: await criarFotoDeTeste() })
  assert.equal(primeira.resultado, 'registrada_agora')
  assert.equal(primeira.tipo, 'entrada')

  // Mesmo operacao_id, tipo diferente ('saida') — precisa de um desafio novo
  // (o primeiro já foi consumido), mas a MESMA operacao_id de antes.
  const hash2 = calcularHashConteudo(Buffer.from('foto-fake-conflito-2'))
  const desafio2 = await emitirDesafio({ usuarioId: usuario.id, equipamentoId, tipo: 'saida', hashConteudo: hash2 })
  const payload2 = payloadAssinaturaEquipamento({ nonce: desafio2.nonce, equipamentoId, usuarioId: usuario.id, operacaoId, tipo: 'saida', hashConteudo: hash2 })
  const assinatura2 = assinar(privateKey, payload2)
  const fotoId2 = await criarFotoDeTeste()

  await assert.rejects(
    () => registrarMarcacaoAssinada({ usuarioId: usuario.id, equipamentoId, nonce: desafio2.nonce, operacaoId, tipo: 'saida', hashConteudo: hash2, assinaturaBase64: assinatura2, fotoId: fotoId2 }),
    (err) => { assert.ok(err instanceof ErroEquipamento); assert.equal(err.codigoEquipamento, 'operacao_id_conteudo_diferente'); assert.equal(err.status, 409); return true }
  )

  const { data: marcacoes } = await supabase.from('ponto_marcacoes').select('id, tipo').eq('operacao_id', operacaoId)
  assert.equal(marcacoes.length, 1, 'a tentativa com tipo diferente nunca cria uma segunda linha')
  assert.equal(marcacoes[0].tipo, 'entrada', 'a marcação original nunca é substituída/reinterpretada')
})

test('duas tentativas simultâneas com o mesmo nonce: só uma vence', async () => {
  const { emitirDesafio, registrarMarcacaoAssinada } = await import('../../../src/lib/ponto/equipamentoService.js')
  const { calcularHashConteudo, payloadAssinaturaEquipamento } = await import('../../../src/lib/ponto/assinaturaEquipamento.js')
  const { equipamentoId, privateKey } = await montarEquipamentoAssinante()

  const hash = calcularHashConteudo(Buffer.from('foto-fake-8'))
  const desafio = await emitirDesafio({ usuarioId: usuario.id, equipamentoId, tipo: 'entrada', hashConteudo: hash })

  // Duas operações DIFERENTES tentando consumir o MESMO nonce ao mesmo tempo
  // (ex.: duplo clique disparando duas requisições concorrentes antes da
  // primeira UI travar o botão).
  const opA = crypto.randomUUID()
  const opB = crypto.randomUUID()
  const payloadA = payloadAssinaturaEquipamento({ nonce: desafio.nonce, equipamentoId, usuarioId: usuario.id, operacaoId: opA, tipo: 'entrada', hashConteudo: hash })
  const payloadB = payloadAssinaturaEquipamento({ nonce: desafio.nonce, equipamentoId, usuarioId: usuario.id, operacaoId: opB, tipo: 'entrada', hashConteudo: hash })
  const assinaturaA = assinar(privateKey, payloadA)
  const assinaturaB = assinar(privateKey, payloadB)

  const [fotoIdA, fotoIdB] = await Promise.all([criarFotoDeTeste(), criarFotoDeTeste()])
  const resultados = await Promise.allSettled([
    registrarMarcacaoAssinada({ usuarioId: usuario.id, equipamentoId, nonce: desafio.nonce, operacaoId: opA, tipo: 'entrada', hashConteudo: hash, assinaturaBase64: assinaturaA, fotoId: fotoIdA }),
    registrarMarcacaoAssinada({ usuarioId: usuario.id, equipamentoId, nonce: desafio.nonce, operacaoId: opB, tipo: 'entrada', hashConteudo: hash, assinaturaBase64: assinaturaB, fotoId: fotoIdB }),
  ])

  const sucessos = resultados.filter((r) => r.status === 'fulfilled')
  const falhas = resultados.filter((r) => r.status === 'rejected')
  assert.equal(sucessos.length, 1, 'exatamente uma das duas tentativas concorrentes deve vencer')
  assert.equal(falhas.length, 1)
})

test('equipamento revogado: assinatura válida é rejeitada mesmo assim', async () => {
  const { emitirDesafio, registrarMarcacaoAssinada, ErroEquipamento } = await import('../../../src/lib/ponto/equipamentoService.js')
  const { calcularHashConteudo, payloadAssinaturaEquipamento } = await import('../../../src/lib/ponto/assinaturaEquipamento.js')
  const { equipamentoId, privateKey } = await montarEquipamentoAssinante()

  const hash = calcularHashConteudo(Buffer.from('foto-fake-9'))
  const desafio = await emitirDesafio({ usuarioId: usuario.id, equipamentoId, tipo: 'entrada', hashConteudo: hash })
  await revogarEquipamentoDeTeste(equipamentoId)

  const operacaoId = crypto.randomUUID()
  const payload = payloadAssinaturaEquipamento({ nonce: desafio.nonce, equipamentoId, usuarioId: usuario.id, operacaoId, tipo: 'entrada', hashConteudo: hash })
  const assinatura = assinar(privateKey, payload)

  await assert.rejects(
    () => registrarMarcacaoAssinada({ usuarioId: usuario.id, equipamentoId, nonce: desafio.nonce, operacaoId, tipo: 'entrada', hashConteudo: hash, assinaturaBase64: assinatura }),
    (err) => { assert.ok(err instanceof ErroEquipamento); assert.equal(err.codigoEquipamento, 'equipamento_invalido_ou_revogado'); return true }
  )
})

test('emitirDesafio recusa equipamento revogado antes mesmo de gerar o nonce', async () => {
  const { emitirDesafio, ErroEquipamento } = await import('../../../src/lib/ponto/equipamentoService.js')
  const { calcularHashConteudo } = await import('../../../src/lib/ponto/assinaturaEquipamento.js')
  const { equipamentoId } = await montarEquipamentoAssinante()
  await revogarEquipamentoDeTeste(equipamentoId)

  await assert.rejects(
    () => emitirDesafio({ usuarioId: usuario.id, equipamentoId, tipo: 'entrada', hashConteudo: calcularHashConteudo(Buffer.from('x')) }),
    (err) => { assert.ok(err instanceof ErroEquipamento); assert.equal(err.codigoEquipamento, 'equipamento_invalido_ou_revogado'); return true }
  )
})

test('usuário desativado: assinatura válida é rejeitada (revalidado fresco dentro da função SQL)', async () => {
  const { emitirDesafio, registrarMarcacaoAssinada, ErroEquipamento } = await import('../../../src/lib/ponto/equipamentoService.js')
  const { calcularHashConteudo, payloadAssinaturaEquipamento } = await import('../../../src/lib/ponto/assinaturaEquipamento.js')
  const { equipamentoId, privateKey } = await montarEquipamentoAssinante()

  const hash = calcularHashConteudo(Buffer.from('foto-fake-10'))
  const desafio = await emitirDesafio({ usuarioId: usuario.id, equipamentoId, tipo: 'entrada', hashConteudo: hash })
  await definirHabilitacaoDeTeste(usuario.id, true) // garante habilitação continua ok — o que muda é usuarios.ativo
  await supabase.from('usuarios').update({ ativo: false }).eq('id', usuario.id)

  try {
    const operacaoId = crypto.randomUUID()
    const payload = payloadAssinaturaEquipamento({ nonce: desafio.nonce, equipamentoId, usuarioId: usuario.id, operacaoId, tipo: 'entrada', hashConteudo: hash })
    const assinatura = assinar(privateKey, payload)

    await assert.rejects(
      () => registrarMarcacaoAssinada({ usuarioId: usuario.id, equipamentoId, nonce: desafio.nonce, operacaoId, tipo: 'entrada', hashConteudo: hash, assinaturaBase64: assinatura }),
      (err) => { assert.ok(err instanceof ErroEquipamento); assert.equal(err.codigoEquipamento, 'usuario_invalido_ou_inativo'); return true }
    )
  } finally {
    await supabase.from('usuarios').update({ ativo: true }).eq('id', usuario.id)
  }
})

test('piloto desativado: assinatura válida é rejeitada mesmo assim', async () => {
  const { emitirDesafio, registrarMarcacaoAssinada, ErroEquipamento } = await import('../../../src/lib/ponto/equipamentoService.js')
  const { calcularHashConteudo, payloadAssinaturaEquipamento } = await import('../../../src/lib/ponto/assinaturaEquipamento.js')
  const { equipamentoId, privateKey } = await montarEquipamentoAssinante()

  const hash = calcularHashConteudo(Buffer.from('foto-fake-11'))
  const desafio = await emitirDesafio({ usuarioId: usuario.id, equipamentoId, tipo: 'entrada', hashConteudo: hash })
  await definirPilotoAtivoDeTeste(false)

  try {
    const operacaoId = crypto.randomUUID()
    const payload = payloadAssinaturaEquipamento({ nonce: desafio.nonce, equipamentoId, usuarioId: usuario.id, operacaoId, tipo: 'entrada', hashConteudo: hash })
    const assinatura = assinar(privateKey, payload)

    await assert.rejects(
      () => registrarMarcacaoAssinada({ usuarioId: usuario.id, equipamentoId, nonce: desafio.nonce, operacaoId, tipo: 'entrada', hashConteudo: hash, assinaturaBase64: assinatura }),
      (err) => { assert.ok(err instanceof ErroEquipamento); assert.equal(err.codigoEquipamento, 'piloto_desativado'); return true }
    )
  } finally {
    await definirPilotoAtivoDeTeste(true)
  }
})

test('falha de banco (trigger real) durante o insert: nonce NÃO fica consumido (rollback atômico)', async () => {
  const { emitirDesafio, registrarMarcacaoAssinada } = await import('../../../src/lib/ponto/equipamentoService.js')
  const { calcularHashConteudo, payloadAssinaturaEquipamento } = await import('../../../src/lib/ponto/assinaturaEquipamento.js')
  const { equipamentoId, privateKey } = await montarEquipamentoAssinante()

  const hash = calcularHashConteudo(Buffer.from('foto-fake-12'))
  const desafio = await emitirDesafio({ usuarioId: usuario.id, equipamentoId, tipo: 'entrada', hashConteudo: hash })
  const operacaoId = crypto.randomUUID()
  const payload = payloadAssinaturaEquipamento({ nonce: desafio.nonce, equipamentoId, usuarioId: usuario.id, operacaoId, tipo: 'entrada', hashConteudo: hash })
  const assinatura = assinar(privateKey, payload)

  instalarFalhaForcadaDeInsert('ponto_marcacoes')
  try {
    await assert.rejects(() => registrarMarcacaoAssinada({ usuarioId: usuario.id, equipamentoId, nonce: desafio.nonce, operacaoId, tipo: 'entrada', hashConteudo: hash, assinaturaBase64: assinatura }))
  } finally {
    removerFalhaForcadaDeInsert('ponto_marcacoes')
  }

  const { data } = await supabase.from('ponto_desafios').select('usado_em').eq('nonce', desafio.nonce).single()
  assert.equal(data.usado_em, null, 'a transação inteira (consumo do nonce + insert) deve reverter junto — nunca fica "meio feita"')

  const { count } = await supabase.from('ponto_marcacoes').select('id', { count: 'exact', head: true }).eq('operacao_id', operacaoId)
  assert.equal(count, 0)
})

test('GRANT/REVOKE reais: papel restrito sem GRANT não executa a função nova; com GRANT+privilégios de tabela, executa', async () => {
  const papel = 'ponto_teste_equip_restrito'
  const senha = 'senhaTesteRestrita123'
  await criarPapelPostgresDeTeste(papel, senha)
  try {
    const { emitirDesafio } = await import('../../../src/lib/ponto/equipamentoService.js')
    const { calcularHashConteudo, payloadAssinaturaEquipamento } = await import('../../../src/lib/ponto/assinaturaEquipamento.js')
    const { equipamentoId, privateKey } = await montarEquipamentoAssinante()
    const hash = calcularHashConteudo(Buffer.from('foto-fake-13'))
    const desafio = await emitirDesafio({ usuarioId: usuario.id, equipamentoId, tipo: 'entrada', hashConteudo: hash })
    const operacaoId = crypto.randomUUID()
    const payload = payloadAssinaturaEquipamento({ nonce: desafio.nonce, equipamentoId, usuarioId: usuario.id, operacaoId, tipo: 'entrada', hashConteudo: hash })
    const assinatura = assinar(privateKey, payload)

    const assinaturaFuncao = 'ponto_registrar_marcacao_assinada(text, uuid, uuid, uuid, text, text, uuid, inet, boolean, text)'
    const fotoId = await criarFotoDeTeste()
    const args = [desafio.nonce, equipamentoId, usuario.id, operacaoId, 'entrada', hash, fotoId, null, false, null]
    const sql = `SELECT * FROM ponto_registrar_marcacao_assinada($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`

    const semGrant = await executarComoPapelDeTeste({ papel, senha, sql, params: args })
    assert.ok(semGrant.erro, 'sem GRANT nenhum, a chamada direta deveria falhar')
    assert.equal(semGrant.erro.code, '42501') // insufficient_privilege

    await concederExecucaoDeTeste(papel, assinaturaFuncao)
    await concederAcessoTabelasPontoDeTeste(papel)

    const comGrant = await executarComoPapelDeTeste({ papel, senha, sql, params: args })
    assert.equal(comGrant.erro, null, 'com GRANT + privilégios de tabela equivalentes a service_role, deveria executar')
    assert.equal(comGrant.rows[0].resultado, 'registrada_agora')
  } finally {
    await apagarPapelPostgresDeTeste(papel)
  }
})
