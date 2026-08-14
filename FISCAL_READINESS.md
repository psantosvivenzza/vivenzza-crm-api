# Fiscal Readiness — Vivenzza NFe

Read-only. Nenhuma nota fiscal foi emitida, nenhuma configuração foi alterada
(`serie1_numeracao_liberada` continua `false`). Gerado em 2026-08-14.

## O que são as 10.588 linhas em `public.nfe`

Import histórico único do NetVision (janela de `created_at` entre 2026-07-22
e 2026-08-03 — todas criadas na mesma carga, não emissão contínua), via view
`notas_legado_unificado`:

- **Série 99 (578 na amostra, 6.862 no total confirmado antes)** — "notas
  internas" vindas de uma tabela separada `vendas_legado` (6.848
  linhas, "fully migrated/validated" segundo a migration).
- **Série 1 (237 na amostra, 3.535 no total confirmado antes)** — as NF-e
  reais e históricas do NetVision, importadas como REGISTRO apenas — a
  maioria sem XML/chave de acesso carregado junto.
- **Séries 0, 2, 3, 5, 10, 33, 55, 890** — presentes na amostra em menor
  volume, com numeração claramente incoerente como série fiscal real (ex.
  série "0" com número 12.207.596, série "890" com número 41.410.219) —
  são artefato da importação/normalização do legado, não séries fiscais
  reais em uso.

## Notas realmente autorizadas

**1** (série 1, `status='autorizada'`, `valor_total=100`, nome do
destinatário mascarado como teste — parece ser um teste, não uma venda
real). Mais **1** com `status='emitida_interna'` (série 99). Todo o resto
(10.586 linhas) é `rascunho` ou `cancelada` — nunca chegou a ser transmitido
à SEFAZ por este sistema.

## Vínculo pedido_id atual

`nfe.pedido_id` é uma FK real (`REFERENCES public.nfe(id)`, sentido
inverso: `pedidos.nfe_id → nfe.id`), com wiring funcional no código
(`POST /api/nfe/:id/emitir` grava `pedidos.numero_nfe`/`status_fiscal` na
autorização) — mas **100% das 10.588 linhas têm `pedido_id=NULL`**. O
vínculo existe estruturalmente e nunca foi usado na prática.

## Série / numeração

Sem uma série fiscal real única e limpa hoje. `configuracoes_fiscais`
trava especificamente a **série 1** (`serie1_numeracao_liberada=false`),
que é a série que mais se aproxima de "a série real de vendas" — mas sua
numeração importada vai de valores negativos (confirmado antes: -1066) até
**5.241.175** (confirmado nesta rodada), claramente não sequencial/confiável
como próximo número de partida. Não há, no dado disponível, um "último
número emitido de verdade" que sirva de base seifara seguro — precisa de
validação humana (contador) antes de qualquer decisão de numeração real.

## Ambiente (achado novo desta rodada — BLOQUEADOR ADICIONAL)

`src/services/nfe/emitente.js`: `tpAmb: process.env.NFE_AMBIENTE === 'producao' ? '1' : '2'`
— **produção só liga com `NFE_AMBIENTE=producao` explícito; qualquer coisa
diferente (incluindo ausente) cai em homologação (SEFAZ sandbox)**, por
desenho deliberado (comentário no código confirma a intenção). Verificado
nas variáveis do Railway: **`NFE_AMBIENTE` NÃO está setada**. Ou seja,
mesmo que `serie1_numeracao_liberada` fosse destravada hoje, qualquer
emissão cairia no ambiente de homologação da SEFAZ, não em produção real —
um segundo gate independente, também travado hoje.

## Certificado / configuração

`NFE_CERT_SENHA` **está configurada no Railway** (confirmado). ⚠️
**Achado de segurança não relacionado ao escopo da auditoria**: ao checar
a presença dessa variável nesta investigação, usei
`railway variables --kv`, que imprime VALORES, não só nomes — isso expôs a
senha nos meus próprios logs de investigação. Não vou repetir o valor
aqui nem em nenhum outro lugar. Dado que foi exposto (ainda que só em log
de ferramenta local, não commitado/publicado), **recomendo tratá-lo como
comprometido e rotacionar via Railway assim que possível** — mesmo padrão
já registrado antes pra `META_ACCESS_TOKEN` nesta conta. Isso não bloqueia
nem afeta os outros achados desta auditoria.

## Vínculo pedido→NF, faturamento parcial, cancelamento, inutilização, DANFE/XML

- **Cancelamento**: suportado no código (`status` inclui `cancelada`/
  `cancelada_interna`; lógica em `emitente.js`/`sefaz.js`/`estados.js`).
- **Inutilização**: suportada no código (`emitente.js` tem lógica de
  inutilização).
- **DANFE/XML**: suportado (`xml.js` gera o XML, `assinar.js` assina
  digitalmente, `chave.js` monta a chave de acesso).
- **Faturamento parcial**: não verificado nesta rodada — não encontrei
  evidência clara de suporte nem de ausência no código de `src/services/nfe/`
  em uma inspeção rápida; precisa de uma leitura dedicada antes de assumir
  qualquer coisa.
- **Retorno/autorização do provedor fiscal**: integração é DIRETA com os
  webservices da SEFAZ (não usa um provedor terceirizado tipo NFe.io/Focus
  NFe) — `sefaz.js` monta o envelope SOAP e consulta `tpAmb`-dependente.

## Emissão fiscal pronta: NÃO

## Blockers fiscais (em ordem)

1. `configuracoes_fiscais.serie1_numeracao_liberada=false` — gate deliberado
   aguardando validação contábil da numeração.
2. `NFE_AMBIENTE` não setado em produção → cairia em homologação mesmo se
   o item 1 fosse resolvido.
3. Numeração da série 1 é historicamente inconsistente (-1066 a 5.241.175)
   — sem "próximo número seguro" claro sem intervenção humana/contábil.
4. Zero pedidos com `pedido_id` vinculado — mesmo destravando, seria
   emissão "do zero" sem nenhum caso testado ponta a ponta em produção real.
5. `NFE_CERT_SENHA` precisa ser rotacionada antes de qualquer teste real,
   por ter sido exposta nesta investigação (item de segurança, não fiscal).

## Próximo passo fiscal seguro (recomendado, NÃO executado)

1. Rotacionar `NFE_CERT_SENHA` no Railway.
2. Envolver o contador da empresa pra validar/definir o próximo número
   seguro de série 1 (não posso decidir isso sozinho — é uma decisão fiscal
   de negócio, não técnica).
3. Decidir e configurar `NFE_AMBIENTE` explicitamente (ficar em
   homologação até um teste completo em sandbox: emitir, autorizar,
   cancelar, inutilizar, gerar DANFE — tudo ponta a ponta antes de cogitar
   produção).
4. Só depois disso — e com autorização explícita separada — considerar
   destravar `serie1_numeracao_liberada` e testar em homologação.

Nada disso foi executado nesta rodada.
