// Reconciliação pós-timeout: se o processo caiu (ou a chamada à SEFAZ deu
// timeout de rede) DEPOIS de enviar mas ANTES de gravar o resultado, a nota
// fica presa em 'enviada'. Este job NUNCA reemite — só consulta o protocolo
// pela chave (consultarNFe, já existente) e aplica os efeitos internos
// (comissão, status_fiscal do pedido) de forma idempotente, exatamente como
// POST /:id/emitir faria se tivesse recebido a resposta a tempo.
import { supabase } from '../lib/supabase-admin.server.js'
import { consultarNFe } from '../services/nfe/sefaz.js'
import { registrarEvento } from '../services/nfe/eventos.js'
import { gerarComissao } from '../lib/comissoes.js'
import { vincularSerie1Autorizada } from '../lib/pedidoFiscal.js'

const MINUTOS_ANTES_DE_RECONCILIAR = 10

export async function reconciliarNfePendentes() {
  const limite = new Date(Date.now() - MINUTOS_ANTES_DE_RECONCILIAR * 60 * 1000).toISOString()

  // nfe_itens(*) só é usado se a nota vier autorizada (classificação de
  // faturamento por CFOP) — pedido junto sem custo extra de round-trip.
  const { data: pendentes, error } = await supabase
    .from('nfe')
    .select('id, chave, numero, pedido_id, correlation_id, nfe_itens(*)')
    .eq('status', 'enviada')
    .eq('reconciliada', false)
    .lte('enviada_em', limite)
  if (error) throw error

  const resumo = { verificadas: pendentes?.length ?? 0, autorizadas: 0, rejeitadas: 0, aindaPendentes: 0, semChave: 0, erros: 0 }

  for (const nfe of pendentes ?? []) {
    if (!nfe.chave) {
      // Sem chave: nem chegou a montar o XML — não tem o que consultar na
      // SEFAZ. Fica pra investigação manual, não é seguro reemitir sozinho.
      resumo.semChave++
      continue
    }

    try {
      const retorno = await consultarNFe(nfe.chave)
      const autorizado = retorno.cStat === '100' || retorno.cStat === '150'
      const rejeitadoOuNaoEncontrado = ['539', '217', '204'].includes(retorno.cStat) // 217/204: nota não consta na base da SEFAZ

      if (autorizado) {
        await supabase.from('nfe').update({
          status: 'autorizada', protocolo: retorno.protocolo, xml_autorizado: retorno.respXml,
          motivo_rejeicao: null, reconciliada: true,
        }).eq('id', nfe.id)

        await registrarEvento({
          nfeId: nfe.id, tipoEvento: 'reconciliacao', statusAnterior: 'enviada', statusNovo: 'autorizada',
          cstat: retorno.cStat, xMotivo: retorno.xMotivo, protocolo: retorno.protocolo, correlationId: nfe.correlation_id,
          motivo: 'Job de reconciliação — resposta original perdida por timeout/queda antes de gravar',
        })

        if (nfe.pedido_id) {
          await supabase.from('pedidos').update({ status_fiscal: 'autorizado', numero_nfe: String(nfe.numero) }).eq('id', nfe.pedido_id)
          await gerarComissao(nfe.id).catch(err => console.error('[reconciliar-nfe] erro ao gerar comissão:', err.message))
          await vincularSerie1Autorizada(nfe.pedido_id, nfe).catch(err => console.error('[reconciliar-nfe] erro ao vincular classificação de faturamento:', err.message))
        }
        resumo.autorizadas++
      } else if (rejeitadoOuNaoEncontrado) {
        await supabase.from('nfe').update({
          status: 'rejeitada', motivo_rejeicao: `${retorno.cStat} - ${retorno.xMotivo}`, reconciliada: true,
        }).eq('id', nfe.id)

        await registrarEvento({
          nfeId: nfe.id, tipoEvento: 'reconciliacao', statusAnterior: 'enviada', statusNovo: 'rejeitada',
          cstat: retorno.cStat, xMotivo: retorno.xMotivo, correlationId: nfe.correlation_id,
          motivo: 'Job de reconciliação',
        })

        if (nfe.pedido_id) {
          await supabase.from('pedidos').update({ status_fiscal: 'rejeitado' }).eq('id', nfe.pedido_id)
        }
        resumo.rejeitadas++
      } else {
        // SEFAZ ainda processando (fila) ou resposta ambígua — não decide
        // sozinho, deixa pro próximo ciclo do job.
        resumo.aindaPendentes++
      }
    } catch (err) {
      resumo.erros++
      console.error(`[reconciliar-nfe] erro ao consultar chave ${nfe.chave}:`, err.message)
    }
  }

  console.log('[reconciliar-nfe] execução concluída:', resumo)
  return resumo
}
