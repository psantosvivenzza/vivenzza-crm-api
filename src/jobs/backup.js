import { supabase } from '../lib/supabase-admin.server.js'

// whatsapp_mensagens excluída do backup: centenas de milhares de linhas, risco de OOM.
// O Supabase já tem redundância própria (PITR) para essa tabela.
// Tabelas de log/telemetria (notifications, sdr_conversas, nba_shadow_log,
// escalation_log, sincronizacoes_financeiro/erros) também ficam de fora: são
// reconstruíveis/operacionais, não dados de negócio que não podem ser perdidos.
const TABELAS = [
  // já existiam
  'leads',
  'usuarios',
  'tarefas',
  'contatos',
  'pedidos',
  // financeiro — antes NÃO cobertas (achado 25/09)
  'contas_financeiras',
  'baixas_financeiras',
  'conferencias_financeiro',
  'cobrancas_whatsapp',
  'estornos_financeiros',
  'comissoes',
  // fiscal / NF-e
  'nfe',
  'nfe_itens',
  'notas_entrada',
  'notas_entrada_itens',
  'configuracoes_fiscais',
  // catálogo / estoque / cadastro
  'produtos',
  'estoque',
  'fornecedores',
  'clientes_erp',
  'pedido_itens',
  // canais / operação
  'whatsapp_instances',
  'distribuicao_leads',
  'voice_calls',
]
const MANTER_DIAS = 30

async function fetchAll(tabela) {
  const PAGE = 1000
  let todos = []
  let from = 0
  while (true) {
    const { data, error } = await supabase
      .from(tabela)
      .select('*')
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`Erro ao exportar ${tabela}: ${error.message}`)
    todos = todos.concat(data || [])
    if (!data || data.length < PAGE) break
    from += PAGE
  }
  return todos
}

// Cada tabela é buscada, serializada e enviada individualmente — o processo
// nunca precisa manter mais de uma tabela inteira na memória ao mesmo tempo
// (evita OOM quando o conjunto de tabelas cresce, ex.: nfe_itens com 60k+ linhas).
export async function runBackup() {
  const inicio = Date.now()
  console.log('[backup] Iniciando backup diário...')

  const brt = new Date(Date.now() - 3 * 60 * 60 * 1000)
  const dateStr = brt.toISOString().split('T')[0]

  const contagens = {}
  const arquivos = []
  const erros = {}

  for (const tabela of TABELAS) {
    try {
      const rows = await fetchAll(tabela)
      contagens[tabela] = rows.length

      const fileName = `backup_${tabela}_${dateStr}.json`
      const buffer = Buffer.from(
        JSON.stringify({ tabela, gerado_em: new Date().toISOString(), registros: rows }),
        'utf-8'
      )
      const { error: uploadError } = await supabase.storage
        .from('backups')
        .upload(fileName, buffer, { contentType: 'application/json', upsert: true })

      if (uploadError) throw new Error(`Erro no upload de ${tabela}: ${uploadError.message}`)

      arquivos.push(fileName)
      console.log(`[backup] ${tabela}: ${rows.length} registros → ${fileName}`)
    } catch (err) {
      console.error(`[backup] Erro em ${tabela}:`, err.message)
      contagens[tabela] = 0
      erros[tabela] = err.message
    }
  }

  // Remove backups com mais de 30 dias (qualquer tabela)
  const { data: listaArquivos } = await supabase.storage.from('backups').list('', { limit: 1000 })
  const corte = new Date(Date.now() - MANTER_DIAS * 24 * 60 * 60 * 1000)
  const deletar = (listaArquivos || [])
    .filter((f) => {
      const m = f.name.match(/backup_.+_(\d{4}-\d{2}-\d{2})\.json$/)
      return m && new Date(m[1]) < corte
    })
    .map((f) => f.name)

  if (deletar.length > 0) {
    await supabase.storage.from('backups').remove(deletar)
    console.log(`[backup] Removidos ${deletar.length} arquivo(s) antigo(s)`)
  }

  const duracao = ((Date.now() - inicio) / 1000).toFixed(1)
  const status = Object.keys(erros).length > 0 ? 'parcial' : 'completo'
  console.log(`[backup] Concluído (${status}) em ${duracao}s → ${arquivos.length} arquivo(s)`)

  return { status, arquivos, contagens, erros, deletados: deletar, duracao_s: Number(duracao) }
}
