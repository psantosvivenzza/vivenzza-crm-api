# NetVision — resolução nativa Windows

Base: main77e5a16. Sintoma observado em17/10: dns.lookup IPv4 falha com
ENOTFOUND, enquanto Resolve-DnsName LlmnrNetbiosOnly retorna IPv4 para o
mesmo nome configurado. Cache/reserva conhecidos não respondiam em5s.

Mudança isolada: DNS IPv4 continua primeiro. Nova configuração opt-in
E01_WINDOWS_ALLOWED_IPS (IPv4 separados por vírgula): sem lista válida não
inicia processo nativo nem muda o fallback atual. Não foi configurada em
produção. IPs exigem identificação/aprovação operacional, não descoberta e
aceitação automática. Apenas no Windows, após falha,
consultar o mesmo hostname via PowerShell nativo, sem perfil/interpolação/shell,
com limite4s/16KiB e ambiente mínimo sem credenciais. Aceitar somente um IPv4
distinto presente na lista permitida; unspecified, loopback, APIPA,
multicast, JSON inválido, IPv6, erro, timeout e ambiguidade caem no contrato
anterior: cache correspondente ao hostname, reserva, erro DNS original.
Resolução nativa válida atualiza o mesmo cache existente. Linux não usa o
subprocesso. Requisições simultâneas de mesmo nome/lista compartilham uma
Promise; sem cache temporal novo, chamadas sequenciais podem custar até4s
quando DNS falha e a lista está habilitada. API configE01 permanece
compatível; nenhum endereço fixo novo.

Teste determinístico: node --test scripts/tests/unit/e01-windows-resolution.test.mjs
Baseline:4falhas/10pass, expondo a ausência da resolução nativa. Após correção:
14pass/0fail na primeira versão; após revisão de segurança, 24pass/0fail.
DNS, fs e execFile simulados; nenhum cache operacional apagado.
Sintaxe e git diff --check passaram. Prova nativa adicional no Windows real:
rotina inicial de resolverIpv4Windows resolveu o nome configurado com um IPv4 distinto, sem
escrever cache nem acessar PostgreSQL. Esse teste precedeu a exigência de
allowlist; a versão final com configuração real ainda não foi ativada nem
homologada. Não prova estabilidade contínua.

Regressão combinada (24novos +8existentes):32/32pass, exit0. A suíte antiga
foi usada somente após confirmar ausência de cache preexistente no worktree
exclusivo. Não executada sobre o cache do worker operacional.

Duas revisões críticas Claude concluídas. A final não encontrou bloqueantes;
o revisor não conseguiu executar testes/PowerShell no próprio ambiente, logo
não é evidência independente de execução. Seu risco de parâmetros/env mínimo
é coberto parcialmente pela prova nativa inicial com o MESMO script/execFile;
validação final com allowlist operacional continua gate antes de habilitar.
Latência de até4s extras em falhas sequenciais é limite conhecido, não removido
por single-flight. Não implantar em fluxo sensível sem medir esse impacto.

Não publicado/não aplicado ao worker residente. Nenhum sync financeiro,
restart, mensagem, IA, chamada, migraçãoSQL ou credencial alterados.
Workers existentes não carregam a correção sem implantação/reinício; isso
exige coordenação para não duplicar sync e não disparar alertas reais.

Resolução de nome (DNS ou LLMNR/NetBIOS) NÃO autentica o servidor nem prova
que o PostgreSQL esteja acessível/correto. LLMNR pressupõe rede confiável;
não executar em rede hostil. Resposta ambígua não escolhe interface sozinha,
mas cache/reserva anteriores continuam disponíveis por compatibilidade.
Rollback: voltar código anterior, sem apagar cache ou alterar dados.
