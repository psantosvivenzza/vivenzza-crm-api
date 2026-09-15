// Auditoria adversarial de 2026-09-12 (abuso/rate limiting/reautenticação) —
// achado: POST /api/ponto/correcoes era a ÚNICA mutação sensível de
// src/routes/ponto.js sem NENHUM limite de taxa, diferente de
// /desafios, /marcacoes e /solicitacoes (todas com `limiteTentativasSensiveis`,
// 8/5min por usuário). Um colaborador habilitado conseguia gerar volume
// ilimitado de solicitações de correção (cada uma com operacao_id novo, o
// que basta pra não colidir com a idempotência de operacao_id) — inundando
// a fila de revisão do gestor e a tabela ponto_correcoes, sem qualquer
// contenção. Ver docs/meu-ponto/MATRIZ_AUTORIZACAO_ENDPOINTS.md (linha de
// POST /correcoes tinha "Trava adicional" vazia, ao contrário de
// POST /solicitacoes).
//
// Este arquivo prova (contra o Postgres isolado real, não mock):
// 1. depois de 8 tentativas em 5min, a 9ª e seguintes voltam 429;
// 2. a chave é por usuário, não por IP — dois colaboradores diferentes
//    batendo do mesmo processo de teste (mesmo IP local) têm orçamentos
//    INDEPENDENTES, exatamente como limiteTentativasSensiveis já garante
//    para /marcacoes e /solicitacoes;
// 3. o novo limitador não compartilha contador com limiteTentativasSensiveis
//    — esgotar o limite de /correcoes não bloqueia /solicitacoes do mesmo
//    usuário, e vice-versa (são orçamentos propositalmente separados: ver
//    comentário no código);
// 4. sob rajada CONCORRENTE real (Promise.all, não sequencial), o total de
//    sucessos nunca excede o teto de 8 — descarta uma corrida no próprio
//    contador do limitador que permitisse passar do máximo.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  subirServidorDeTeste, pararServidorDeTeste, obterSupabaseDeTeste,
  gerarToken, chamar, criarUsuarioDeTeste, habilitarPontoDeTeste,
  definirPilotoAtivoDeTeste,
} from './_setup.mjs'

const criados = []

before(async () => {
  await subirServidorDeTeste()
  await definirPilotoAtivoDeTeste(true)
})

after(async () => {
  const supabase = obterSupabaseDeTeste()
  await supabase.from('ponto_correcoes').delete().in('usuario_id', criados)
  await supabase.from('ponto_solicitacoes_marcacao').delete().in('usuario_id', criados)
  await supabase.from('ponto_habilitacoes').delete().in('usuario_id', criados)
  await supabase.from('usuarios').delete().in('id', criados)
  await pararServidorDeTeste()
})

async function novoColaborador() {
  const usuario = await criarUsuarioDeTeste({ role: 'vendedor' })
  criados.push(usuario.id)
  await habilitarPontoDeTeste(usuario.id, true)
  return usuario
}

function corpoCorrecao(sufixo) {
  return {
    operacao_id: crypto.randomUUID(),
    tipo_solicitacao: 'outro',
    valor_proposto: { nota: `auditoria-rate-limit-${sufixo}` },
    justificativa: `auditoria adversarial ${sufixo}`,
  }
}

test('limite de tentativas: mais de 8 correções em 5 minutos para o mesmo usuário são bloqueadas (429)', async () => {
  const usuario = await novoColaborador()
  const respostas = []
  for (let i = 0; i < 10; i++) {
    respostas.push(await chamar('POST', '/api/ponto/correcoes', {
      token: gerarToken(usuario),
      body: corpoCorrecao(`seq-${i}`),
    }))
  }
  const bloqueadas = respostas.filter((r) => r.status === 429)
  const aceitas = respostas.filter((r) => r.status !== 429)
  assert.ok(bloqueadas.length > 0, 'pelo menos uma das 10 tentativas rápidas deveria bater no limite de 8/5min')
  assert.ok(aceitas.length <= 8, `no máximo 8 deveriam passar do limitador; passaram ${aceitas.length}`)
})

test('limite por usuário, não por IP: colaboradores diferentes têm orçamentos independentes', async () => {
  const usuarioA = await novoColaborador()
  const usuarioB = await novoColaborador()

  // Esgota o orçamento de A (mesmo IP de teste que B, já que ambos chamam
  // do mesmo processo local — o que importa é que a CHAVE usada pelo
  // limitador é req.user.id, nunca req.ip, quando o usuário está
  // autenticado, exatamente como limiteTentativasSensiveis já faz).
  for (let i = 0; i < 8; i++) {
    await chamar('POST', '/api/ponto/correcoes', { token: gerarToken(usuarioA), body: corpoCorrecao(`a-${i}`) })
  }
  const proximaDeA = await chamar('POST', '/api/ponto/correcoes', { token: gerarToken(usuarioA), body: corpoCorrecao('a-extra') })
  assert.equal(proximaDeA.status, 429, 'usuário A já deveria estar bloqueado depois de 8 tentativas')

  const primeiraDeB = await chamar('POST', '/api/ponto/correcoes', { token: gerarToken(usuarioB), body: corpoCorrecao('b-0') })
  assert.notEqual(primeiraDeB.status, 429, 'usuário B não deveria ser afetado pelo limite já consumido por A — orçamento é por usuário, não por IP')
})

test('orçamento de /correcoes é independente do orçamento de /solicitacoes (não compartilha contador com limiteTentativasSensiveis)', async () => {
  const usuario = await novoColaborador()

  // Esgota só o limitador de /correcoes.
  for (let i = 0; i < 8; i++) {
    await chamar('POST', '/api/ponto/correcoes', { token: gerarToken(usuario), body: corpoCorrecao(`iso-${i}`) })
  }
  const correcaoBloqueada = await chamar('POST', '/api/ponto/correcoes', { token: gerarToken(usuario), body: corpoCorrecao('iso-extra') })
  assert.equal(correcaoBloqueada.status, 429, '/correcoes deveria estar no limite para este usuário')

  // /solicitacoes usa limiteTentativasSensiveis, um contador SEPARADO — o
  // esgotamento de /correcoes não deve consumir nem bloquear esse outro
  // orçamento para o mesmo usuário.
  const solicitacaoAindaLivre = await chamar('POST', '/api/ponto/solicitacoes', {
    token: gerarToken(usuario),
    body: { operacao_id: crypto.randomUUID(), tipo: 'entrada', senha_atual: usuario.senha, justificativa: 'ainda livre' },
  })
  assert.notEqual(solicitacaoAindaLivre.status, 429, '/solicitacoes não deveria estar bloqueada só porque /correcoes esgotou seu próprio orçamento')
})

test('rajada concorrente real: 12 POST /correcoes simultâneos do mesmo usuário nunca deixam passar mais de 8', async () => {
  const usuario = await novoColaborador()
  const respostas = await Promise.all(
    Array.from({ length: 12 }, (_, i) => chamar('POST', '/api/ponto/correcoes', {
      token: gerarToken(usuario),
      body: corpoCorrecao(`concorrente-${i}`),
    }))
  )
  const aceitas = respostas.filter((r) => r.status !== 429)
  const bloqueadas = respostas.filter((r) => r.status === 429)
  assert.ok(aceitas.length <= 8, `sob concorrência real, no máximo 8 deveriam passar do limitador; passaram ${aceitas.length}`)
  assert.ok(bloqueadas.length >= 4, `pelo menos 4 das 12 chamadas concorrentes deveriam ser bloqueadas; foram ${bloqueadas.length}`)
})
