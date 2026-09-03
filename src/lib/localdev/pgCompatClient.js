// Compat client local — substitui @supabase/supabase-js SÓ em desenvolvimento/teste
// local (LOCAL_PG_URL definido), falando diretamente com Postgres via `pg` em vez
// de HTTP/PostgREST. Motivo: PostgREST não tem binário Windows funcional nesta
// máquina (erro de DLL ausente, ver docs/cobranca-ai/LOCAL_DEVELOPMENT.md) e montar
// o stack Docker completo do Supabase CLI não é viável sem Docker/WSL instalados.
//
// Cobre exatamente os métodos usados pelo código real deste projeto (auditado via
// grep em src/lib/collection + rotas relacionadas): select/eq/neq/in/gte/lte/gt/lt/
// not/order/range/limit/maybeSingle/single/insert/update/delete/rpc. NÃO é um
// PostgREST genérico — é um adaptador propositalmente estreito, então qualquer
// query nova fora desse padrão pode precisar de ajuste aqui (erro fica óbvio: método
// undefined).
//
// LIMITAÇÕES CONHECIDAS (documentadas, não são bugs — escopo deliberadamente
// estreito, auditado em 2026-08-12):
// - Embed de relacionamento (`'*, tabela(col1,col2)'`) só funciona pra UMA
//   relação hardcoded em EMBED_FK (collection_calls→contas_financeiras).
//   Qualquer outro embed é silenciosamente ignorado (sem erro).
// - Sem transação pública (BEGIN/COMMIT) — cada chamada é uma query isolada
//   via pool.query(). Atomicidade multi-tabela precisa de função Postgres
//   (rpc), igual ao padrão real do supabase-js.
// - Sem método .close()/.disconnect() dedicado — só _pool exposto pra quem
//   precisar encerrar manualmente; allowExitOnIdle cobre o caso comum de
//   deixar o processo de teste sair sozinho.
// - Adequado apenas ao test harness atual — não é um substituto geral do
//   Supabase real, só cobre o que os testes de cobrança precisam hoje.
//
// Produção NUNCA usa este arquivo — supabase-admin.server.js só importa isto quando
// LOCAL_PG_URL está definido, o que não deve acontecer no Railway.
import pg from 'pg'

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/

// node-postgres serializa array JS como array literal nativo do Postgres
// ("{a,b}") — correto para uma coluna array de verdade (ex:
// knowledge_embeddings.embedding, double precision[]), mas INVÁLIDO para uma
// coluna jsonb recebendo um array (produz "invalid input syntax for type json").
// Heurística: array de só números (o único caso real de array nativo neste
// schema é o embedding, sempre numérico) fica como array nativo; qualquer outro
// array (strings/objetos) ou objeto plano é jsonb → precisa de JSON.stringify
// explícito. Datas e primitivos passam direto.
function serializarValorParaColuna(v) {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v
  if (Array.isArray(v)) {
    const ehArrayNumerico = v.every((item) => typeof item === 'number')
    return ehArrayNumerico ? v : JSON.stringify(v)
  }
  if (typeof v === 'object') return JSON.stringify(v)
  return v
}

function assertIdent(name, kind = 'identificador') {
  if (!IDENT_RE.test(name)) throw new Error(`${kind} inválido para o compat client local: ${name}`)
  return name
}

// Mapa mínimo de relacionamentos para suportar a sintaxe de embed do PostgREST
// (`'*, tabela(col1, col2)'`) nos poucos lugares do código de cobrança que usam
// isso. Adicionar aqui se um novo embed for necessário.
const EMBED_FK = {
  collection_calls: { contas_financeiras: 'contas_financeiras_id' },
}

function parseSelect(cols) {
  if (!cols || cols === '*') return { main: '*', embeds: [] }
  const embeds = []
  // Remove blocos "tabela(col1, col2)" do texto principal, guardando separadamente.
  const main = cols.replace(/(\w+)\(([^)]+)\)/g, (_, tabela, colsInternas) => {
    embeds.push({ tabela, cols: colsInternas.split(',').map((c) => c.trim()) })
    return ''
  }).split(',').map((c) => c.trim()).filter(Boolean).join(', ') || '*'
  return { main, embeds }
}

