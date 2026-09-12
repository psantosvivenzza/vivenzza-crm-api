# Proposta delimitada — componente de identificação de equipamento (Windows)

Documento de **arquitetura**, não de implementação. Nada aqui foi
codificado nesta etapa; `EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA` continua
`false`. Objetivo: desbloquear `POST /api/ponto/marcacoes` (criação direta,
sem passar por solicitação/aprovação) com uma prova real de equipamento —
nunca prova de presença humana, nunca substituindo foto+senha+revisão.

## 1. Regras que não podem ser quebradas

- **Nenhuma criptografia própria.** Só primitivas padrão, mantidas por
  terceiros auditados: Windows CNG para geração/armazenamento de chave,
  ECDSA P-256 (ou RSA-PSS) para assinatura, `node:crypto` (OpenSSL) para
  verificação no backend. Nenhum algoritmo, protocolo ou formato inventado.
- **Assinatura de equipamento nunca é prova de presença humana.** Ela prova
  "esta operação passou pela chave privada de um equipamento cadastrado",
  nada além disso. Continua exigindo senha (identidade) e foto (evidência
  revisável) — o componente de equipamento se soma às duas travas
  existentes, não as substitui.
- Nenhum agente instalado em computador de funcionário real nesta etapa.

## 1.1 Mecanismo de chave: CNG, política de exportação e TPM (correção da revisão de 2026-09-11)

Versão anterior desta proposta citava "DPAPI/Credential Manager" como se
isso sozinho garantisse uma chave não exportável — **impreciso**. DPAPI
(`CryptProtectData`/`CryptUnprotectData`) cifra um blob usando material
derivado das credenciais do usuário do Windows; protege o blob **em
repouso** (contra cópia do arquivo pra outra máquina, por exemplo), mas o
próprio usuário/processo autorizado consegue decifrá-lo de volta — não é,
por si só, uma garantia criptográfica de não-exportabilidade.

Mecanismo correto: gerar a chave via **CNG** (`NCryptCreatePersistedKey`),
com a política de exportação explicitamente marcada como **não permitida**
(sem a flag `NCRYPT_ALLOW_EXPORT_FLAG`). Dois provedores possíveis,
escolhidos em tempo de cadastro:

- **Com TPM presente**: `Microsoft Platform Crypto Provider` (KSP
  apoiado em hardware) — a chave privada nunca existe em texto claro fora
  do chip TPM; o SO só pode pedir ao TPM para ASSINAR com ela, nunca
  extraí-la. Esta é a única configuração em que "chave não exportável" é
  uma garantia de hardware, não só uma política de software.
- **Sem TPM**: `Microsoft Software Key Storage Provider` — política de
  não-exportação é aplicada em software pelo CNG (a API não oferece um
  jeito padrão de extrair a chave), mas SEM o TPM não há barreira de
  hardware: alguém com acesso total ao sistema (kernel, disco, ou a própria
  sessão do usuário com ferramentas adequadas) tem, em tese, superfície
  para contornar essa política. **Este caso deve ser sinalizado**
  (`chave_hardware_backed = false` em `ponto_equipamentos`) e comunicado
  como proteção mais fraca — não apresentado como equivalente ao caso com
  TPM.
- **Comportamento sem TPM documentado explicitamente**: o cadastro
  continua funcionando (não bloqueia equipamentos sem TPM — a maioria dos
  PCs de escritório mais antigos não tem), mas o painel do admin deve
  mostrar essa distinção por equipamento, e a decisão de aceitar
  equipamentos sem TPM é do negócio, não uma escolha técnica silenciosa.

## 2. Cadastro supervisionado e revogação

Reaproveita o schema já existente (`ponto_equipamentos`, modo
`demonstracao` hoje) com duas colunas novas — `chave_publica` (SPKI/PEM) e
`chave_hardware_backed` (booleano, ver 1.1) — e o fluxo:

1. Admin inicia o cadastro no painel (`POST /api/ponto-admin/equipamentos`
   já existe) — gera um **código de vínculo** de uso único, validade curta
   (10 min), exibido só para o admin.
2. O colaborador, no computador autorizado, abre o serviço local pela
   primeira vez e informa esse código.
3. O serviço local gera o par de chaves via CNG (ver 1.1 — TPM se
   disponível, senão o KSP de software, sempre com a política de
   exportação desligada), envia a chave pública + `chave_hardware_backed`
   (booleano: usou TPM ou não) + o código de vínculo ao backend.
4. Backend valida o código (existe, não expirou, não foi usado), grava a
   chave pública em `ponto_equipamentos.chave_publica`, marca `modo =
   'producao'` só para ESTE equipamento.
