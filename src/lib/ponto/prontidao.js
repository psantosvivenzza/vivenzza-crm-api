// Prontidão operacional do módulo "Meu Ponto" — resposta objetiva pra
// perguntas que antes só tinham resposta via arqueologia manual em código,
// histórico de commits e (com sorte) acesso a produção: as 12 tabelas do
// módulo existem de verdade neste banco? o bucket privado de fotos foi
// criado? a marcação direta continua travada por código, mesmo com o piloto
// ligado? Motivado por uma auditoria (2026-09-24) que precisou reconstruir
// essas respostas manualmente por falta de um jeito direto de perguntar.
//
// Somente leitura, somente metadados — nenhuma foto é lida, nenhuma
// marcação/solicitação é listada aqui. Pensado para ser exposto só a admin
// (GET /api/ponto-admin/prontidao, atrás do mesmo [auth, adminOnly] do
// resto do router).
import { supabase } from '../supabase-admin.server.js'
import { EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA } from './equipamento.js'
import { verificarBucket } from './fotoStorage.js'

// As 12 tabelas criadas pelas migrations 048-053 (ver
// docs/meu-ponto/ESPECIFICACAO_MEU_PONTO.md) — mantida em código, não
// derivada do banco, de propósito: se uma migration nunca rodou, a tabela
// nem existe pra ser descoberta por introspecção.
export const TABELAS_MEU_PONTO = [
  'ponto_config',
  'ponto_habilitacoes',
  'ponto_habilitacoes_historico',
  'ponto_gestores',
  'ponto_equipamentos',
  'ponto_equipamento_eventos',
  'ponto_equipamento_vinculos',
  'ponto_desafios',
  'ponto_fotos',
  'ponto_marcacoes',
  'ponto_correcoes',
  'ponto_solicitacoes_marcacao',
]

async function verificarTabelas() {
  const ausentes = []
  for (const tabela of TABELAS_MEU_PONTO) {
    const { error } = await supabase.from(tabela).select('*', { count: 'exact', head: true })
    if (error) ausentes.push(tabela)
  }
  return {
    esperadas: TABELAS_MEU_PONTO.length,
    presentes: TABELAS_MEU_PONTO.length - ausentes.length,
    ausentes,
  }
}

export async function verificarProntidao() {
  const [tabelas, bucket, config, habilitacoes, equipamentos] = await Promise.all([
    verificarTabelas(),
    verificarBucket(),
    supabase.from('ponto_config').select('piloto_ativo, atualizado_em').eq('id', true).maybeSingle(),
    supabase.from('ponto_habilitacoes').select('id', { count: 'exact', head: true }).eq('habilitado', true),
    supabase.from('ponto_equipamentos').select('id', { count: 'exact', head: true }).eq('status', 'ativo'),
  ])

  return {
    verificado_em: new Date().toISOString(),
    tabelas,
    // Trava estrutural — reforça o que já é garantido em código
    // (src/lib/ponto/equipamento.js), pra ficar visível sem precisar ler
    // fonte: nunca deve virar `false` (destravada) por config nem deploy
    // automático, só por mudança de código deliberada e testada.
    marcacao_direta_bloqueada_por_codigo: EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA === false,
    piloto_ativo: config.error ? null : config.data?.piloto_ativo ?? false,
    piloto_config_disponivel: !config.error,
    total_habilitados: habilitacoes.error ? null : habilitacoes.count,
    total_equipamentos_ativos: equipamentos.error ? null : equipamentos.count,
    bucket_fotos: bucket,
  }
}
