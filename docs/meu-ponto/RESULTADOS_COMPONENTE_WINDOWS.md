# Resultados — implementação do componente Windows em ambiente de desenvolvimento

Registrado em 2026-09-11. Implementação real (não um protótipo descartável)
do componente de identificação de equipamento descrito em
`PROPOSTA_COMPONENTE_EQUIPAMENTO.md` e protocolado em
`PROTOCOLO_COMPONENTE_WINDOWS.md`, feita e testada inteiramente dentro deste
worktree de desenvolvimento. Nada foi commitado, nada foi enviado a nenhum
remoto, nenhuma máquina real de funcionário foi tocada, nenhum serviço
persistente/autostart foi instalado. `EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA`
continua `false` — é este milestone técnico que prova a capacidade existe e
funciona de verdade, não o evento que a ativa.

## 1. O que foi implementado

### Backend (`vivenzza-meu-ponto-backend`)

- `supabase/migrations/20260101000052_meu_ponto_componente_equipamento.sql`
  — schema: chave pública (JWK) + sinalização hardware-backed + segredo HMAC
  por equipamento em `ponto_equipamentos`; tabela nova
  `ponto_equipamento_vinculos` (código de vínculo de uso único); campos
  novos em `ponto_desafios` (usuário, tipo, hash de conteúdo, assinatura do
  servidor).
- `supabase/migrations/20260101000053_meu_ponto_registro_assinado.sql` —
  função `ponto_registrar_marcacao_assinada` (`SECURITY INVOKER`,
  `search_path` fixo, `REVOKE`/`GRANT` condicional — mesma disciplina da
  migration 051), atômica: consumo do nonce + revalidação fresca de
  equipamento/usuário/piloto + inserção da marcação numa única transação.
- `src/lib/ponto/assinaturaEquipamento.js` — primitivas puras: verificação
  ECDSA P-256/SHA-256 (formato raw IEEE P1363, o que o CNG via .NET
  Framework produz de verdade — validado empiricamente, não assumido),
  HMAC-SHA256 para autenticidade do desafio, geração de nonce/segredo/código
  de vínculo. Só `node:crypto` (OpenSSL) — nenhum algoritmo próprio.
- `src/lib/ponto/equipamentoService.js` — lógica de negócio (cadastro
  supervisionado com prova de posse, emissão de desafio, registro de
  marcação assinada), chamada tanto pelas rotas reais quanto diretamente
  pelos testes.
- `src/routes/ponto-equipamento.js` (novo router, sem `auth`) +
  extensões em `src/routes/ponto.js` (`POST /desafios`, corpo real de
  `POST /marcacoes`) e `src/routes/ponto-admin.js`
  (`POST /equipamentos/:id/vinculos`) — todas as rotas novas checam
  `EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA` como primeira linha, exatamente
  como `POST /marcacoes` já fazia.
- `src/index.js` — monta o novo router, deliberadamente SEM o middleware
  `auth` (ver §2).

### Componente Windows (`local-equipamento-service/`, novo diretório, nada instalado)

- `cng-operacoes.ps1` — único ponto de contato com CNG: criação de chave
  persistida (TPM via `Microsoft Platform Crypto Provider`, com fallback
  automático para `Microsoft Software Key Storage Provider` se o TPM não
  estiver disponível/utilizável), assinatura (`ECDsaCng.SignData`), remoção
  de chave. Política de exportação sempre `None`.
- `confirmar.ps1` — confirmação visível ao usuário via caixa de diálogo
  nativa do Windows (`System.Windows.Forms.MessageBox`) antes de assinar.
- `servico.mjs` — serviço HTTP local (Node, `node:http`, sem framework),
  loopback-only, com as 6 camadas de defesa descritas na proposta original
  (loopback, allowlist de Origin, allowlist de Host, token de pareamento
  local, verificação do HMAC do desafio, confirmação visível). Roda só
  manualmente (`node servico.mjs`); sem autostart, sem instalação como
  serviço do Windows.

### Frontend (`vivenzza-meu-ponto-frontend`)

