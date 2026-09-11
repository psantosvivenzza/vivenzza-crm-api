// Helper compartilhado dos testes de integração do módulo "Meu Ponto".
// Aponta o processo pro Postgres isolado de teste ANTES de qualquer import
// de código de produção — supabase-admin.server.js decide client real vs.
// compat local na primeira importação (mesma regra dos testes de cobrança,
// scripts/tests/collection/_setup.mjs).
import path from 'path'
import { fileURLToPath } from 'url'
import http from 'http'
import bcrypt from 'bcryptjs'
import { execFileSync } from 'child_process'
import pg from 'pg'
import { PSQL_BIN } from '../../localdb-config.mjs'
import { PONTO_TEST_LOCAL_PG_URL, PONTO_TEST_PG_HOST, PONTO_TEST_PG_PORT, PONTO_TEST_PG_DATABASE, PONTO_TEST_PG_USER, PONTO_TEST_PG_PASSWORD } from './_config.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

process.env.NODE_ENV = 'test'
process.env.LOCAL_PG_URL = PONTO_TEST_LOCAL_PG_URL
process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-teste-meu-ponto-nao-e-producao'
// Bytes de foto de teste vão pra dentro do worktree, nunca pro Storage real
// (ver src/lib/ponto/fotoStorage.js — usaArmazenamentoLocal()).
process.env.PONTO_FOTOS_LOCAL_DIR = process.env.PONTO_FOTOS_LOCAL_DIR
  || path.join(__dirname, '..', '..', '..', '.localdev', 'ponto-fotos-teste')

let servidor = null
let porta = null
let supabaseRef = null
let jwt = null

export async function subirServidorDeTeste() {
  if (servidor) return { porta }

  const expressModule = await import('express')
  const express = expressModule.default
  jwt = (await import('jsonwebtoken')).default
  const { auth, adminOnly } = await import('../../../src/middleware/auth.js')
  const { exigirGestorOuAdmin, exigirUsuarioAtivo } = await import('../../../src/middleware/pontoAuth.js')
  const pontoRouter = (await import('../../../src/routes/ponto.js')).default
  const pontoGestaoRouter = (await import('../../../src/routes/ponto-gestao.js')).default
  const pontoAdminRouter = (await import('../../../src/routes/ponto-admin.js')).default
  const pontoEquipamentoRouter = (await import('../../../src/routes/ponto-equipamento.js')).default
  ;({ supabase: supabaseRef } = await import('../../../src/lib/supabase-admin.server.js'))

  const app = express()
  app.use(express.json({ limit: '10mb' }))
  // Mesmo mount de src/index.js — exigirUsuarioAtivo nos três routers,
  // nunca só nas rotas de decisão (ver comentário em index.js).
  app.use('/api/ponto', auth, exigirUsuarioAtivo, pontoRouter)
  app.use('/api/ponto-gestao', auth, exigirUsuarioAtivo, exigirGestorOuAdmin, pontoGestaoRouter)
  app.use('/api/ponto-admin', auth, exigirUsuarioAtivo, adminOnly, pontoAdminRouter)
  // Mesmo mount de src/index.js — sem auth de propósito, ver comentário lá.
  app.use('/api/ponto-equipamento', pontoEquipamentoRouter)

  servidor = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  porta = servidor.address().port
  return { porta }
}

export async function pararServidorDeTeste() {
  if (servidor) {
    await new Promise((resolve) => servidor.close(resolve))
    servidor = null
    porta = null
  }
}

export function obterSupabaseDeTeste() {
  return supabaseRef
}

export function gerarToken(usuario) {
  return jwt.sign({ id: usuario.id, email: usuario.email, role: usuario.role, nome: usuario.nome }, process.env.JWT_SECRET)
}

