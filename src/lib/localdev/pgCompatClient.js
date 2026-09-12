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
// - Embed de relacionamento (`'*, tabela(col1,col2)'`) sem apelido nem `!fkey`
//   explícito só funciona pra relações em EMBED_FK (hardcoded, ver comentário
//   junto ao mapa) — qualquer outra combinação tabela→tabela fora do mapa é
//   silenciosamente ignorada (sem erro), exatamente como antes de 2026-09-08.
//   Deliberado: uma versão anterior desta correção resolvia automaticamente
//   qualquer par de tabelas com 1 FK só entre elas (introspecção do
//   catálogo), mas isso mudava o resultado de ~50 embeds simples em rotas de
//   produção não relacionadas (leads.js, erp.js, pedidos.js, produtos.js,
//   etc.) que hoje dependem do embed local ser ignorado — revertido por
//   escopo, cada relação nova entra em EMBED_FK uma de cada vez.
// - Embed com apelido + FK nomeada explícita (`'apelido:tabela!nome_fkey(cols)'`,
//   sintaxe real do PostgREST) É suportado desde 2026-09-08 — resolve a coluna
//   de FK por introspecção real do catálogo (pg_constraint via
//   information_schema), não por convenção de nome nem mapa hardcoded. Usado
//   por GET /api/financeiro/contas/:contaId/baixas e
//   GET /api/financeiro/estornos/pendentes (múltiplos embeds da mesma tabela
//   usuarios, cada um via uma FK diferente — por isso precisam de apelido).
//   FK nomeada que não existir no catálogo lança erro explícito (não ignora
//   silenciosamente — ao contrário do caso sem apelido acima).
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

// EXTENSÃO — tarefa de auditoria/reprodução Financeiro (Notas de Entrada + DRE).
// Harness de teste local, NUNCA usado em produção (produção nunca importa
// este arquivo). Documentado separadamente do resto do arquivo, que
// permanece intacto na lógica de negócio (só este arquivo é estendido).
//
// Motivo: GET /api/relatorios/dre (src/routes/relatorios.js) filtra
// `nfe_itens` por uma coluna da tabela EMBEDADA — `.gte('nfe.data_emissao', ...)`
// sobre `.select('quantidade, produto_id, nfe!inner(data_emissao, status, serie)')`.
// Isso é sintaxe real do PostgREST (filtrar por coluna de uma relação
// embedada), mas o resto deste arquivo nunca montava um JOIN SQL de verdade —
// cada embed era resolvido via um SEGUNDO SELECT por tabela, depois de já ter
// buscado as linhas principais (ver loop de embeds em _executeSelect).
//
// HISTÓRICO — uma primeira versão desta extensão (2026-09-10) filtrava em
// MEMÓRIA, depois que o LIMIT/OFFSET do SQL principal já tinha rodado sobre a
// tabela base isolada. REJEITADA nesta revisão (2026-09-11), por pedido
// explícito do responsável pela revisão: essa abordagem não reproduz
// paginação corretamente — um bloco de 1000 linhas BRUTAS podia virar poucas
// linhas depois do filtro em memória, e `buscarTudo()` (relatorios.js), que
// para de paginar quando uma página volta com menos que o tamanho pedido,
// podia parar cedo demais e perder linhas de blocos SQL seguintes.
//
// VERSÃO ATUAL: monta um JOIN SQL real (INNER ou LEFT, conforme `!inner`/
// ausência de modificador no embed) contra a tabela embedada, com o WHERE
// (incluindo o filtro na coluna embedada) e o LIMIT/OFFSET aplicados sobre o
// resultado JOINADO — mesma semântica que o PostgREST real teria (filtra
// ANTES de paginar). Ver `_executeSelectComJoinDeEmbed` mais abaixo, na
// classe QueryBuilder. O caminho antigo ("segunda consulta" pós-fetch)
// continua existindo e é usado, sem mudança, para embeds que NÃO têm filtro
// em coluna própria (ex: notas_entrada→usuarios, notas_entrada_itens→produtos)
// — risco de regressão minimizado por só desviar pro JOIN quando
// estritamente necessário.
const IDENT_DOTADO_RE = /^[a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]*$/

