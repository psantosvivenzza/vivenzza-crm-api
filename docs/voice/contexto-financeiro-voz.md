# Contexto financeiro na conversa de voz

Implementação de 05/10/2026, sem escrita financeira nem ativação de campanhas.

- A fila passa somente o identificador do destinatário ao canal. O serviço vincula a chamada ao registro `voice_calls` por `call_id`, campanha, direção, destino externo e hash do telefone. Sem vínculo inequívoco, bloqueia conteúdo financeiro.
- O saldo vem exclusivamente do read-model atual de `contas_financeiras`. Guards existentes de sincronização, pagamento, promessa ativa e DNC são reavaliados; títulos são relidos para detectar baixa/revisão durante a consulta. Duplicidade, data inválida, erro e saldo não positivo bloqueiam.
- Saldo parcial é calculado em centavos inteiros. O texto apresenta saldo total vencido e informa explicitamente o vencimento **mais antigo**; não atribui ao total uma data única falsa.
- Identidade e disponibilidade são confirmadas antes da leitura/divulgação. Valores não são enviados ao modelo generativo.
- Pagamento informado e divergência terminam a conversa financeira sem fingir baixa, acordo ou promessa registrada. Pedido explícito de atendente conserva o mecanismo existente de tarefa; demais desfechos ficam no registro da chamada, não criam tarefa por inferência.
- Chamadas da fila dispõem de pelo menos seis turnos. Testes manuais genéricos mantêm o limite anterior e não obtêm contexto de clientes.

## Verificação e liberação

Testes locais: conversa sintética, cálculo exato, vínculo, pagamento parcial, revisão, DNC/promessa, indisponibilidade e erro de consulta; integração da fila em Postgres exclusivo e round-trip STT/TTS real.

Publicação, carregamento no serviço residente e chamada atendida com entrada no fluxo/encerramento normal são marcos separados. Teste unitário ou estado READY não substitui a homologação telefônica. Não considerar cobrança em produção homologada sem essa evidência. Uma reconsulta reduz a janela de corrida, mas não é transação atômica com a fala: alterações posteriores no banco só podem ser observadas na próxima consulta.
