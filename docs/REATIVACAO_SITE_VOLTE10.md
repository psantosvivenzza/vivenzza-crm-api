# Reativação do site — VOLTE10

Implementação isolada para publicação no backend existente. Ativação depende de configuração explícita em banco, desabilitada por padrão.

A mesma Lara (modelo e conhecimento técnico de sdr.js) atende pelo novo endpoint POST /api/sdr/site-reativacao/webhook. A resposta usa a instância de origem exata autorizada via SDR_SITE_INSTANCE. SDR_SITE_ENABLED deve ser true para habilitar. O token existente EVOLUTION_WEBHOOK_TOKEN é obrigatório nessa rota, sem criar credenciais novas. Não configurar webhook antes da publicação e dos testes.

Campanha: 10%, um uso por cliente, sem mínimo, sem cumulação, sem desconto sobre frete, até 30/10/2026 23:59 BRT. Texto da mensagem e arte aprovados estão em outputs/reativacao-site-2026-10-23 no workspace principal.

A IA só responde a contatos conhecidos em leads, respeita whatsapp_opt_out, atendimento_humano e vendedor_assumiu. Erros de consulta impedem respostas. Respostas por texto; sem áudio ou catálogo automático. Atendimento da campanha também funciona no horário comercial. Nenhuma configuração financeira ou limite global alterado.

Publicação: aplicar primeiro as migrations da campanha, criar a linha site_campaign_config desabilitada com a instância exata, importar contatos (scripts/import-site-campaign.mjs, preview por padrão, --apply para gravar), publicar backend e configurar webhook dedicado para MESSAGES_UPSERT e MESSAGES_UPDATE. Verificar modelo, imagem, autenticação e rejeição de desconhecidos antes de habilitar enabled e ai_verified. Não ativa o job global de reativação.

Verificação: node --check src/routes/sdr.js; node --test scripts/tests/site-campaign-policy.test.mjs. Revisão Claude obrigatória antes de concluir.

Fila em src/jobs/site-campaign.js: tabelas exclusivas com RLS, acesso somente do servidor e unicidade por campanha/lead; reserva atômica; 30 tentativas/dia, 10/hora e 90s mínimos; dias úteis, 09h–17h30 BRT; cron a cada dois minutos. Expiração automática; timeout pausa sem retry. Histórico site_campaign_conversas separado; desconhecidos não criam lead; reativação antiga exclui participantes registrados. Para interromper, definir site_campaign_config.enabled=false. Reservas incertas exigem conferir o provedor antes de qualquer recuperação manual.

Com início em 26/10 há capacidade para até 150 destinatários antes do vencimento; os restantes não recebem oferta vencida. Testes simulados não comprovam entrega real: acompanhar evolution_id, sent_at e recibos no histórico. A mesma IA atende com instruções específicas da campanha, por texto, sem áudio ou catálogo automático.