function assertIdentOuEmbedDotado(name, kind = 'identificador') {
  if (IDENT_RE.test(name) || IDENT_DOTADO_RE.test(name)) return name
  throw new Error(`${kind} inválido para o compat client local: ${name}`)
}

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
//
// DELIBERADAMENTE hardcoded, não introspectado automaticamente: o código de
// produção tem ~50 embeds simples (leads.js, erp.js, pedidos.js, produtos.js,
// tarefas.js, whatsapp.js, nfe.js, nfe-entradas.js, etc.) que NUNCA passaram
// por EMBED_FK e são silenciosamente ignorados aqui há meses — comportamento
// documentado e usado por quem escreveu essas rotas (sabem que o embed local
// não resolve). Resolver esses embeds "de graça" via introspecção do catálogo
// (como uma versão anterior desta correção fazia, revertida em 2026-09-08)
// mudaria a forma de QUALQUER um deles sem relação com este trabalho — escopo
// bem maior que o pedido (2 embeds simples nas rotas de estorno). Por isso
// cada entrada é adicionada aqui, uma de cada vez, só quando precisa de
// verdade — igual ao padrão já estabelecido para collection_calls.
const EMBED_FK = {
  collection_calls: { contas_financeiras: 'contas_financeiras_id' },
  // 2026-09-08 — GET /api/financeiro/estornos/pendentes (financeiro.js) embeda
  // baixas_financeiras e contas_financeiras sem apelido nem FK nomeada;
  // estornos_financeiros só tem 1 FK pra cada uma das duas, sem ambiguidade.
  estornos_financeiros: {
    baixas_financeiras: 'baixa_financeira_id',
    contas_financeiras: 'conta_financeira_id',
  },
  // 2026-09-10 — EXTENSÃO para a tarefa de auditoria/reprodução Financeiro
  // (Notas de Entrada + DRE). Adicionadas uma de cada vez, igual ao padrão já
  // estabelecido acima — cobrem exatamente os 3 embeds usados pelas rotas
  // reais exercitadas nesta tarefa (GET /api/notas-entrada, GET /api/notas-entrada/:id,
  // GET /api/relatorios/dre):
  notas_entrada: { usuarios: 'usuario_id' },
  notas_entrada_itens: { produtos: 'produto_id' },
  nfe_itens: { nfe: 'nfe_id' },
}

// 2026-09-08 — suporte à sintaxe de embed do PostgREST com apelido e FK
// nomeada explícita: `apelido:tabela!nome_da_constraint_fkey(col1, col2)`.
// Necessário quando a MESMA tabela é referenciada mais de uma vez pela
// tabela de origem (ex: estornos_financeiros tem 3 FKs pra usuarios:
// solicitado_por/aprovado_por/rejeitado_por_usuario_id) — sem apelido, as
// três sobrescreveriam a mesma chave no objeto de resultado.
//
// Grupo 1 (opcional): apelido, antes de ":". Grupo 2: nome da tabela.
// Grupo 3 (opcional): nome da constraint de FK, depois de "!". Grupo 4:
// lista de colunas dentro dos parênteses.
const EMBED_RE = /(?:(\w+):)?(\w+)(?:!(\w+))?\(([^)]+)\)/g

// Exportado só pra teste unitário direto (parser é função pura, mais fácil
// de testar isolado do que sempre passando pelo Postgres real).
export function parseSelect(cols) {
  if (!cols || cols === '*') return { main: '*', embeds: [] }
  const embeds = []
  // Remove blocos de embed do texto principal, guardando separadamente.
  const main = cols.replace(EMBED_RE, (_, alias, tabela, fkeyName, colsInternas) => {
    embeds.push({
      alias: alias || tabela,
      tabela,
      fkeyName: fkeyName || null,
      cols: colsInternas.split(',').map((c) => c.trim()),
    })
    return ''
  }).split(',').map((c) => c.trim()).filter(Boolean).join(', ') || '*'
  return { main, embeds }
}

