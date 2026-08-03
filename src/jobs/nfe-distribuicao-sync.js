// Job de sincronização automática com o webservice NFeDistribuicaoDFe —
// Fase B. ESQUELETO: a orquestração (checar config, checar throttling,
// persistir cursor, decidir manifestação) está pronta e testada
// (ciclo.js, cursor.js, manifestacao-decisao.js, resposta.js — 46
// assertions somadas). O que falta é só a peça de rede
// (services/nfe-distribuicao/sefaz-distribuicao.js), que lança erro de
// propósito até o certificado ser renovado — ver o comentário lá.
//
// NÃO está registrado em cron.schedule (src/index.js) ainda. Rodar isso
// automaticamente antes da peça de rede existir só geraria erro em todo
// ciclo sem fazer nada útil — ligar no cron é o próximo passo, depois do
// certificado renovado e de `consultarDistribuicaoDFe` implementado e
// testado em homologação.
//
// O QUE ESTE JOB AINDA NÃO DECIDE (propositalmente — são decisões de
// negócio que precisam ser validadas com o Peterson antes de codificar):
// - O que fazer com um resNFe recebido: criar rascunho automático em
//   nfe_entradas, ou só notificar pra importação manual do XML completo?
// - Quando/como baixar o procNFe (XML completo) a partir do resNFe (resumo).
// - Execução de fato do evento de manifestação (chamada SOAP de
//   RecepcaoEvento) quando decidirManifestacaoAutomatica() autoriza — hoje
//   só decide e loga, não envia.
// Por isso, por enquanto, este job só sincroniza o cursor de NSU e loga o
// que encontrou/decidiria — não cria nem altera nenhuma nota de entrada.
import { supabase } from '../lib/supabase-admin.server.js'
import { EMITENTE, SEFAZ } from '../services/nfe/emitente.js'
import { decidirCicloDeSincronizacao } from '../services/nfe-distribuicao/ciclo.js'
import { avancarCursor } from '../services/nfe-distribuicao/cursor.js'
import { parseRetDistDFeInt } from '../services/nfe-distribuicao/resposta.js'
import { decidirManifestacaoAutomatica } from '../services/nfe-distribuicao/manifestacao-decisao.js'
import { consultarDistribuicaoDFe } from '../services/nfe-distribuicao/sefaz-distribuicao.js'

const AMBIENTE = SEFAZ.tpAmb === '1' ? 'producao' : 'homologacao'

export async function runSincronizacaoDistribuicaoDFe() {
  const agora = new Date()

  const { data: config, error: erroConfig } = await supabase
    .from('configuracoes_fiscais')
    .select('entrada_sync_ativa, entrada_manifestacao_automatica, entrada_manifestacao_tipo_automatico')
    .eq('id', 1)
    .maybeSingle()
  if (erroConfig) {
    console.error('[nfe-distribuicao-sync] erro ao ler configuracoes_fiscais:', erroConfig.message)
    return { executado: false, motivo: 'erro ao ler configuração' }
  }

  const { data: estadoNsu, error: erroEstado } = await supabase
    .from('nfe_distribuicao_nsu')
    .select('cnpj, ambiente, ult_nsu, max_nsu, ultima_sincronizacao, ultimo_erro')
    .eq('cnpj', EMITENTE.CNPJ)
    .eq('ambiente', AMBIENTE)
    .maybeSingle()
  if (erroEstado) {
    console.error('[nfe-distribuicao-sync] erro ao ler nfe_distribuicao_nsu:', erroEstado.message)
    return { executado: false, motivo: 'erro ao ler cursor de NSU' }
  }

  const decisao = decidirCicloDeSincronizacao(config, estadoNsu, agora)
  if (!decisao.deveConsultar) {
    console.log(`[nfe-distribuicao-sync] ciclo pulado: ${decisao.motivo}`)
    return { executado: false, motivo: decisao.motivo }
  }

  let resposta
  try {
    const xmlResposta = await consultarDistribuicaoDFe({
      cnpj: EMITENTE.CNPJ,
      ultNSU: decisao.ultNsuParaConsulta,
      ambiente: AMBIENTE,
    })
    resposta = await parseRetDistDFeInt(xmlResposta)
  } catch (err) {
    console.error('[nfe-distribuicao-sync] erro na consulta/parse:', err.message)
    await supabase.from('nfe_distribuicao_nsu').upsert({
      cnpj: EMITENTE.CNPJ,
      ambiente: AMBIENTE,
      ultimo_erro: err.message,
      atualizado_em: agora.toISOString(),
    }, { onConflict: 'cnpj,ambiente' })
    return { executado: false, motivo: `erro: ${err.message}` }
  }

  const novoCursor = avancarCursor(
    { ult_nsu: decisao.ultNsuParaConsulta },
    { ultNSU: resposta.ultNSU, maxNSU: resposta.maxNSU, cStat: resposta.cstat }
  )

  await supabase.from('nfe_distribuicao_nsu').upsert({
    cnpj: EMITENTE.CNPJ,
    ambiente: AMBIENTE,
    ult_nsu: novoCursor.ult_nsu,
    max_nsu: novoCursor.max_nsu,
    ultima_sincronizacao: agora.toISOString(),
    ultimo_erro: null,
    atualizado_em: agora.toISOString(),
  }, { onConflict: 'cnpj,ambiente' })

  const resNFeDocs = resposta.docs.filter((d) => d.tipo === 'resNFe')
  const decisoesManifestacao = resNFeDocs.map((doc) => ({
    chave_acesso: doc.chave_acesso,
    decisao: decidirManifestacaoAutomatica(config || {}, {
      tipo: 'resNFe',
      chave_acesso: doc.chave_acesso,
      ja_manifestado: false, // TODO: cruzar com nfe_entradas/eventos quando essa parte for implementada
    }),
  }))

  console.log('[nfe-distribuicao-sync] ciclo concluído:', {
    documentos_recebidos: resposta.docs.length,
    resNFe: resNFeDocs.length,
    resEvento: resposta.docs.filter((d) => d.tipo === 'resEvento').length,
    nao_processados: resposta.docs.filter((d) => d.tipo === 'nao_processado').length,
    sincronizado_ate_o_fim: novoCursor.sincronizado_ate_o_fim,
    manifestacoes_que_seriam_automaticas: decisoesManifestacao.filter((d) => d.decisao.deveManifestarAutomaticamente).length,
  })

  return {
    executado: true,
    documentos: resposta.docs,
    decisoesManifestacao,
    cursor: novoCursor,
  }
}