class QueryBuilder {
  constructor(pool, table) {
    this.pool = pool
    this.table = assertIdent(table, 'tabela')
    this._op = 'select'
    this._selectCols = '*'
    this._filters = []
    this._order = []
    this._limit = null
    this._range = null
    this._single = false
    this._maybeSingle = false
    this._returning = true // select puro sempre "retorna"; insert/update só se .select()/.single() for chamado
    this._insertData = null
    this._updateData = null
    this._count = null
    this._head = false
  }

  select(cols = '*', opts = {}) {
    this._selectCols = cols
    // 2026-08-15 — achado real: faltava 'upsert' aqui. .upsert(...).select().single()
    // silenciosamente devolvia data:null (sem RETURNING na query), diferente do
    // Supabase real (que sempre devolve a linha upsertada com .select()) —
    // exposto pela primeira vez por calcularEPersistirPriorityScore/
    // RecoveryScore (priorityScore.js/recoveryScore.js) ao trocar insert por
    // upsert.
    if (this._op === 'insert' || this._op === 'update' || this._op === 'upsert' || this._op === 'delete') this._returning = true
    if (opts.count) this._count = opts.count
    if (opts.head) this._head = true
    return this
  }

  insert(data) { this._op = 'insert'; this._insertData = data; this._returning = false; return this }
  update(data) { this._op = 'update'; this._updateData = data; this._returning = false; return this }
  upsert(data, opts = {}) { this._op = 'upsert'; this._insertData = data; this._upsertConflict = opts.onConflict || 'id'; this._returning = false; return this }
  // 2026-08-15 — achado real (regressão própria, pegada antes do merge):
  // faltava zerar _returning aqui, diferente de insert/update/upsert acima
  // — herdava o `true` default do construtor (que existe pra SELECT puro),
  // então TODO .delete() (mesmo sem .select() encadeado) passou a gerar
  // RETURNING * depois da correção de .delete().select(). Sem isso,
  // .delete() nunca deveria "retornar" nada por padrão, só quando
  // .select() for chamado explicitamente — mesma regra de insert/update/upsert.
  delete() { this._op = 'delete'; this._returning = false; return this }

  eq(col, val) { this._filters.push({ col: assertIdent(col, 'coluna'), op: '=', val }); return this }
  neq(col, val) { this._filters.push({ col: assertIdent(col, 'coluna'), op: '<>', val }); return this }
  gte(col, val) { this._filters.push({ col: assertIdent(col, 'coluna'), op: '>=', val }); return this }
  lte(col, val) { this._filters.push({ col: assertIdent(col, 'coluna'), op: '<=', val }); return this }
  gt(col, val) { this._filters.push({ col: assertIdent(col, 'coluna'), op: '>', val }); return this }
  lt(col, val) { this._filters.push({ col: assertIdent(col, 'coluna'), op: '<', val }); return this }
  in(col, arr) { this._filters.push({ col: assertIdent(col, 'coluna'), op: 'in', val: arr }); return this }
  like(col, pattern) { this._filters.push({ col: assertIdent(col, 'coluna'), op: 'like', val: pattern }); return this }
  ilike(col, pattern) { this._filters.push({ col: assertIdent(col, 'coluna'), op: 'ilike', val: pattern }); return this }
  // CORREÇÃO 2026-09-02 — achado real: .not() é usado por vários arquivos de
  // produção (sync-financeiro-legado.js, erp.js, reativacao.js, comissoes.js,
  // etc.) mas nunca tinha suporte aqui — qualquer teste local que exercitasse
  // esse caminho de código quebrava com "TypeError: ...not is not a function",
  // então esses trechos nunca foram testados contra Postgres local. Só cobre
  // os dois padrões realmente usados no código real (auditado via grep):
  // .not(col, 'is', null) e .not(col, 'in', '(a,b,c)') — mesmo espírito
  // "adaptador estreito, não PostgREST genérico" do resto deste arquivo.
  not(col, operator, val) { this._filters.push({ col: assertIdent(col, 'coluna'), op: `not.${operator}`, val }); return this }

