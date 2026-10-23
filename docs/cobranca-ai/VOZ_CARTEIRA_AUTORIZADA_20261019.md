# Voz restrita à carteira autorizada — 19/10/2026

Modo explícito: `node scripts/voice/rodar-fila-cobranca.mjs --approved-20261019` é somente leitura/dry-run. Acrescentar `--confirm` permite no máximo UMA originação, exclusivamente dentro de 09–17 Brasília em dia útil e após todos os gates. Não é cron nem fila global.

Antes: auditoria fresca com `scripts/audit-approved-portfolio.mjs`, PDF original, comparação título a título com NetVision e CRM. Usar o ambiente existente correto, sem copiar/imprimir credenciais. O relatório privado expira em 30 minutos; indisponibilidade da origem bloqueia.

O modo exige flag persistente `voice_external_enabled=false` e modo geral desligado; autorização humana desta carteira é aplicada somente na cópia efêmera de configuração deste processo. Nenhuma flag persistente/tarefa é habilitada. A allowlist é derivada dos telefones conciliados do PDF, não do número retornado pela fila. A view mantém suas próprias condições de elegibilidade (incluindo a espera após WhatsApp); este patch NÃO as remove.

Filtro de carteira antes do limite; até 120 candidatos para não ficar preso no primeiro bloqueado, mas no máximo uma originação real por execução. Preservados guards globais/financeiros, pagamento, promessa, DNC e quarentena, resposta humana recente, idempotência, régua e tetos de voz. Não são usados os contadores de frete. Verifica aplicação ARI e ausência de canais antes da reserva.

O adapter revalida PDF/auditoria, todos os títulos, saldo, telefone, promessa e resposta antes da reserva. Se o diálogo atual puder ler títulos fora do conjunto conciliado, inclusive dívida anterior a 2025, o cliente fica bloqueado; nunca passar valores arbitrários por variável de canal. Esta proteção pode reduzir elegíveis até existir contexto de diálogo restrito homologado.

Reserva única `integration_events`, provider `vivenzza-approved-voice`, por campanha/cliente, ANTES do POST. Aceite incerto/falha após início da tentativa interrompe o processo e preserva a reserva. Não liberar automaticamente nem apagar auditoria para tentar novamente: recuperação manual futura exige comprovar ausência de tentativa/aceite. Falha de preflight não é registrada como ligação feita.

Lock privado exclusivo por carteira/canal; crash pode deixar lock órfão. Não remover sem provar término do processo e examinar reserva/resultado. O bloqueio conservador de todos os canais ARI é deliberado; chamadas manuais externas ao processo não participam desse lock, portanto a tarefa global deve permanecer desabilitada.

Implementação/testes locais não provam publicação, runtime atualizado ou chamada atendida. Não publicar esta branch financeira sobre a API de frete mais recente. Antes da operação real: revisão crítica final, código commitado, auditoria atual, runtime compatível e preflight. Encerramento: somente evidência atendida → entrada na IA → finalização normal permite declarar a cobrança de voz operacional.

Verificação offline (Node com suporte a `mock.module`): `node --experimental-test-module-mocks --test scripts/tests/unit/approved-voice-*.test.mjs scripts/tests/unit/approved-portfolio.test.mjs scripts/tests/unit/approved-portfolio-dispatch.test.mjs`. Os mocks substituem exclusivamente fronteiras externas; nenhum teste origina chamada real. Resultado observado: 36/36.

Limitações preservadas: calendário ainda não detecta feriados; conferir o dia antes de confirmar. Pool de respostas financeiras usa as três instâncias existentes; pool novo exige revisão da proteção. Divergência financeira exige nova auditoria, não forçar status. Recuperação de reserva/lock requer prova humana/operacional, nunca limpeza automática.
