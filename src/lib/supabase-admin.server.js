// ⚠️ SERVER-ONLY — client administrativo do Supabase.
//
// A chave usada aqui (SUPABASE_SECRET_KEY, ou o legado SUPABASE_SERVICE_ROLE_KEY)
// IGNORA todas as políticas de RLS do banco — acesso total de leitura/escrita
// em qualquer tabela. Nunca importar este arquivo de código que possa rodar
// no navegador.
//
// Auditoria de 03/08/2026 confirmou que isso já é impossível na prática hoje:
// o frontend (vivenzza-crm-frontend) não tem NENHUMA referência ao SDK do
// Supabase (zero `createClient`, zero variável SUPABASE_*/VITE_SUPABASE_*) —
// ele só fala com esta API via HTTP. Verificado inclusive no bundle de
// produção gerado por `npm run build` (dist/), não só nos imports do código
// fonte. A guarda de `typeof window` abaixo é defensiva/documental — não
// depende dela pra garantir isolamento, isso já vem da separação de
// repositórios/deployables (backend Node no Railway, frontend estático no
// Vercel), mas custa nada manter.
//
// Prioridade de chave: SUPABASE_SECRET_KEY (formato novo do Supabase,
// prefixo sb_secret_) é a preferida. SUPABASE_SERVICE_ROLE_KEY (formato
// antigo/JWT) é fallback de compatibilidade temporária, documentado aqui de
// propósito — remover esse fallback quando TODOS os ambientes (Railway +
// .env locais de quem roda scripts) estiverem confirmadamente no formato
// novo. Até lá, os dois convivem.
import { createClient } from '@supabase/supabase-js'

if (typeof window !== 'undefined') {
  throw new Error('supabase-admin.server.js nunca deve ser importado em código que roda no navegador.')
}

// LOCAL_PG_URL — SOMENTE desenvolvimento/teste local (nunca setado no Railway).
// PostgREST não tem binário Windows funcional nesta máquina de desenvolvimento
// (erro de DLL ausente) e o stack Docker completo do Supabase CLI não é viável
// sem Docker/WSL instalados — ver docs/cobranca-ai/LOCAL_DEVELOPMENT.md. Quando
// definida, troca o client real por um compat client que fala direto com
// Postgres via `pg`, cobrindo os mesmos métodos (`.from()`, `.rpc()`) usados
// pelo código real — permite rodar TODO o código de produção sem alteração
// contra um Postgres local para testes de integração de verdade.
const HOSTS_LOOPBACK_PERMITIDOS = new Set(['127.0.0.1', 'localhost', '::1'])

// Fail-closed (achado da auditoria de infra, 2026-08-12): LOCAL_PG_URL só é
// aceita se apontar pra um host de loopback. Isso nunca deve ser possível de
// burlar silenciosamente — nem por engano, nem por uma variável mal
// configurada — porque a mesma env var, se um dia apontasse pra fora, faria
// TODO o código de produção (inserts/updates/deletes irrestritos) rodar
// contra um banco remoto sem nenhum outro aviso.
function validarLocalPgUrl(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('LOCAL_PG_URL inválida — não é uma URL parseável.')
  }
  if (!HOSTS_LOOPBACK_PERMITIDOS.has(parsed.hostname)) {
    throw new Error(
      `LOCAL_PG_URL recusada: host "${parsed.hostname}" não é loopback (127.0.0.1/localhost/::1). ` +
      `Este projeto nunca aceita banco remoto via LOCAL_PG_URL por padrão.`
    )
  }
}

let supabaseExport

if (process.env.LOCAL_PG_URL) {
  validarLocalPgUrl(process.env.LOCAL_PG_URL)
  const { createLocalPgClient } = await import('./localdev/pgCompatClient.js')
  supabaseExport = createLocalPgClient(process.env.LOCAL_PG_URL)
  console.warn('[supabase-admin] LOCAL_PG_URL definido — usando compat client local (Postgres direto), NÃO o Supabase real. Nunca deve acontecer em produção.')
} else if (process.env.NODE_ENV === 'test') {
  // Fail-closed (achado da auditoria de infra, 2026-08-12): em NODE_ENV=test,
  // NUNCA cair silenciosamente pro Supabase real só porque LOCAL_PG_URL não
  // foi definida (setup esquecido, ordem de import errada, variável não
  // propagada em CI). Aborta explicitamente em vez de arriscar tocar
  // produção — mesmo que o .env local tenha credenciais reais do Supabase.
  throw new Error(
    'NODE_ENV=test exige LOCAL_PG_URL definida — recusando conectar ao Supabase real em ambiente de teste. ' +
    'Garanta que o setup de teste (ex: scripts/tests/collection/_setup.mjs) define LOCAL_PG_URL antes deste import.'
  )
} else {
  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseKey) {
    // Nunca inclui o VALOR de nenhuma variável na mensagem de erro — só o nome
    // de qual variável está faltando, pra não vazar segredo em log/stack trace.
    const faltando = [
      !supabaseUrl && 'SUPABASE_URL',
      !supabaseKey && 'SUPABASE_SECRET_KEY (ou, como fallback legado, SUPABASE_SERVICE_ROLE_KEY)',
    ].filter(Boolean).join(' e ')
    throw new Error(`Configuração do Supabase incompleta: defina ${faltando} no ambiente (Railway → Variables, ou .env local), ou LOCAL_PG_URL para desenvolvimento local.`)
  }

  supabaseExport = createClient(supabaseUrl, supabaseKey, {
    auth: {
      // Client administrativo server-only não gerencia sessão de usuário
      // nenhuma — desliga tudo que é voltado pra fluxo de auth no navegador.
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  })
}

export const supabase = supabaseExport
