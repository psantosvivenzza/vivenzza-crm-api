import { supabase } from '../lib/supabase.js'

const TABELAS = ['leads', 'usuarios', 'tarefas', 'contatos', 'pedidos', 'whatsapp_mensagens']
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

export async function runBackup() {
  const inicio = Date.now()
  console.log('[backup] Iniciando backup diário...')

  // Nome do arquivo com data BRT (UTC-3)
  const brt = new Date(Date.now() - 3 * 60 * 60 * 1000)
  const dateStr = brt.toISOString().split('T')[0]
  const fileName = `backup_${dateStr}.json`

  // Exporta cada tabela
  const payload = { gerado_em: new Date().toISOString(), tabelas: {} }
  const contagens = {}

  for (const tabela of TABELAS) {
    try {
      const rows = await fetchAll(tabela)
      payload.tabelas[tabela] = rows
      contagens[tabela] = rows.length
      console.log(`[backup] ${tabela}: ${rows.length} registros`)
    } catch (err) {
      console.error(`[backup] Erro em ${tabela}:`, err.message)
      payload.tabelas[tabela] = []
      contagens[tabela] = 0
    }
  }

  // Upload para Supabase Storage bucket 'backups'
  const buffer = Buffer.from(JSON.stringify(payload), 'utf-8')
  const { error: uploadError } = await supabase.storage
    .from('backups')
    .upload(fileName, buffer, { contentType: 'application/json', upsert: true })

  if (uploadError) throw new Error(`Erro no upload: ${uploadError.message}`)

  // Remove backups com mais de 30 dias
  const { data: arquivos } = await supabase.storage.from('backups').list('', { limit: 200 })
  const corte = new Date(Date.now() - MANTER_DIAS * 24 * 60 * 60 * 1000)
  const deletar = (arquivos || [])
    .filter((f) => {
      const m = f.name.match(/backup_(\d{4}-\d{2}-\d{2})\.json/)
      return m && new Date(m[1]) < corte
    })
    .map((f) => f.name)

  if (deletar.length > 0) {
    await supabase.storage.from('backups').remove(deletar)
    console.log(`[backup] Removidos ${deletar.length} arquivo(s) antigo(s):`, deletar)
  }

  const duracao = ((Date.now() - inicio) / 1000).toFixed(1)
  console.log(`[backup] Concluído em ${duracao}s → ${fileName}`)

  return { arquivo: fileName, contagens, deletados: deletar, duracao_s: Number(duracao) }
}
