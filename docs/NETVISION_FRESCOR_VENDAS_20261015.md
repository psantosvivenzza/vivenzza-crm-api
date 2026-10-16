# Indicadores NetVision: conclusão comprovada

15/10/2026. Worktree exclusiva vivenzza-netvision-sales-freshness-20261015, branch codex/netvision-sales-freshness-20261015, base origin/main 75b5f4f83c61d9cf873d90a9bf11fb77883c9c47 após fetch. Somente Codex escreve neste caminho novo. Raízes e worktrees de frete preservadas. Histórico Git de todos os refs não apontou correção anterior desses dois arquivos além dos commits históricos cdf89be/9099043.

Problema reproduzido: vendaFiscalSyncStatus e vendaGerencialSyncStatus consideravam disponível um ciclo concluido_com_erros com contador zero, status desconhecido ou concluido_em futuro. Isso podia disponibilizar agregações sem conclusão confiável no dashboard.

Correção: somente concluido pode passar; concluido_com_erros bloqueia mesmo com contador zero, preservando motivo ultimo_sync_com_erros. Status desconhecido retorna ultimo_sync_status_invalido. Timestamp futuro retorna timestamp_futuro antes do arredondamento, inclusive +1ms. Relógio é lido uma vez para decisão/idade consistentes. Falhou/executando, filtro dry_run=false, tabela por domínio, limite default/configurado e arredondamento existente são preservados.

Produtores atuais de ambos os read-models escrevem executando, concluido, concluido_com_erros e falhou. Dashboard usa disponivel para não consultar agregação quando falso. Fiscal EN_Notas e gerencial EN_NotasRepres continuam separados; Série99 não foi reclassificada. Nenhum job, scheduler, consulta de dados real, pagamento, estoque, pedido ou emissão foi executado/alterado.

Validação sintética: Node24.16.0, node --test scripts/tests/unit/netvision-sales-freshness.test.mjs. Inicial 38 casos, 10 falhas esperadas; final 38/38 aprovados. Imports dos módulos reais e apenas cliente administrativo substituído, sem .env/banco/rede. Cobertura inclui estados, futuros de 1ms/29s/2min, instante atual, timestamp inválido/ausente, consulta com falha/exceção, domínio/filtro/ordenação, limite customizado/default e shape do retorno. Sintaxe e git diff --check aprovados. Evidências RED/GREEN no output do workspace. Testes PostgreSQL antigos não rodados no cluster compartilhado do frete.

Risco: relógio do produtor adiantado indisponibiliza conservadoramente o indicador até o relógio alcançá-lo; alinhar relógios no gate operacional. A granularidade arredondada de expiração já existente foi preservada. Não há prova de dados reconciliados em produção ou de cobertura por filial/período do log de sync; este incremento não promete resolver toda a conciliação do ERP.

Revisão Claude somente leitura: exit0, SEM ACHADOS BLOQUEANTES, ferramentas desativadas e sem sessão persistida. Codex confirmou concluido_em como timestamptz nas migrations037 e043, sem consultar schema de produção; produtores e fixtures existentes usam os estados preservados. Dashboard não possui switch fechado dos motivos: usa disponivel e texto genérico de indisponibilidade. Contador fiscal nulo permanece permitido por compatibilidade; negativos/malformados são comportamento preexistente, fora deste diff. Clock skew e escopo temporal/filial do log continuam gates operacionais.

Após revisão, reforçados apenas os testes: arredondamento aos29.999/30.000ms além do limite e fallback de falhou para iniciado_em. Resultado final42/42, exit0; fonte de produção não mudou após a revisão. Node24.16.0 é a versão usada; registerHooks exige runtime recente, não foi alterado CI nem engines.

Sem push, merge, deploy ou mudanças em dados reais. Preparar integração com guards financeiros existentes em pacote revisável; integração e regressão combinada ainda são gates próprios.
