# Prazo no transporte de alertas

O ciclo financeiro residente aguarda a conferência e eventualmente enviarAlertaWhatsapp antes de continuar. Esse helper compartilhado também é utilizado por relatórios/guards. O axios.post anterior tinha timeout efetivo zero: falta de resposta podia manter o await pendente sem prazo.

Patch adiciona timeout HTTP de 15 segundos e AbortSignal.timeout de 15 segundos, para limitar também esperas de conexão. Não usa Promise.race nem inicia outro envio em paralelo. Preserva destinatário, payload, instância, autenticação e tratamento de erro pelos chamadores. Não adiciona retries. Timeout/abort não prova ausência de entrega: não reenviar cegamente.

Teste: node --test scripts/tests/unit/whatsapp-alert-timeout.test.mjs. Um caso de contrato reproduziu a falha antes do patch (timeout 0 em vez de 15000). A suíte usa fixtures sintéticas e adapters falsos, mais servidor HTTP exclusivamente em 127.0.0.1 que aceita e nunca responde. Nenhuma URL ou credencial real é utilizada, nenhum dotenv é carregado. Requer runtime com AbortSignal.timeout (Node 16.14+/17.3+; executado em Node 24).

Limite: corrige uma espera ilimitada comprovada no código, mas não comprova que ela seja a causa do worker atualmente sem progresso. Não resolve esperas de leitura/gravação/conferência em outros pontos nem homologa o ciclo financeiro. Não foi aplicado ao worker ou à API de produção. Implantação exige controlar os consumidores compartilhados, verificar backup/janela e obter autorização específica para reativação que escreva dados financeiros ou envie mensagens. Não alterar env/flags/limites de envio por este patch.

Referência da opção timeout: https://axios-http.com/docs/req_config . A implementação usa a dependência já instalada/lockfile existente, sem atualização de pacote.

Revisão crítica Claude concluída, somente leitura, sem bloqueantes. Gates adicionais: conferir AbortSignal.timeout no runtime de todos os consumidores antes de implantação (não alterar engines global por inferência). ERR_CANCELED pode representar o prazo total expirado, não cancelamento humano. O cooldown financeiro é marcado antes da tentativa; uma tentativa abortada pode suprimir outro alerta durante o cooldown. Não mover esse marco sem decidir como evitar duplicação em entrega ambígua. Este patch limita a espera, mas não garante entrega de alertas.
