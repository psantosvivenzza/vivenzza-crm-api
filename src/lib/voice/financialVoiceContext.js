// Read-only boundary: never trust amounts supplied by a caller/channel.
export function centavos(valor) {
  const texto = String(valor ?? '')
  if (!/^\d+(?:\.\d{1,2})?$/.test(texto)) throw new Error('valor_invalido')
  const [inteiro, decimal = ''] = texto.split('.')
  const resultado = Number(inteiro) * 100 + Number(decimal.padEnd(2, '0'))
  if (!Number.isSafeInteger(resultado)) throw new Error('valor_invalido')
  return resultado
}

export async function consultarContextoFinanceiroVoz({ callId, numero }, deps) {
  try {
    const chamada = await deps.buscarChamada(callId)
    if (!chamada || chamada.campanha !== 'COBRANCA_FILA' || chamada.direction !== 'outbound'
      || chamada.destination_type !== 'EXTERNAL' || !chamada.codigo_cliente
      || chamada.telefone_hash !== deps.hashTelefone(numero)) return { permitido: false }
    if (!(await deps.guardGlobal()).permitido) return { permitido: false }
    const titulos = await deps.buscarTitulos(chamada.codigo_cliente)
    if (!titulos.length) return { permitido: false }
    for (const titulo of titulos) {
      if (!(await deps.guardTitulo(titulo.id, numero)).permitido) return { permitido: false }
    }
    // Re-read after guards; a payment/review occurring during the checks must win.
    const atuais = await deps.buscarTitulos(chamada.codigo_cliente)
    if (!atuais.length || atuais.length !== titulos.length) return { permitido: false }
    const ids = new Set(titulos.map(t => t.id))
    const vistos = new Set()
    let saldoCentavos = 0
    let vencimento = null
    for (const titulo of atuais) {
      if (!titulo.id || !ids.has(titulo.id) || vistos.has(titulo.id)
        || String(titulo.codigo_cliente) !== String(chamada.codigo_cliente)
        || !/receb/i.test(titulo.tipo ?? '') || !['aberta', 'vencida'].includes(titulo.status)
        || titulo.em_revisao || titulo.em_revisao_financeira
        || !/^\d{4}-\d{2}-\d{2}$/.test(titulo.vencimento)
        || Number.isNaN(Date.parse(`${titulo.vencimento}T00:00:00Z`))
        || new Date(`${titulo.vencimento}T00:00:00Z`).toISOString().slice(0, 10) !== titulo.vencimento
        || titulo.vencimento >= deps.hoje()) return { permitido: false }
      vistos.add(titulo.id)
      const saldo = centavos(titulo.valor) - centavos(titulo.valor_pago ?? 0)
      if (saldo <= 0) return { permitido: false }
      saldoCentavos += saldo
      if (!Number.isSafeInteger(saldoCentavos)) return { permitido: false }
      if (!vencimento || titulo.vencimento < vencimento) vencimento = titulo.vencimento
    }
    for (const titulo of atuais) {
      if (!(await deps.guardTitulo(titulo.id, numero)).permitido) return { permitido: false }
    }
    return { permitido: true, saldoCentavos, vencimento, quantidade: vistos.size }
  } catch {
    return { permitido: false }
  }
}

export async function carregarContextoFinanceiroVoz(identificacao) {
  const [{ supabase }, guards, { hashTelefone }, { hojeBrtISO }] = await Promise.all([
    import('../supabase-admin.server.js'), import('./collectionGuardsForVoice.js'),
    import('./reguaTentativas.js'), import('../collection/collectionContactPolicy.js'),
  ])
  return consultarContextoFinanceiroVoz(identificacao, {
    hashTelefone, hoje: hojeBrtISO,
    guardGlobal: guards.avaliarGuardGlobalParaLigacao,
    guardTitulo: guards.avaliarGuardsTituloParaLigacao,
    buscarChamada: async callId => {
      const { data, error } = await supabase.from('voice_calls')
        .select('campanha,direction,destination_type,codigo_cliente,telefone_hash')
        .eq('call_id', callId).maybeSingle()
      if (error) throw error
      return data
    },
    buscarTitulos: async codigo => {
      const { data, error } = await supabase.from('contas_financeiras')
        .select('id,codigo_cliente,tipo,status,valor,valor_pago,vencimento,em_revisao,em_revisao_financeira')
        .eq('codigo_cliente', codigo)
        .in('status', ['aberta', 'vencida']).lt('vencimento', hojeBrtISO())
      if (error) throw error
      return (data ?? []).filter(t => /receb/i.test(t.tipo ?? ''))
    },
  })
}
