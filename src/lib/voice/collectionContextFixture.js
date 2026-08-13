// Voice AI EXTERNAL PILOT READINESS — fixture SINTÉTICA do contexto de
// cobrança que uma futura integração real precisará preencher a partir do
// ERP/CRM. Nesta rodada, NENHUM dado real é buscado — sem lista de
// devedores, sem cron, sem query em contas_financeiras. Só a FORMA da
// interface que o resto do pipeline de voz vai esperar receber um dia.
export function fixtureContextoCobranca() {
  return {
    contaId: 'fixture-conta-0001',
    pessoaId: 'fixture-pessoa-0001',
    tituloId: 'fixture-titulo-0001',
    telefone: '+5511000000000', // sintético — nunca um número real
    valor: 199.90,
    vencimento: '2026-08-20',
    contextoRegua: 'etapa_3_lembrete',
  }
}