5. Revogação: admin usa o `DELETE /api/ponto-admin/equipamentos/:id` já
   existente — zera/invalida a chave pública no servidor. A próxima
   tentativa de assinatura desse equipamento falha na verificação,
   **independente de o serviço local "saber" que foi revogado** (o serviço
   local nunca precisa ser avisado — a garantia é do lado do servidor).

## 3. Desafio de uso único, vinculado a usuário e operação

Reaproveita `ponto_desafios` (já no schema, migration 048):

1. Antes de tentar marcar, o frontend pede um desafio:
   `POST /api/ponto/desafios` — corpo `{ equipamento_id }`. Backend gera
   `nonce` aleatório (256 bits), grava com `expira_em = now() + 60s`,
   **assina o próprio desafio** com uma chave do servidor (HMAC ou
   assinatura, para o serviço local poder confirmar que o desafio é
   legítimo, não fabricado por um site qualquer que conseguiu bater na
   porta local).
2. Frontend repassa `{ nonce, equipamento_id, operacao_id, tipo,
   hash_da_foto, assinatura_do_servidor }` pro serviço local (ver seção
   4) — `hash_da_foto` (SHA-256 do buffer capturado) amarra a assinatura
   ao CONTEÚDO real submetido, não só aos metadados: sem isso, uma
   assinatura capturada por replay poderia, em tese, ser reaproveitada com
   uma foto diferente enquanto o nonce ainda fosse válido.
3. Serviço local confirma a assinatura do servidor no desafio, e só então
   assina `{ nonce, equipamento_id, usuario_id, operacao_id, tipo,
   hash_da_foto, timestamp_local }` com a chave privada do equipamento —
   vinculando a assinatura ao usuário, ao equipamento, à operação E ao
   conteúdo relevante, todos ao mesmo tempo, não apenas um deles.
4. Frontend envia a assinatura resultante junto com `POST
   /api/ponto/marcacoes`.
5. Backend: recalcula o hash da foto recebida e confirma que bate com
   `hash_da_foto` assinado (rejeita se a foto enviada for diferente da
   assinada); valida a assinatura com a chave pública cadastrada PARA O
   `equipamento_id` informado (rejeita se a assinatura vier de uma chave
   diferente); confirma que o `nonce` existe, pertence a esse mesmo
   `equipamento_id`, não expirou, e **marca como usado atomicamente**
   (`UPDATE ponto_desafios SET usado_em = now() WHERE nonce = $1 AND
   usado_em IS NULL` — mesmo padrão de proteção contra corrida já usado no
   resto do piloto). Nonce reutilizado (replay) nunca passa dessa checagem;
   nonce de outro equipamento nunca é aceito nem que a assinatura "bata".

## 4. Comunicação frontend ↔ serviço local e proteção de origem

O navegador não acessa CNG diretamente — precisa de um serviço HTTP local
que o frontend chama via `fetch`. Ameaça central desta seção: **um site
malicioso, aberto na mesma máquina/navegador, tentando usar o serviço
local como um "assinador" a seu favor**. Nenhuma camada abaixo é suficiente
sozinha — juntas, cada uma fecha o que a anterior deixaria passar:

1. **Só escuta em loopback** (`127.0.0.1`, nunca `0.0.0.0`) — inacessível
   pela rede local; só reduz de "qualquer host na rede" para "processos
   nesta máquina", não resolve o problema de um site no mesmo navegador.
2. **CORS restritivo**: `Access-Control-Allow-Origin` só para o(s)
   domínio(s) reais do CRM (nunca `*`), checado no header `Origin` da
   requisição — barra a maioria dos navegadores modernos respeitando CORS,
   mas não é a única linha de defesa (requisições fora do navegador, ou
   navegadores mal configurados, não respeitam CORS).
3. **O serviço local só assina desafios que conferem a assinatura do
   servidor** embutida neles (seção 3, passo 3) — mesmo que um site
   malicioso consiga bater na porta local, ele não tem a chave do servidor
   pra fabricar um desafio que o serviço aceite assinar. Esta é a defesa
   estruturalmente mais forte: não depende do navegador respeitar nada.
4. **Token de pareamento local** de curta duração entre frontend e
   serviço (gerado quando o serviço inicia, mostrado só na UI do serviço,
   colado uma vez pelo colaborador) — reduz ainda mais quem consegue
   conversar com o serviço, mesmo dentro da própria máquina.
5. **Confirmação visível ao usuário a cada assinatura** (notificação do
   sistema/bandeja, não silenciosa) — mesmo que as quatro camadas acima
   falhassem, o colaborador veria uma assinatura acontecendo que ele não
   pediu. Camada de detecção humana, não técnica — última linha, não a
   principal.

