# Protocolo do componente Windows — registrado antes da implementação

Registrado em 2026-09-11, antes de qualquer código de produção deste
componente. Ambiente: máquina de desenvolvimento Windows local, PowerShell
5.1 / .NET Framework (`System.Security.Cryptography`), Node v24.16.0.

## 0. Validação prévia real (não simulada)

Antes de desenhar qualquer coisa, testei os dois caminhos de chave
diretamente contra a API do Windows, com chaves de teste nomeadas
`MeuPonto_TESTE_*` e removidas imediatamente após cada teste:

| Caminho | Resultado neste ambiente |
|---|---|
| `Microsoft Platform Crypto Provider` (TPM) | **Disponível e funcional** — criação de chave persistida ECDSA P-256 com `CngExportPolicies.None` teve sucesso. |
| `Microsoft Software Key Storage Provider` (sem TPM) | **Disponível e funcional** — mesma operação teve sucesso. |
| Tentativa de exportar a chave PRIVADA (`Pkcs8PrivateBlob`) em ambos os provedores | **Bloqueada** (lançou exceção) nos dois casos — confirma que a política de não-exportação é aplicada de verdade pelo CNG, não é só uma flag que confiamos sem checar. |
| Assinatura real (`ECDsaCng.SignData`, SHA-256) | 64 bytes — formato **IEEE P1363 cru** (r‖s, 32+32 bytes), não DER. .NET Framework (usado pelo PowerShell 5.1 desta máquina) não expõe `DSASignatureFormat`/`ExportSubjectPublicKeyInfo` (APIs de .NET 5+); por isso o formato de assinatura e o formato de exportação de chave pública abaixo foram escolhidos para serem compatíveis com .NET Framework. |
| Verificação da assinatura pelo `node:crypto` (OpenSSL) | **Válida** para o dado original; **inválida** (rejeitada corretamente) para o dado adulterado — round-trip completo CNG → node:crypto provado de ponta a ponta, com teste negativo. |

Conclusão: **os dois caminhos (TPM e software) são tratados como
validados nesta máquina de desenvolvimento** — não preciso declarar o
caminho TPM como "não validado", porque ele foi genuinamente exercitado
aqui. Isso pode não se repetir em outra máquina; a checagem em runtime
continua sendo feita a cada cadastro (não é uma suposição herdada deste
teste).

### Decisões de formato (nenhuma delas é criptografia nova — são só
convenções de codificação de um resultado padrão):

- **Assinatura**: ECDSA P-256, SHA-256, formato de saída **raw
  IEEE P1363** (64 bytes, r‖s) — é o que `ECDsaCng.SignData` produz
  nativamente em .NET Framework. Backend verifica com
  `crypto.verify(..., { dsaEncoding: 'ieee-p1363' })` do Node
  (`node:crypto`, OpenSSL) — sem parsing DER manual.
- **Chave pública**: o CNG exporta `EccPublicBlob`, um blob proprietário
  da Microsoft (`BCRYPT_ECCKEY_BLOB`: 4 bytes de magic + 4 bytes de
  tamanho de chave + X (32 bytes) + Y (32 bytes) para P-256). O serviço
  local converte esse blob em **JWK** (`{kty:'EC', crv:'P-256', x, y}`,
  campos em base64url) antes de enviar ao backend — é *parsing
  estrutural* de um formato público e documentado da Microsoft, não uma
  operação criptográfica. O backend usa
  `crypto.createPublicKey({ key: jwk, format: 'jwk' })` (Node/OpenSSL)
  para reconstruir a chave — nenhuma biblioteca de terceiros, nenhum
  algoritmo próprio.
- Ambas as escolhas acima foram testadas de ponta a ponta na seção 0
  antes de virar código de produção.

## 1. Os oito passos do protocolo

1. **Cadastro supervisionado do equipamento.** Admin cria o registro do
   equipamento (`POST /api/ponto-admin/equipamentos`, endpoint já
   existente) vinculado a um colaborador específico. A criação gera,
   além da linha em `ponto_equipamentos`, um **código de vínculo** de uso
   único (`ponto_equipamento_vinculos`), validade de 10 minutos, exibido
   só para o admin — o colaborador não pode se autoautorizar: sem esse
   código gerado por um admin, nenhuma chave é aceita pelo backend.
2. **Chave pública vinculada ao colaborador.** O serviço local, ao
   receber o código de vínculo (colado uma única vez por quem está
   sentado ao equipamento), gera o par de chaves via CNG (TPM se
   disponível, senão KSP de software — decisão automática, registrada) e
   envia `{ codigo_vinculo, chave_publica_jwk, chave_hardware_backed,
   prova_posse }` ao backend. `prova_posse` é uma assinatura, feita na
   hora com a chave recém-criada, sobre o próprio `codigo_vinculo` — o
   backend só aceita a chave pública se essa assinatura for válida
   contra ela mesma, provando que quem enviou a chave pública também
   controla a privada correspondente (impede que alguém envie uma chave
   pública "de outro lugar" sem nunca ter tocado a privada).