  order(col, { ascending = true } = {}) { this._order.push(`${assertIdent(col, 'coluna')} ${ascending ? 'ASC' : 'DESC'}`); return this }
  range(from, to) { this._range = [from, to]; return this }
  limit(n) { this._limit = n; return this }
  maybeSingle() { this._maybeSingle = true; this._returning = true; return this }
  single() { this._single = true; this._returning = true; return this }

  _whereClause(startIndex) {
    const clauses = []
    const params = []
    let i = startIndex
    for (const f of this._filters) {
      const paramsAntes = params.length
      if (f.op === 'in') {
        clauses.push(`${f.col} = ANY($${i})`)
        params.push(f.val)
      } else if (f.op === 'like' || f.op === 'ilike') {
        clauses.push(`${f.col} ${f.op.toUpperCase()} $${i}`)
        // supabase-js usa "*" como coringa (estilo PostgREST); Postgres usa "%".
        params.push(String(f.val).replace(/\*/g, '%'))
      } else if (f.op === 'not.is' && f.val === null) {
        // Sem parâmetro — "IS NOT NULL" nunca é bind param no Postgres.
        clauses.push(`${f.col} IS NOT NULL`)
      } else if (f.op === 'not.in') {
        // supabase-js aceita a lista já formatada estilo PostgREST: '(a,b,c)'.
        const itens = String(f.val).replace(/^\(|\)$/g, '').split(',').map((v) => v.trim()).filter(Boolean)
        clauses.push(`${f.col} <> ALL($${i})`)
        params.push(itens)
      } else if (f.op.startsWith('not.')) {
        throw new Error(`compat client local: .not('${f.col}', '${f.op.slice(4)}', ...) não suportado — só 'is'/'in' são cobertos hoje`)
      } else {
        clauses.push(`${f.col} ${f.op} $${i}`)
        params.push(f.val)
      }
      if (params.length > paramsAntes) i++
    }
    return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params, next: i }
  }

  async _executeSelect() {
    const { main, embeds } = parseSelect(this._selectCols)
    const where = this._whereClause(1)
    let sql

    if (this._head && this._count === 'exact') {
      sql = `SELECT COUNT(*) AS __count FROM ${this.table} ${where.sql}`
      const res = await this.pool.query(sql, where.params)
      return { data: null, error: null, count: Number(res.rows[0].__count) }
    }

    const selectList = this._count === 'exact' ? `${main}, COUNT(*) OVER() AS __total_count` : main
    sql = `SELECT ${selectList} FROM ${this.table} ${where.sql}`
    if (this._order.length) sql += ` ORDER BY ${this._order.join(', ')}`
    if (this._range) sql += ` LIMIT ${this._range[1] - this._range[0] + 1} OFFSET ${this._range[0]}`
    else if (this._limit != null) sql += ` LIMIT ${this._limit}`

    const res = await this.pool.query(sql, where.params)
    let rows = res.rows
    let count = null
    if (this._count === 'exact' && rows.length) {
      count = Number(rows[0].__total_count)
      rows = rows.map(({ __total_count, ...rest }) => rest)
    }

    for (const embed of embeds) {
      const fk = EMBED_FK[this.table]?.[embed.tabela]
      if (!fk) continue
      const ids = [...new Set(rows.map((r) => r[fk]).filter(Boolean))]
      if (!ids.length) continue
      const relRes = await this.pool.query(
        `SELECT id, ${embed.cols.join(', ')} FROM ${assertIdent(embed.tabela, 'tabela')} WHERE id = ANY($1)`,
        [ids]
      )
      const byId = new Map(relRes.rows.map((r) => [r.id, r]))
      for (const row of rows) row[embed.tabela] = byId.get(row[fk]) ?? null
    }

    if (this._single) {
      if (rows.length !== 1) return { data: null, error: { message: `expected 1 row, got ${rows.length}`, code: 'PGRST116' } }
      return { data: rows[0], error: null }
    }
    if (this._maybeSingle) {
      if (rows.length > 1) return { data: null, error: { message: `expected 0-1 rows, got ${rows.length}` } }
      return { data: rows[0] ?? null, error: null }
    }
    return { data: rows, error: null, count }
  }

  async _executeInsert() {
    const rowsIn = Array.isArray(this._insertData) ? this._insertData : [this._insertData]
    const cols = Object.keys(rowsIn[0]).map((c) => assertIdent(c, 'coluna'))
    const values = []
    const placeholders = rowsIn.map((row) => {
      const rowPlaceholders = cols.map((c) => {
        values.push(serializarValorParaColuna(row[c]))
        return `$${values.length}`
      })
      return `(${rowPlaceholders.join(', ')})`
    })
    const returning = this._returning ? `RETURNING ${this._selectCols === '*' ? '*' : this._selectCols}` : ''
    const sql = `INSERT INTO ${this.table} (${cols.join(', ')}) VALUES ${placeholders.join(', ')} ${returning}`
    const res = await this.pool.query(sql, values)
    const rows = res.rows
    if (this._single) {
      if (rows.length !== 1) return { data: null, error: { message: `expected 1 row, got ${rows.length}` } }
      return { data: rows[0], error: null }
    }
    if (this._maybeSingle) return { data: rows[0] ?? null, error: null }
    return { data: this._returning ? rows : null, error: null }
  }

  async _executeUpsert() {
    const rowsIn = Array.isArray(this._insertData) ? this._insertData : [this._insertData]
    const cols = Object.keys(rowsIn[0]).map((c) => assertIdent(c, 'coluna'))
    const values = []
    const placeholders = rowsIn.map((row) => {
      const rowPlaceholders = cols.map((c) => {
        values.push(serializarValorParaColuna(row[c]))
        return `$${values.length}`
      })
      return `(${rowPlaceholders.join(', ')})`
    })
    const conflictCols = String(this._upsertConflict).split(',').map((c) => assertIdent(c.trim(), 'coluna'))
    const updateSet = cols.filter((c) => !conflictCols.includes(c)).map((c) => `${c} = EXCLUDED.${c}`).join(', ')
    const returning = this._returning ? `RETURNING ${this._selectCols === '*' ? '*' : this._selectCols}` : ''
    const sql = `INSERT INTO ${this.table} (${cols.join(', ')}) VALUES ${placeholders.join(', ')} ` +
      `ON CONFLICT (${conflictCols.join(', ')}) DO UPDATE SET ${updateSet} ${returning}`
    const res = await this.pool.query(sql, values)
    const rows = res.rows
    // 2026-08-15 — faltava aqui (só _executeInsert/_executeUpdate/_executeSelect
    // tinham): sem isso, .upsert(...).select().single() devolvia o array
    // inteiro em `data` em vez do objeto único — `data.algumCampo` virava
    // undefined silenciosamente, sem erro, diferente do Supabase real.
    if (this._single) {
      if (rows.length !== 1) return { data: null, error: { message: `expected 1 row, got ${rows.length}` } }
      return { data: rows[0], error: null }
    }
    if (this._maybeSingle) return { data: rows[0] ?? null, error: null }
    return { data: this._returning ? rows : null, error: null }
  }

  async _executeUpdate() {
    const setCols = Object.keys(this._updateData).map((c) => assertIdent(c, 'coluna'))
    const setValues = setCols.map((c) => serializarValorParaColuna(this._updateData[c]))
    const setClause = setCols.map((c, i) => `${c} = $${i + 1}`).join(', ')
    const where = this._whereClause(setCols.length + 1)
    const returning = this._returning ? `RETURNING ${this._selectCols === '*' ? '*' : this._selectCols}` : ''
    const sql = `UPDATE ${this.table} SET ${setClause} ${where.sql} ${returning}`
    const res = await this.pool.query(sql, [...setValues, ...where.params])
    const rows = res.rows
    if (this._single) {
      if (rows.length !== 1) return { data: null, error: { message: `expected 1 row, got ${rows.length}` } }
      return { data: rows[0], error: null }
    }
    if (this._maybeSingle) return { data: rows[0] ?? null, error: null }
    return { data: this._returning ? rows : null, error: null }
  }

  async _executeDelete() {
    const where = this._whereClause(1)
    // 2026-08-15 — faltava RETURNING aqui: .delete().select() sempre devolvia
    // data:null, diferente do Supabase real (que devolve as linhas apagadas
    // com .select()) — exposto por cleanupNbaShadowLog (shadowWriteRepository.js)
    // ao precisar saber quantas linhas um DELETE removeu de verdade.
    const returning = this._returning ? `RETURNING ${this._selectCols === '*' ? '*' : this._selectCols}` : ''
    const sql = `DELETE FROM ${this.table} ${where.sql} ${returning}`
    const res = await this.pool.query(sql, where.params)
    const rows = res.rows
    if (this._single) {
      if (rows.length !== 1) return { data: null, error: { message: `expected 1 row, got ${rows.length}` } }
      return { data: rows[0], error: null }
    }
    if (this._maybeSingle) return { data: rows[0] ?? null, error: null }
    return { data: this._returning ? rows : null, error: null }
  }

  async _run() {
    try {
      if (this._op === 'insert') return await this._executeInsert()
      if (this._op === 'upsert') return await this._executeUpsert()
      if (this._op === 'update') return await this._executeUpdate()
      if (this._op === 'delete') return await this._executeDelete()
      return await this._executeSelect()
    } catch (err) {
      // Repassa err.code (SQLSTATE do Postgres) igual ao que o driver `pg` já
      // fornece — é o MESMO código que o Supabase real devolve (ex: '23505' para
      // unique_violation), então o código de aplicação que já checa
      // `error.code === '23505'` funciona sem alteração.
      return { data: null, error: { message: err.message, code: err.code } }
    }
  }

  then(resolve, reject) { return this._run().then(resolve, reject) }
  catch(reject) { return this._run().catch(reject) }
}

