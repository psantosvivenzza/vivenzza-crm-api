// Quando o cliente pede para falar com uma pessoa, o robô PROMETE que alguém
// vai retornar. Este arquivo é o que faz a Vivenzza cumprir a promessa.
//
// ACHADO DO PILOTO (18/09/2026): até aqui, `requires_human` era só uma coluna
// no banco e um número no painel. Ninguém era avisado, nenhuma tarefa era
// criada, e o cliente ficava esperando um retorno que nunca vinha. Prometer e
// não cumprir é pior do que nunca ter ligado — especialmente numa cobrança,
// onde o cliente já está numa conversa desconfortável.
import { supabase } from '../supabase-admin.server.js'
import { pedidoMereceTarefa } from './guardaConteudo.js'

// A regra de QUAIS intents viram tarefa mora em guardaConteudo.js (política
// pura, sem dependência de banco). Aqui fica só o efeito colateral.
export { pedidoMereceTarefa }

const TITULO_POR_INTENT = {
  QUERO_ATENDENTE: 'pediu para falar com uma pessoa',
  CONTESTA_VALOR: 'contesta o valor cobrado',
  SEM_CONDICAO_AGORA: 'disse que não tem condição de pagar agora',
}

/**
 * Cria a tarefa de retorno. SEMPRE best-effort: uma falha aqui nunca pode
 * derrubar a ligação nem a fila — vira log, não exceção.
 */
export async function registrarPedidoDeHumano({
  clienteNome, codigoCliente, telefoneMascarado, intent, transcricao, callId,
}) {
  if (!pedidoMereceTarefa(intent)) return { criada: false, motivo: 'intent_nao_gera_tarefa' }

  const motivo = TITULO_POR_INTENT[intent] ?? 'precisa de atendimento humano'
  const nome = clienteNome || codigoCliente || 'Cliente'

  try {
    // Responsável: quem cuida de cobrança. Sem dono, a tarefa nasce órfã e
    // ninguém se sente responsável por ela.
    const { data: responsavel } = await supabase
      .from('usuarios')
      .select('id')
      .eq('role', 'financeiro')
      .eq('ativo', true)
      .limit(1)
      .maybeSingle()

    const { error } = await supabase.from('tarefas').insert({
      titulo: `Retornar ligação — ${nome} ${motivo}`,
      descricao: [
        `O assistente de voz ligou para ${nome}${codigoCliente ? ` (código ${codigoCliente})` : ''}.`,
        telefoneMascarado ? `Telefone: ${telefoneMascarado}` : null,
        '',
        'O CLIENTE FOI INFORMADO DE QUE UMA PESSOA DA VIVENZZA ENTRARIA EM CONTATO.',
        '',
        transcricao ? `O que o cliente disse: "${transcricao}"` : null,
        callId ? `Ligação: ${callId}` : null,
      ].filter((l) => l !== null).join('\n'),
      // Prazo curto de propósito: a promessa foi feita ao vivo, ao telefone.
      // Retorno no dia seguinte já é tarde.
      prazo: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
      tipo: 'ligacao',
      origem: 'voz-cobranca',
      status: 'pendente',
      responsavel_id: responsavel?.id ?? null,
      intencao_ia: intent,
      prioridade_ia: intent === 'QUERO_ATENDENTE' ? 'alta' : 'media',
      proxima_acao_ia: 'Ligar de volta para o cliente e tratar o caso com uma pessoa.',
    })
    if (error) throw new Error(error.message)

    console.log(`[voice-ai] HANDOFF_TAREFA_CRIADA cliente="${nome}" intent=${intent} call=${callId}`)
    return { criada: true }
  } catch (err) {
    // Alto e claro no log: uma promessa foi feita ao cliente e a tarefa falhou.
    console.error(`[voice-ai] HANDOFF_TAREFA_FALHOU cliente="${nome}" intent=${intent} call=${callId}: ${err.message} — O CLIENTE FOI PROMETIDO UM RETORNO E NINGUEM FOI AVISADO`)
    return { criada: false, motivo: err.message }
  }
}