- `src/pages/PontoAdmin.jsx` — botão "Gerar código de vínculo" por
  equipamento em modo demonstração; trata 501 como estado esperado
  ("ainda não disponível nesta etapa"), não como erro.
- Texto do aviso da tela de Equipamentos corrigido para não overclaim nem
  underclaim o estado real (implementado e testado em dev, ainda bloqueado
  em produção).
- Não implementado nesta rodada: a UI de assinatura no lado do colaborador
  (`MeuPonto.jsx` detectando o serviço local e oferecendo marcação direta)
  — decisão deliberada de escopo: com o gate estruturalmente fechado, essa
  tela nunca teria um caminho de sucesso pra testar num navegador real
  além do que a tela de admin já cobre; fica como próximo passo natural
  para quando o gate for reavaliado.

## 2. Por que `/api/ponto-equipamento/vincular` não tem `auth`

Decisão deliberada, não um descuido: o serviço local nunca deve carregar o
JWT/senha do colaborador (reduz o que pode vazar se o processo local for
comprometido). A única credencial aceita nesta rota é o código de vínculo
de uso único (≈120 bits de entropia, validade de 10 minutos, gerado só por
um admin) — mesmo padrão de "código de pareamento de uso único" usado por
outros fluxos de emparelhamento de dispositivo. Protegida por rate limit
de 20 tentativas/10min por IP.

## 3. Provado de verdade vs. informativo/não verificado

| Afirmação | Status | Como foi verificado |
|---|---|---|
| CNG cria chave ECDSA P-256 com política de não-exportação real (TPM) | **Provado** | `PROTOCOLO_COMPONENTE_WINDOWS.md` §0 — tentativa real de exportar a chave privada falhou; TPM genuinamente presente e exercitado nesta máquina de desenvolvimento |
| CNG cria chave ECDSA P-256 com política de não-exportação real (sem TPM, KSP de software) | **Provado** | Mesmo teste, provider de software — export também bloqueado, mas sem barreira de hardware (ver limitação documentada na proposta original §7) |
| Assinatura CNG é reconhecida pelo `node:crypto` (formato raw IEEE P1363) | **Provado** | Round-trip real: assinar no PowerShell, verificar no Node, com teste positivo e negativo (dado adulterado) |
| Mecanismo de desafio/nonce/assinatura funciona de ponta a ponta contra Postgres real | **Provado** | 19 testes em `componente-equipamento.test.mjs`: assinatura válida/inválida, usuário/equipamento errados, conteúdo alterado, desafio expirado, replay, concorrência real, timeout/idempotência, equipamento revogado, usuário desativado, piloto desativado, falha de banco real (trigger), GRANT/REVOKE com papel restrito real |
| Serviço local real (processo Node + PowerShell) executa o protocolo completo, incluindo CNG real desta máquina | **Provado** | 5 testes em `componente-windows-real.test.mjs`, incluindo um cadastro completo + assinatura de marcação aceita pela função Postgres real |
| Gate estrutural (`EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA=false`) bloqueia as 4 rotas novas mesmo com payload real e válido de ponta a ponta | **Provado** | 5 testes HTTP em `componente-equipamento-gate-http.test.mjs` — a propriedade de segurança mais importante desta entrega |
| Origin/Host allowlist e token de pareamento do serviço local rejeitam acesso não autorizado | **Provado** | Testado com origem maliciosa e token errado, ambos contra o serviço local real rodando |
| Confirmação visível (caixa de diálogo nativa) funciona quando um humano de fato clica | **NÃO verificado nesta sessão** | O código usa a API padrão do Windows (`MessageBox.Show`) e o processo abre a caixa de diálogo real (confirmado — um processo `powershell.exe` ficou aberto esperando), mas uma tentativa de simular o clique via `SendKeys` não conseguiu alcançar a janela nesta sessão não-interativa; o processo precisou ser encerrado manualmente. Os testes automatizados usam `PONTO_LOCAL_SERVICO_AUTO_CONFIRMAR=true`, uma bandeira SÓ de teste (documentada no código), que pula esta etapa. **Pendência real: validar a confirmação clicando de verdade, numa sessão interativa, antes de qualquer demonstração ao negócio.** |
| `chave_hardware_backed=true` é uma prova remotamente atestada de que o TPM foi usado | **Nunca foi essa a alegação** | Informativo — o backend grava o que o serviço local reporta, sem verificação remota de atestação (fora de escopo deste piloto, documentado desde a proposta original) |
| Este componente prova presença humana / substitui REP-P / é antifraude | **Nunca foi essa a alegação** | Continua exigindo senha + foto + revisão humana; a assinatura de equipamento soma uma terceira trava, nunca substitui as duas primeiras |