export function chamar(method, caminho, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {}
    if (token) headers.authorization = `Bearer ${token}`
    let payload = null
    if (body !== undefined) {
      payload = JSON.stringify(body)
      headers['content-type'] = 'application/json'
    }
    const req = http.request({ host: '127.0.0.1', port: porta, method, path: caminho, headers }, (res) => {
      let chunks = ''
      res.on('data', (c) => { chunks += c })
      res.on('end', () => resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null }))
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

let contador = 0
export async function criarUsuarioDeTeste(overrides = {}) {
  const supabase = obterSupabaseDeTeste()
  contador += 1
  const sufixo = `${Date.now()}-${contador}`
  const senha = overrides.senha || 'senhaTesteMeuPonto123'
  const senha_hash = await bcrypt.hash(senha, 4) // custo baixo — só em teste
  const { data, error } = await supabase
    .from('usuarios')
    .insert({
      nome: overrides.nome || `Usuário Teste Ponto ${sufixo}`,
      email: overrides.email || `ponto-teste-${sufixo}@example.invalid`,
      role: overrides.role || 'vendedor',
      ativo: overrides.ativo ?? true,
      senha_hash,
    })
    .select('id, nome, email, role')
    .single()
  if (error) throw error
  return { ...data, senha }
}

export async function habilitarPontoDeTeste(usuarioId, habilitado = true) {
  const supabase = obterSupabaseDeTeste()
  const { error } = await supabase.from('ponto_habilitacoes').insert({ usuario_id: usuarioId, habilitado })
  if (error) throw error
}

export async function definirPilotoAtivoDeTeste(ativo) {
  const supabase = obterSupabaseDeTeste()
  const { error } = await supabase.from('ponto_config').update({ piloto_ativo: ativo }).eq('id', true)
  if (error) throw error
}

export async function concederEscopoGestorDeTeste({ gestorId, colaboradorId, concedidoPor }) {
  const supabase = obterSupabaseDeTeste()
  const { error } = await supabase
    .from('ponto_gestores')
    .insert({ gestor_usuario_id: gestorId, colaborador_usuario_id: colaboradorId, concedido_por: concedidoPor || gestorId })
  if (error) throw error
}

// ponto_marcacoes.origem_solicitacao_id/origem_correcao_id e
// ponto_solicitacoes_marcacao/ponto_correcoes.marcacao_gerada_id apontam um
// pro outro (a mesma solicitação/correção e a mesma marcação gerada se
// referenciam mutuamente) — FK real dos dois lados (migration 050,
// corrigido na revisão de 2026-09-11: a integridade não foi enfraquecida
// pra resolver isso, só a ordem de limpeza). Pra apagar fixtures de teste
// sem violar nenhuma das duas FKs, zera primeiro o lado
// solicitação/correção -> marcação (marcacao_gerada_id), depois apaga
// marcações, depois solicitações/correções.
export async function limparVinculosCircularesDeTeste(usuarioIds) {
  const supabase = obterSupabaseDeTeste()
  await supabase.from('ponto_solicitacoes_marcacao').update({ marcacao_gerada_id: null }).in('usuario_id', usuarioIds)
  await supabase.from('ponto_correcoes').update({ marcacao_gerada_id: null }).in('usuario_id', usuarioIds)
}

export async function definirHabilitacaoDeTeste(usuarioId, habilitado) {
  const supabase = obterSupabaseDeTeste()
  const { error } = await supabase.from('ponto_habilitacoes').update({ habilitado }).eq('usuario_id', usuarioId)
  if (error) throw error
}

export async function revogarEscopoGestorDeTeste({ gestorId, colaboradorId }) {
  const supabase = obterSupabaseDeTeste()
  const { error } = await supabase
    .from('ponto_gestores')
    .update({ revogado_em: new Date().toISOString() })
    .eq('gestor_usuario_id', gestorId)
    .eq('colaborador_usuario_id', colaboradorId)
    .is('revogado_em', null)
  if (error) throw error
}

// Roda SQL direto via psql contra o cluster isolado de teste — usado só
// pelos helpers de gatilho de falha forçada abaixo (execFileSync, mesmo
// padrão de scripts/tests/collection/usuarios-role-check-constraint.test.mjs).
function psqlDeTeste(sql) {
  return execFileSync(PSQL_BIN, [
    '-U', PONTO_TEST_PG_USER, '-h', PONTO_TEST_PG_HOST, '-p', String(PONTO_TEST_PG_PORT), '-d', PONTO_TEST_PG_DATABASE,
    '-v', 'ON_ERROR_STOP=1', '-c', sql,
  ], { env: { ...process.env, PGPASSWORD: PONTO_TEST_PG_PASSWORD }, encoding: 'utf8' })
}

// Instala um gatilho BEFORE INSERT que sempre falha numa tabela — usado só
// para provar, com uma falha REAL do Postgres (não simulada em JS), que uma
// falha parcial entre upload de foto e persistência da marcação/solicitação
// é tratada explicitamente (sem falso sucesso), nunca escondida.
export function instalarFalhaForcadaDeInsert(tabela) {
  const nomeGatilho = `falha_forcada_teste_${tabela}`
  psqlDeTeste(`
    CREATE OR REPLACE FUNCTION ponto_teste_falhar_insert() RETURNS trigger AS $f$
    BEGIN RAISE EXCEPTION 'falha_forcada_teste'; END;
    $f$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS ${nomeGatilho} ON ${tabela};
    CREATE TRIGGER ${nomeGatilho} BEFORE INSERT ON ${tabela}
      FOR EACH ROW EXECUTE FUNCTION ponto_teste_falhar_insert();
  `)
}

export function removerFalhaForcadaDeInsert(tabela) {
  const nomeGatilho = `falha_forcada_teste_${tabela}`
  psqlDeTeste(`DROP TRIGGER IF EXISTS ${nomeGatilho} ON ${tabela};`)
}

// FFD8FF é a assinatura real de JPEG — o suficiente pra passar em
// validarFotoBuffer() (que só confere os bytes iniciais, não decodifica a
// imagem). Não é uma foto de verdade nem precisa ser: nenhum teste coleta
// foto de funcionário real (ver seção 10 da especificação).
export function fotoSinteticaBase64({ tamanhoBytes = 200 } = {}) {
  const cabecalho = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
  const recheio = Buffer.alloc(Math.max(0, tamanhoBytes - cabecalho.length - 2), 0)
  const rodape = Buffer.from([0xff, 0xd9])
  return Buffer.concat([cabecalho, recheio, rodape]).toString('base64')
}

// --- Helpers pra provar autorização no banco com papel RESTRITO, não só
// com o superusuário (postgres) que o resto dos testes usa via
// pgCompatClient. Necessário porque um superusuário do Postgres ignora
// TODO grant/revoke — testar só como postgres nunca provaria que
// REVOKE/GRANT (migration 051) realmente bloqueiam quem não deveria
// executar as funções de decisão. Papéis são criados/apagados só no
// cluster de teste isolado, nunca em produção.

export async function criarPapelPostgresDeTeste(nome, senha) {
  psqlDeTeste(`DROP ROLE IF EXISTS ${nome}; CREATE ROLE ${nome} LOGIN PASSWORD '${senha}';`)
}

// DROP ROLE sozinho falha se o papel ainda detém algum privilégio (GRANT
// concedido a ele) — DROP OWNED BY primeiro garante que a limpeza sempre
// remove o papel de teste, mesmo depois de concederExecucaoDeTeste/
// concederAcessoTabelasPontoDeTeste. DROP OWNED BY exige que o papel
// exista, por isso o bloco condicional.
export async function apagarPapelPostgresDeTeste(nome) {
  psqlDeTeste(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${nome}') THEN
        EXECUTE 'DROP OWNED BY ${nome}';
        EXECUTE 'DROP ROLE ${nome}';
      END IF;
    END $$;
  `)
}

export async function concederExecucaoDeTeste(nome, assinaturaFuncao) {
  psqlDeTeste(`GRANT EXECUTE ON FUNCTION ${assinaturaFuncao} TO ${nome};`)
}

// As funções de decisão são SECURITY INVOKER (deliberado — nunca elevar
// privilégio; ver migration 051) — então o PAPEL chamador precisa também
// de acesso direto às tabelas que a função toca, não só EXECUTE na
// função. Em produção real, `service_role` já tem esse acesso amplo por
// padrão do Supabase (é o papel de confiança do backend, ignora RLS). Este
// helper simula esse mesmo perfil de privilégio num papel de teste — não é
// "enfraquecer" nada, é reproduzir fielmente o que o chamador real (o
// próprio backend) já tem.
export async function concederAcessoTabelasPontoDeTeste(nome) {
  psqlDeTeste(`
    GRANT SELECT ON public.usuarios, public.ponto_gestores, public.ponto_config TO ${nome};
    GRANT SELECT, INSERT, UPDATE ON public.ponto_marcacoes, public.ponto_solicitacoes_marcacao, public.ponto_correcoes TO ${nome};
    GRANT SELECT, UPDATE ON public.ponto_desafios TO ${nome};
    GRANT SELECT, UPDATE ON public.ponto_equipamentos TO ${nome};
  `)
}

// Conecta como o papel restrito informado (não o superusuário) e roda a
// query — usado pra provar, com uma conexão de verdade autenticada como
// esse papel, que EXECUTE é ou não permitido.
export async function executarComoPapelDeTeste({ papel, senha, sql, params = [] }) {
  const client = new pg.Client({
    host: PONTO_TEST_PG_HOST,
    port: PONTO_TEST_PG_PORT,
    database: PONTO_TEST_PG_DATABASE,
    user: papel,
    password: senha,
  })
  await client.connect()
  try {
    const res = await client.query(sql, params)
    return { rows: res.rows, erro: null }
  } catch (err) {
    return { rows: null, erro: { message: err.message, code: err.code } }
  } finally {
    await client.end()
  }
}

// --- Helpers do componente de equipamento (rodada de 2026-09-11) ---

export async function criarEquipamentoDeTeste({ usuarioId, cadastradoPor, identificador }) {
  const supabase = obterSupabaseDeTeste()
  contador += 1
  const { data, error } = await supabase
    .from('ponto_equipamentos')
    .insert({
      usuario_id: usuarioId,
      identificador: identificador || `Equipamento Teste ${Date.now()}-${contador}`,
      modo: 'demonstracao',
      cadastrado_por: cadastradoPor,
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id
}

// Cadastra a chave pública DIRETO no banco (chave ECDSA P-256 gerada em
// Node, não via CNG) — usado pela maioria dos cenários exaustivos, que
// testam o MECANISMO do lado do servidor (assinatura/desafio/atomicidade),
// não o caminho Windows/CNG em si. O caminho CNG real (TPM e software) é
// validado separadamente, com o serviço local de verdade — ver
// scripts/tests/ponto/componente-windows-real.test.mjs (requer Windows +
// PowerShell, pulado automaticamente fora desse ambiente).
export async function vincularEquipamentoDeTesteComChaveNode({ equipamentoId, chaveHardwareBacked = false }) {
  const crypto = await import('node:crypto')
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = publicKey.export({ format: 'jwk' })
  const { gerarSegredoHmacBase64 } = await import('../../../src/lib/ponto/assinaturaEquipamento.js')
  const segredoHmac = gerarSegredoHmacBase64()

  const supabase = obterSupabaseDeTeste()
  const { error } = await supabase
    .from('ponto_equipamentos')
    .update({
      chave_publica_jwk: jwk,
      chave_hardware_backed: chaveHardwareBacked,
      desafio_hmac_secret: segredoHmac,
      modo: 'producao',
      vinculado_em: new Date().toISOString(),
    })
    .eq('id', equipamentoId)
  if (error) throw error

  return { privateKey, publicJwk: jwk }
}

export async function revogarEquipamentoDeTeste(equipamentoId) {
  const supabase = obterSupabaseDeTeste()
  const { error } = await supabase
    .from('ponto_equipamentos')
    .update({ status: 'revogado', revogado_em: new Date().toISOString() })
    .eq('id', equipamentoId)
  if (error) throw error
}