3. **Desafio do servidor.** Antes de cada marcação direta, o frontend
   pede `POST /api/ponto/desafios`. O backend gera um `nonce` de 256
   bits, grava com validade de 60s vinculado a
   `usuario_id`+`equipamento_id`, e **assina o desafio inteiro** com uma
   chave ECDSA própria do backend (identidade "assinador de desafios",
   distinta da chave de cada equipamento) — essa assinatura é o que
   permite ao serviço local recusar desafios fabricados por um site
   qualquer que consiga bater na porta local.
4. **Confirmação local.** O serviço local (a) confere Origin/Host contra
   allowlist, (b) confere o token de pareamento local, (c) verifica a
   assinatura do servidor sobre o desafio recebido, (d) mostra uma
   confirmação visível ao usuário antes de assinar. Qualquer falha em
   (a)-(c) rejeita sem nunca chegar a (d).
5. **Assinatura.** Só após (c) e (d) da etapa 4, o serviço local assina
   `{ nonce, equipamento_id, usuario_id, operacao_id, tipo,
   hash_conteudo }` com a chave privada do equipamento (nunca sai do
   CNG) e devolve a assinatura ao frontend.
6. **Validação e persistência.** `POST /api/ponto/marcacoes` recebe a
   assinatura, recalcula `hash_conteudo` a partir da foto realmente
   enviada (rejeita se não bater), verifica a assinatura do equipamento
   contra a chave pública cadastrada, e — numa única transação — marca o
   nonce como usado (`UPDATE ... WHERE usado_em IS NULL`) e insere a
   marcação. Retextualização de operação repetida com o mesmo
   `operacao_id` devolve o resultado já existente; mesmo `operacao_id`
   com conteúdo diferente é conflito (409), nunca sobrescreve.
7. **Recuperação após timeout.** Se a resposta ao cliente falhar depois
   da marcação já ter sido persistida (timeout de rede, por exemplo), o
   endpoint existente `GET /solicitacoes/por-operacao/:operacao_id`
   (reaproveitado, ver seção 8 dos testes) permite ao frontend consultar
   pelo `operacao_id` gerado localmente e descobrir que a marcação já
   existe — nunca reenviar cegamente como se fosse nova.
8. **Revogação.** `DELETE /api/ponto-admin/equipamentos/:id` (já
   existente) zera a chave pública associada no servidor. A partir daí
   toda assinatura desse equipamento falha na verificação — o serviço
   local não precisa ser avisado nem "saber" que foi revogado; a garantia
   é inteiramente do lado do servidor.

## 2. O que este protocolo não prova (reafirmado antes de codificar)

- Não prova presença humana — prova posse de uma chave que nunca saiu de
  um equipamento cadastrado. Continua exigindo senha + foto + revisão
  humana como hoje.
- `chave_hardware_backed=true` enviado pelo serviço local é
  **informativo**, nunca uma prova remotamente atestada — o backend não
  tem como confirmar, à distância, que o CNG realmente usou o TPM e não
  mentiu; é o mesmo problema whitepaper de qualquer atestação de software
  sem *remote attestation* de verdade (que está fora de escopo deste
  piloto).
- Não resiste a administrador local da máquina nem a sessão Windows já
  comprometida (ver §7 da proposta original).
- Nenhuma mudança aqui altera `EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA` fora
  do ambiente de teste isolado, nem ativa `piloto_ativo` em lugar
  nenhum — ver `MATRIZ_AUTORIZACAO_ENDPOINTS.md` §6 (a ser adicionada) e
  `equipamento.js`.

## 3. Verificação de colisão (branches/migrations)

- Última migration existente: `20260101000051_meu_ponto_seguranca_funcoes.sql`.
  Próxima migration desta etapa: `20260101000052_meu_ponto_componente_equipamento.sql`.
  Nenhuma migration entre 046 (Financeiro) e 048 (início do piloto) foi
  tocada; nenhuma migration de outra sessão apareceu neste worktree.
- `git status` do worktree backend confirma que os únicos arquivos
  modificados/novos são os já produzidos nas rodadas anteriores deste
  projeto — nenhuma mudança de terceiros para reconciliar.
- Arquivos/scripts de Financeiro (`migrations/estornos_financeiros.sql`,
  `scripts/*financeiro*`, `vivenzza-sync-financeiro.bat`) existem neste
  worktree (é o mesmo repositório) mas **não foram lidos, executados nem
  modificados** nesta etapa — fora do escopo desta implementação.