## 4. Custos e dependências identificados

- **Nenhum custo de licenciamento novo** — CNG é parte do Windows;
  `node:crypto` é built-in do Node.
- **.NET Framework via PowerShell 5.1** — usado para acessar CNG a partir
  do serviço local; disponível por padrão em qualquer Windows 10/11.
  Confirma que o formato de assinatura (raw IEEE P1363) e o formato de
  export de chave pública (`BCRYPT_ECCKEY_BLOB`) são os de .NET Framework,
  não os de .NET 5+ — qualquer reimplementação futura do serviço local
  numa stack diferente (.NET 5+, C++ direto) precisaria confirmar os
  mesmos formatos de novo, não assumir que são idênticos.
- **Distribuição da chave pública de assinatura de desafio** — o backend
  usa uma chave/segredo HMAC POR EQUIPAMENTO (gerado no cadastro,
  devolvido uma única vez ao serviço local), não uma chave global — não há
  problema de distribuição de segredo global para resolver. Pendência real
  para produção: nenhuma, dado este desenho.
- **Nenhum serviço pago contratado.**
- **Empacotamento/instalação real do serviço local** — fora de escopo
  desta rodada (proibido explicitamente). O que existe hoje é um script
  Node rodado manualmente; transformar isto num instalável real (MSI,
  serviço gerenciado, atualização automática seletiva) é trabalho futuro
  não iniciado.

## 5. Checklist de revisão antes de qualquer instalação real

Nada disto foi feito nesta rodada — é a lista do que precisa acontecer
ANTES de considerar instalar em um computador de funcionário de verdade:

- [ ] Confirmar a confirmação visível (caixa de diálogo) funcionando com um
      clique humano real, numa sessão interativa (pendência da seção 3).
- [ ] Decidir e implementar como o serviço local será distribuído/instalado
      (hoje é só um script rodado manualmente) — sem virar serviço
      persistente/autostart sem uma decisão de negócio explícita sobre isso.
- [ ] Confirmar o nome real do papel de serviço do Supabase da conta real
      (pendência herdada das migrations 050/051, também vale para a 053).
- [ ] Decidir a política do negócio para equipamentos sem TPM
      (`chave_hardware_backed=false`) — hoje o cadastro não bloqueia, só
      sinaliza; é uma decisão de negócio, não técnica.
- [ ] Revisar `PONTO_LOCAL_SERVICO_ORIGENS_PERMITIDAS` para o(s) domínio(s)
      reais de produção do CRM antes de qualquer uso fora de localhost.
- [ ] Testar em navegador real (Chrome/Edge, que é o suportado hoje pelo
      resto do piloto) contra o serviço local rodando na mesma máquina,
      incluindo o fluxo completo de captura de foto + desafio + assinatura
      — não feito nesta rodada (o gate impede a rota real de aceitar,
      então o teste teria que ser contra um dublê, como os testes
      automatizados já fazem; um teste visual de navegador real ainda
      assim vale a pena para a UX do fluxo de cadastro admin, que já é
      alcançável).
- [ ] Só então: mudança de código separada e revisada para
      `EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA = true`, com todos os 24 testes
      automatizados deste componente (mais os ~70 pré-existentes) passando
      antes do merge — nunca como parte do mesmo PR desta implementação.

## 6. Reafirmação de linguagem (nunca prometido)

Este componente nunca prova REP-P/homologação, nunca prova vida/presença
humana diante da câmera, e nunca é apresentado como proteção antifraude
absoluta. O próximo marco é uma demonstração técnica segura — não entrada
em produção.