// Resolve o nome real da coluna de uma FK a partir do nome da CONSTRAINT
// (ex: "estornos_financeiros_solicitado_por_usuario_id_fkey" →
// "solicitado_por_usuario_id"), consultando o catálogo do Postgres — não
// depende de convenção de nomenclatura nem de mapa hardcoded, então funciona
// mesmo se a constraint tiver um nome customizado. Lança erro explícito se a
// constraint não existir: uma FK nomeada explicitamente no `select()` que não
// resolve é um erro de programação, não deve falhar em silêncio.
const cacheColunaPorConstraint = new Map()
async function resolverColunaPorNomeDeConstraint(pool, fkeyName) {
  if (cacheColunaPorConstraint.has(fkeyName)) return cacheColunaPorConstraint.get(fkeyName)
  const res = await pool.query(
    `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.constraint_schema = kcu.constraint_schema
      WHERE tc.constraint_name = $1 AND tc.constraint_type = 'FOREIGN KEY'`,
    [fkeyName]
  )
  if (res.rows.length !== 1) {
    throw new Error(`compat client local: constraint de FK "${fkeyName}" não encontrada no catálogo do Postgres`)
  }
  const coluna = assertIdent(res.rows[0].column_name, 'coluna de FK')
  cacheColunaPorConstraint.set(fkeyName, coluna)
  return coluna
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

  // eq/neq/gte/lte/gt/lt aceitam também "alias.coluna" (extensão 2026-09-10,
  // ver assertIdentOuEmbedDotado acima) — filtro sobre coluna de tabela
  // embedada, resolvido em memória depois do embed (_executeSelect), nunca
  // vira SQL WHERE direto (ver _whereClause abaixo).
  eq(col, val) { this._filters.push({ col: assertIdentOuEmbedDotado(col, 'coluna'), op: '=', val }); return this }
  neq(col, val) { this._filters.push({ col: assertIdentOuEmbedDotado(col, 'coluna'), op: '<>', val }); return this }
  gte(col, val) { this._filters.push({ col: assertIdentOuEmbedDotado(col, 'coluna'), op: '>=', val }); return this }
  lte(col, val) { this._filters.push({ col: assertIdentOuEmbedDotado(col, 'coluna'), op: '<=', val }); return this }
  gt(col, val) { this._filters.push({ col: assertIdentOuEmbedDotado(col, 'coluna'), op: '>', val }); return this }
  lt(col, val) { this._filters.push({ col: assertIdentOuEmbedDotado(col, 'coluna'), op: '<', val }); return this }
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
      // Extensão 2026-09-10: filtro em coluna embedada ("alias.coluna") nunca
      // vira SQL aqui — é aplicado em memória depois da resolução do embed,
      // em _executeSelect (ver avaliarFiltroEmbed). Ignorado neste WHERE.
      if (f.col.includes('.')) continue
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

  // Extensão 2026-09-11 — ver comentário no topo do arquivo (IDENT_DOTADO_RE)
  // pro histórico da decisão. Caminho usado SOMENTE quando a query tem
  // filtro em coluna de tabela embedada ("alias.coluna") — monta um JOIN SQL
  // real (INNER pra `!inner`, LEFT caso contrário) e aplica WHERE/LIMIT/OFFSET
  // sobre o resultado JOINADO, não sobre a tabela base isolada. Só resolve FK
  // via EMBED_FK (mapa hardcoded) ou FK nomeada explícita (`!nome_constraint`)
  // — mesmas duas fontes já usadas no resto do arquivo.
  async _executeSelectComJoinDeEmbed(main, embeds, filtrosEmbed) {
    const aliasComFiltro = new Set(filtrosEmbed.map((f) => f.col.split('.')[0]))
    const embedsViaJoin = embeds.filter((e) => aliasComFiltro.has(e.alias))
    // Embeds do MESMO select() sem filtro pontuado próprio — não exercitado
    // por nenhuma rota real auditada nesta tarefa (nenhuma combina os dois no
    // mesmo select), mas resolvido pela via de sempre (segunda consulta) por
    // consistência, em vez de silenciosamente sumir.
    const embedsSemJoin = embeds.filter((e) => !aliasComFiltro.has(e.alias))

    const joins = []
    for (const embed of embedsViaJoin) {
      const ehHintDeJoin = embed.fkeyName === 'inner' || embed.fkeyName === 'left'
      const fkeyNameConstraint = (embed.fkeyName && !ehHintDeJoin) ? embed.fkeyName : null
      const fk = fkeyNameConstraint
        ? await resolverColunaPorNomeDeConstraint(this.pool, fkeyNameConstraint)
        : EMBED_FK[this.table]?.[embed.tabela]
      if (!fk) {
        throw new Error(
          `compat client local: filtro em '${embed.alias}.coluna' pedido, mas o embed '${embed.tabela}' ` +
          `não está em EMBED_FK['${this.table}'] nem usa FK nomeada explícita — não dá pra montar o JOIN necessário`
        )
      }
      joins.push({
        alias: assertIdent(embed.alias, 'apelido de embed'),
        tabela: assertIdent(embed.tabela, 'tabela'),
        fk: assertIdent(fk, 'coluna de FK'),
        tipoJoin: embed.fkeyName === 'inner' ? 'INNER' : 'LEFT',
        cols: embed.cols.map((c) => assertIdent(c, 'coluna')),
      })
    }

    const mainColsList = main === '*'
      ? [`${this.table}.*`]
      : main.split(',').map((c) => c.trim()).map((c) => `${this.table}.${assertIdent(c, 'coluna')}`)
    const embedColsSelect = joins.flatMap((j) => j.cols.map((c) => `${j.alias}.${c} AS "${j.alias}.${c}"`))
    let selectList = [...mainColsList, ...embedColsSelect].join(', ')
    if (this._count === 'exact') selectList += ', COUNT(*) OVER() AS __total_count'

    let sql = `SELECT ${selectList} FROM ${this.table}`
    for (const j of joins) sql += ` ${j.tipoJoin} JOIN ${j.tabela} AS ${j.alias} ON ${this.table}.${j.fk} = ${j.alias}.id`

    const clauses = []
    const params = []
    let i = 1
    for (const f of this._filters) {
      const paramsAntes = params.length
      const colQualificada = f.col.includes('.')
        ? f.col.split('.').map((p) => assertIdent(p, 'identificador')).join('.')
        : `${this.table}.${f.col}`
      if (f.op === 'in') {
        clauses.push(`${colQualificada} = ANY($${i})`); params.push(f.val)
      } else if (f.op === 'like' || f.op === 'ilike') {
        clauses.push(`${colQualificada} ${f.op.toUpperCase()} $${i}`)
        params.push(String(f.val).replace(/\*/g, '%'))
      } else if (f.op === 'not.is' && f.val === null) {
        clauses.push(`${colQualificada} IS NOT NULL`)
      } else if (f.op === 'not.in') {
        const itens = String(f.val).replace(/^\(|\)$/g, '').split(',').map((v) => v.trim()).filter(Boolean)
        clauses.push(`${colQualificada} <> ALL($${i})`); params.push(itens)
      } else if (f.op.startsWith('not.')) {
        throw new Error(`compat client local: .not('${f.col}', '${f.op.slice(4)}', ...) não suportado — só 'is'/'in' são cobertos hoje`)
      } else {
        clauses.push(`${colQualificada} ${f.op} $${i}`); params.push(f.val)
      }
      if (params.length > paramsAntes) i++
    }
    if (clauses.length) sql += ` WHERE ${clauses.join(' AND ')}`
    if (this._order.length) sql += ` ORDER BY ${this._order.map((o) => `${this.table}.${o}`).join(', ')}`
    if (this._range) sql += ` LIMIT ${this._range[1] - this._range[0] + 1} OFFSET ${this._range[0]}`
    else if (this._limit != null) sql += ` LIMIT ${this._limit}`

    const res = await this.pool.query(sql, params)
    let rows = res.rows
    let count = null
    if (this._count === 'exact' && rows.length) {
      count = Number(rows[0].__total_count)
      rows = rows.map(({ __total_count, ...rest }) => rest)
    }

    // Reagrupa as colunas achatadas "alias.coluna" (do AS "alias.coluna" no
    // SELECT) de volta pra objeto aninhado row[alias] = {coluna: valor} —
    // mesmo formato que o Supabase/PostgREST real devolve pra embed. Linha
    // sem correspondência num LEFT JOIN vem com todas as colunas do embed
    // como SQL NULL — resulta num objeto com todas as chaves null (nunca
    // undefined/ausente), igual ao comportamento real.
    rows = rows.map((row) => {
      const nested = {}
      for (const key of Object.keys(row)) {
        if (key.includes('.')) {
          const [alias, coluna] = key.split('.')
          nested[alias] = nested[alias] || {}
          nested[alias][coluna] = row[key]
        } else {
          nested[key] = row[key]
        }
      }
      return nested
    })

    for (const embed of embedsSemJoin) {
      const ehHintDeJoin = embed.fkeyName === 'inner' || embed.fkeyName === 'left'
      const fkeyNameConstraint = (embed.fkeyName && !ehHintDeJoin) ? embed.fkeyName : null
      const fk = fkeyNameConstraint
        ? await resolverColunaPorNomeDeConstraint(this.pool, fkeyNameConstraint)
        : EMBED_FK[this.table]?.[embed.tabela]
      if (!fk) continue
      for (const row of rows) row[embed.alias] = null
      const ids = [...new Set(rows.map((r) => r[fk]).filter(Boolean))]
      if (!ids.length) continue
      const relRes = await this.pool.query(
        `SELECT id, ${embed.cols.join(', ')} FROM ${assertIdent(embed.tabela, 'tabela')} WHERE id = ANY($1)`,
        [ids]
      )
      const byId = new Map(relRes.rows.map((r) => [r.id, r]))
      for (const row of rows) row[embed.alias] = byId.get(row[fk]) ?? null
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

  async _executeSelect() {
    const { main, embeds } = parseSelect(this._selectCols)
    const filtrosEmbed = this._filters.filter((f) => f.col.includes('.'))

    // Filtro em coluna embedada desvia pra _executeSelectComJoinDeEmbed ANTES
    // de qualquer outra coisa — inclusive do caminho de count-only logo
    // abaixo, que não sabe lidar com filtro pontuado (_whereClause sempre
    // ignora coluna com ponto; um count-only aqui devolveria contagem
    // errada). Lança erro explícito em vez disso — combinação não exercitada
    // por nenhuma rota real auditada nesta tarefa.
    if (filtrosEmbed.length) {
      if (this._head && this._count === 'exact') {
        throw new Error('compat client local: count-only (.select(..., {count:"exact", head:true})) combinado com filtro em coluna embedada não é suportado')
      }
      return this._executeSelectComJoinDeEmbed(main, embeds, filtrosEmbed)
    }

    const where = this._whereClause(1)
    let sql

    if (this._head && this._count === 'exact') {
      sql = `SELECT COUNT(*) AS __count FROM ${this.table} ${where.sql}`
      const res = await this.pool.query(sql, where.params)
      return { data: null, error: null, count: Number(res.rows[0].__count) }
    }

    // Extensão — garante que a coluna de FK usada pra resolver cada
    // embed do mapa EMBED_FK está de fato no SELECT principal, mesmo que o
    // código chamador não a tenha pedido explicitamente. O PostgREST real
    // resolve embed via JOIN de verdade (não precisa da FK crua no select());
    // este compat client resolve com uma SEGUNDA consulta que depende de
    // `row[fk]` já vindo na linha principal — sem a FK selecionada, `ids`
    // (linha ~400 abaixo) fica sempre vazio e o embed nunca resolve, mesmo
    // com a entrada certa em EMBED_FK. Gap real, achado ao rodar
    // GET /api/relatorios/dre pela primeira vez após adicionar
    // `nfe_itens: { nfe: 'nfe_id' }`: nfe_itens.select('quantidade, produto_id,
    // nfe!inner(...)') nunca pede 'nfe_id' explicitamente. Só cobre o caminho
    // resolvido via EMBED_FK (mapa hardcoded) — o caminho de FK nomeada
    // explícita (`!nome_da_constraint`) não é tocado aqui, permanece exigindo
    // que o chamador já inclua a FK no select (comportamento inalterado,
    // nenhuma rota existente dependia de auto-adição). Colunas
    // auto-adicionadas são removidas do resultado antes de devolver (linha
    // ~415 abaixo), pra não mudar o formato que o código chamador espera.
    let mainColsList = main === '*' ? null : main.split(',').map((c) => c.trim())
    const colunasFkAutoAdicionadas = []
    if (mainColsList) {
      for (const embed of embeds) {
        const ehHintDeJoinPreCalc = embed.fkeyName === 'inner' || embed.fkeyName === 'left'
        const fkeyNameConstraintPreCalc = (embed.fkeyName && !ehHintDeJoinPreCalc) ? embed.fkeyName : null
        if (fkeyNameConstraintPreCalc) continue // caminho de constraint nomeada — inalterado, não auto-adiciona
        const fkPreCalc = EMBED_FK[this.table]?.[embed.tabela]
        if (fkPreCalc && !mainColsList.includes(fkPreCalc)) {
          mainColsList.push(fkPreCalc)
          colunasFkAutoAdicionadas.push(fkPreCalc)
        }
      }
    }
    const mainComFksGarantidas = mainColsList ? mainColsList.join(', ') : main

    const selectList = this._count === 'exact' ? `${mainComFksGarantidas}, COUNT(*) OVER() AS __total_count` : mainComFksGarantidas
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
      // Extensão 2026-09-10: "!inner"/"!left" são MODIFICADORES DE TIPO DE JOIN
      // do PostgREST (`tabela!inner(...)` / `tabela!left(...)`), não nome de
      // constraint de FK — mas o EMBED_RE original (linha ~110) captura
      // qualquer coisa depois de "!" como fkeyName, então "nfe!inner(...)"
      // (usado de verdade por GET /api/relatorios/dre em nfe_itens) tratava
      // "inner" como se fosse um nome de constraint e IA FALHAR aqui com
      // "constraint de FK não encontrada" — gap real do arquivo original,
      // nunca exercitado antes (nenhum embed com "!inner" tinha passado por
      // este caminho até esta tarefa). Tratado como os dois únicos hints de
      // join conhecidos do PostgREST; qualquer outro texto depois de "!"
      // continua sendo interpretado como nome de constraint, comportamento
      // inalterado.
      const ehHintDeJoin = embed.fkeyName === 'inner' || embed.fkeyName === 'left'
      const fkeyNameConstraint = ehHintDeJoin ? null : embed.fkeyName
      const fk = fkeyNameConstraint
        ? await resolverColunaPorNomeDeConstraint(this.pool, fkeyNameConstraint)
        : EMBED_FK[this.table]?.[embed.tabela]
      if (!fk) continue
      // Chave do embed sempre presente e explicitamente null quando não há
      // correspondência (igual ao Supabase/PostgREST real) — sem isto,
      // JSON.stringify OMITE a chave (undefined não serializa), diferente de
      // null (que serializa). Achado ao testar rejeitado_por em estornos não
      // rejeitados: ficava ausente da resposta em vez de `null`.
      for (const row of rows) row[embed.alias] = null
      const ids = [...new Set(rows.map((r) => r[fk]).filter(Boolean))]
      if (!ids.length) continue
      const relRes = await this.pool.query(
        `SELECT id, ${embed.cols.join(', ')} FROM ${assertIdent(embed.tabela, 'tabela')} WHERE id = ANY($1)`,
        [ids]
      )
      const byId = new Map(relRes.rows.map((r) => [r.id, r]))
      for (const row of rows) row[embed.alias] = byId.get(row[fk]) ?? null
    }

    // NOTA: filtro em coluna embedada ("alias.coluna") nunca chega até aqui —
    // _executeSelect() desvia pra _executeSelectComJoinDeEmbed() antes disso
    // sempre que filtrosEmbed.length > 0 (ver início de _executeSelect). Este
    // trecho só roda para embeds SEM filtro pontuado.

    // Remove as colunas de FK auto-adicionadas (ver acima) do resultado final
    // — o código chamador não pediu essas colunas explicitamente, então não
    // devem aparecer na linha devolvida (mesmo formato que o PostgREST real
    // devolveria, que nunca expõe a FK crua a menos que pedida no select()).
    if (colunasFkAutoAdicionadas.length) {
      for (const row of rows) {
        for (const col of colunasFkAutoAdicionadas) delete row[col]
      }
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
