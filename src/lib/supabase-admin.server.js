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

const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !supabaseKey) {
  // Nunca inclui o VALOR de nenhuma variável na mensagem de erro — só o nome
  // de qual variável está faltando, pra não vazar segredo em log/stack trace.
  const faltando = [
    !supabaseUrl && 'SUPABASE_URL',
    !supabaseKey && 'SUPABASE_SECRET_KEY (ou, como fallback legado, SUPABASE_SERVICE_ROLE_KEY)',
  ].filter(Boolean).join(' e ')
  throw new Error(`Configuração do Supabase incompleta: defina ${faltando} no ambiente (Railway → Variables, ou .env local).`)
}

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    // Client administrativo server-only não gerencia sessão de usuário
    // nenhuma — desliga tudo que é voltado pra fluxo de auth no navegador.
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
})