## 5. Integração com backend e interface

- `POST /api/ponto/desafios` (novo) — gera desafio.
- `POST /api/ponto/marcacoes` (já existe, hoje bloqueado) — passa a aceitar
  `{ ..., equipamento_id, nonce, assinatura }`; verifica assinatura +
  consome o nonce antes de qualquer outra coisa; só então segue para
  senha/foto/idempotência, exatamente como o fluxo já testado hoje.
- Frontend: `MeuPonto.jsx` ganha uma detecção de "serviço local disponível"
  (tenta `fetch` num endpoint de status do serviço); se disponível, oferece
  marcação direta; se não, continua oferecendo "Solicitar marcação" (fluxo
  provisório atual) — nunca trava o colaborador sem alternativa.
- `PontoAdmin.jsx`: tela de cadastro ganha o fluxo de "gerar código de
  vínculo" com exibição temporária e countdown.

## 6. Testes locais possíveis sem instalar em computador de funcionário

Todo o ciclo é testável numa máquina de desenvolvimento/VM Windows
qualquer, com um "colaborador de teste" sintético — nenhuma máquina real
de funcionário é necessária:

1. Instalar o serviço local numa VM de teste; cadastrar um equipamento de
   teste vinculado a um usuário sintético via código de vínculo real.
2. Gerar um desafio real, assinar, validar no backend — marcação direta
   bem-sucedida.
3. Revogar o equipamento; repetir o passo 2; confirmar rejeição
   (assinatura de chave já invalidada).
4. Reenviar a MESMA assinatura/nonce de uma tentativa anterior (replay);
   confirmar rejeição.
5. De uma página HTML local **fora** do domínio do CRM, tentar chamar a
   porta do serviço local; confirmar rejeição por CORS/Origin.
6. Deixar o desafio expirar (esperar > 60s) antes de assinar; confirmar
   rejeição por expiração.
7. Trocar de equipamento sem revogar o antigo; confirmar que o backend
   exige autorização explícita (endpoint de troca, não implícito).
8. Assinar um desafio válido, depois trocar a foto enviada por outra antes
   de mandar pro backend; confirmar rejeição (`hash_da_foto` não bate).
9. Usar o nonce/assinatura de um equipamento diferente do informado no
   corpo; confirmar rejeição (nonce não pertence a esse `equipamento_id`).
10. Repetir o cadastro numa VM sem TPM (KSP de software); confirmar que o
    cadastro funciona mas `chave_hardware_backed=false` fica registrado e
    visível no painel do admin.

Critério de pronto para mudar `EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA` para
`true`: os 10 cenários acima automatizados e passando contra um Postgres
isolado + serviço local real rodando numa VM de teste — nunca contra
mock/simulação da assinatura.

## 7. Limitações que continuam existindo (nunca apresentadas como resolvidas)

- **Sessão do Windows comprometida**: a assinatura prova "este computador
  cadastrado", não "esta pessoa está presente". Se a sessão do usuário já
  estiver comprometida (malware, alguém sentado no lugar dele já logado),
  a assinatura continua válida. Só a combinação com senha + foto + revisão
  humana mitiga parcialmente — nunca elimina.
- **Câmera virtual**: software de câmera virtual alimenta `getUserMedia`
  com imagem/vídeo pré-gravado. A assinatura de equipamento **não
  detecta isso** — é um problema de captura, ortogonal à assinatura.
  Resolver exigiria prova de vida, explicitamente fora de escopo deste
  piloto.
- **Administrador local**: nunca prometer resistência a ele. Mesmo no
  melhor caso (chave gerada com TPM, política de exportação desligada), um
  administrador local não consegue EXTRAIR a chave privada, mas continua
  podendo USÁ-LA através do serviço local instalado — basta rodar como o
  usuário certo (ou o próprio serviço, se ele não checar isso) e pedir uma
  assinatura como se fosse a sessão legítima. TPM resolve "exfiltração pra
  outra máquina", não "uso indevido dentro da mesma máquina/sessão". Sem
  TPM (KSP de software), a garantia é ainda mais fraca — extração também
  não está descartada com ferramental adequado e acesso de administrador.
  Em nenhum dos dois casos isto deve ser apresentado como resistente a
  administrador local — é limitação real, comunicada ao negócio, não
  escondida.
- Mesmo com este componente implementado, nada aqui vira "prova de
  presença humana", "antifraude" ou "REP-P homologado" — continua um
  piloto interno com essas mesmas restrições de linguagem.