export function createLocalPgClient(connectionString) {
  // allowExitOnIdle — sem isso, o Pool mantém conexões ociosas abertas pra
  // sempre e o processo Node nunca sai sozinho (achado real: node --test
  // ficava pendurado após todas as assertions passarem, homologação 2026-08-12).
  const pool = new pg.Pool({ connectionString, allowExitOnIdle: true })

  function from(table) {
    return new QueryBuilder(pool, table)
  }

  async function rpc(fnName, params = {}) {
    assertIdent(fnName, 'função')
    const keys = Object.keys(params)
    const args = keys.map((k, i) => `${assertIdent(k, 'parâmetro')} := $${i + 1}`).join(', ')
    const values = keys.map((k) => params[k])
    const sql = `SELECT * FROM ${fnName}(${args})`
    try {
      const res = await pool.query(sql, values)
      // RETURNS jsonb (função escalar): 1 linha, 1 coluna — desembrulha pro valor
      // cru, igual ao supabase-js faz para funções não-tabulares.
      if (res.rows.length === 1 && Object.keys(res.rows[0]).length === 1) {
        return { data: Object.values(res.rows[0])[0], error: null }
      }
      // RETURNS TABLE: array de linhas, igual ao supabase-js.
      return { data: res.rows, error: null }
    } catch (err) {
      return { data: null, error: { message: err.message, code: err.code } }
    }
  }

  return { from, rpc, _pool: pool }
}
