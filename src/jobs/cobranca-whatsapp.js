import { supabase } from '../lib/supabase.js'
import { calcularEtapa, montarMensagem } from '../lib/reguaCobranca.js'
import { enviarTextoFinanceiro } from '../lib/evolutionFinanceiro.js'

// Kill-switch — ao contrário de automacoes_config.reativacao_ativa (que é opt-out,
// default true), este é opt-in: uma automação nova que manda mensagem financeira
// pra cliente real não deve nunca ligar sozinha. Só true explícito ativa.
async function cobrancaEstaAtiva() {
  const { data } = await supabase.from('automacoes_config').select('cobranca_whatsapp_ativa').eq('id', 1).maybeSingle()
  return data?.cobranca_whatsapp_ativa === true
}

function diasAtrasoDe(vencimento) {
  const hojeBrt = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }) // YYYY-MM-DD
  const umDia = 24 * 60 * 60 * 1000
  return Math.floor((new Date(hojeBrt) - new Date(vencimento)) / umDia)
}

// Núcleo da régua — usado tanto pelo cron diário quanto por POST /api/cobrancas/disparar.
// `origem` sempre 'cron' aqui: disparo manual em massa usa a mesma função porque é o
// mesmo conceito de "rodar a régua agora", só que fora do horário do cron.
export async function executarReguaCobranca() {
  if (!(await cobrancaEstaAtiva())) {
    console.log('[cobranca-whatsapp] desligado (automacoes_config.cobranca_whatsapp_ativa=false) — nada enviado')
    return { ativo: false, elegiveis: 0, enviadas: 0, semTelefone: 0, jaEnviadas: 0, quitados: 0, erros: 0 }
  }

  // PostgREST limita a 1000 linhas por padrão — pagina pra não deixar clientes
  // de fora da régua silenciosamente (mesmo bug corrigido em aging.js).
  const contas = []
  {
    const PAGE = 1000
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await supabase
        .from('contas_financeiras')
        .select('id, pessoa_nome, valor, valor_pago, vencimento, telefone_cobranca')
        .eq('tipo', 'receber')
        .in('status', ['aberta', 'vencida'])
        .range(offset, offset + PAGE - 1)
      if (error) throw error
      contas.push(...data)
      if (data.length < PAGE) break
    }
  }

  const resumo = { ativo: true, elegiveis: 0, enviadas: 0, semTelefone: 0, jaEnviadas: 0, quitados: 0, erros: 0 }

  for (const conta of contas ?? []) {
    const diasAtraso = diasAtrasoDe(conta.vencimento)
    const etapa = calcularEtapa(diasAtraso)
    if (etapa === null) continue

    // Baixa parcial pode já ter quitado o título inteiro mesmo com status
    // ainda 'aberta/vencida' no legado (status não é atualizado em tempo real).
    const saldo = Number(conta.valor || 0) - Number(conta.valor_pago || 0)
    if (saldo <= 0) {
      resumo.quitados++
      continue
    }
    resumo.elegiveis++

    if (!conta.telefone_cobranca) {
      resumo.semTelefone++
      continue
    }

    const { data: jaEnviada } = await supabase
      .from('cobrancas_whatsapp')
      .select('id')
      .eq('contas_financeiras_id', conta.id)
      .eq('etapa', etapa)
      .eq('origem', 'cron')
      .maybeSingle()
    if (jaEnviada) {
      resumo.jaEnviadas++
      continue
    }

    const mensagem = montarMensagem(etapa, {
      nome: conta.pessoa_nome, valor: saldo, vencimento: conta.vencimento, diasAtraso,
    })

    try {
      await enviarTextoFinanceiro(conta.telefone_cobranca, mensagem)
      const { error: erroInsert } = await supabase.from('cobrancas_whatsapp').insert({
        contas_financeiras_id: conta.id,
        cliente_nome: conta.pessoa_nome,
        cliente_telefone: conta.telefone_cobranca,
        valor: saldo,
        vencimento: conta.vencimento,
        dias_atraso: diasAtraso,
        etapa,
        status: 'enviada',
        origem: 'cron',
        data_envio: new Date().toISOString(),
        mensagem_enviada: mensagem,
      })
      // 23505 = unique_violation — corrida rara com outra execução concorrente da régua;
      // trata como "já enviada" em vez de erro.
      if (erroInsert && erroInsert.code === '23505') {
        resumo.jaEnviadas++
      } else if (erroInsert) {
        throw erroInsert
      } else {
        resumo.enviadas++
      }
    } catch (err) {
      resumo.erros++
      console.error(`[cobranca-whatsapp] erro ao cobrar ${conta.pessoa_nome} (conta ${conta.id}):`, err.message)
    }
  }

  console.log('[cobranca-whatsapp] execução concluída:', resumo)
  return resumo
}
