# Fiscal e vendas — três conceitos que nunca devem ser misturados

## 1. Pedidos do Mês

Domínio de pedidos do CRM (`pedidos`). Um pedido **não é venda
automaticamente** — vira venda só quando faturado/confirmado pela fonte
correta (ver abaixo). Nunca tratar contagem/soma de pedidos como métrica
de venda.

## 2. Vendas do Mês (gerencial)

- **Fonte oficial**: NetVision `EN_NotasRepres` — é a mesma fonte do
  relatório oficial "Consulta Vendas por Representante", validada com
  reconciliação 100% exata.
- **Nunca usar `ES_Pedidos`** para "Vendas do Mês" — é o domínio comercial
  de pedidos, não vendas fechadas.
- Read-model: `vendas_gerenciais_netvision`, alimentado pelo sync
  `VivenzzaSyncVendasGerenciaisLegado` (residente, ciclo de 30min dentro da
  janela operacional).
- **Série 99 entra em vendas gerenciais** — é venda gerencial real, **não
  é documento fiscal SEFAZ**. Nunca excluir Série 99 da visão gerencial.
- O card "Vendas do Mês" do dashboard consome `vendas_gerenciais_mes`
  (fonte gerencial), não a fonte fiscal.

## 3. Venda fiscal (NF-e real)

- Domínio separado, fonte NetVision `EN_Notas`, read-model
  `notas_fiscais_netvision`, sync `VivenzzaSyncFiscalLegado` (residente,
  também 30min).
- Série 99 é **excluída** da visão fiscal quando aplicável — ela nunca é
  um documento fiscal SEFAZ, mesmo contando como venda gerencial real.
- Nunca confundir os dois read-models (`vendas_gerenciais_netvision` ×
  `notas_fiscais_netvision`) — são fontes NetVision diferentes
  (`EN_NotasRepres` × `EN_Notas`), com propósitos diferentes.

## Certificado digital (NF-e)

- Certificado atual: e-CNPJ ICP-Brasil, CNPJ `13.602.526/0001-93`,
  validade `12/08/2026` a `12/08/2027`.
- `CERT_BASE64` (Railway) corresponde ao PFX **original completo**, com a
  **cadeia completa (4 certificados)** — nunca uma reexportação parcial.
  Achado real: uma reexportação via `.NET X509Certificate2.Export()`
  silenciosamente descarta certificados intermediários/raiz, mantendo só
  o certificado-folha. **Nunca reexportar** — sempre copiar o PFX original
  byte a byte quando for necessário atualizar o certificado.
- `NFE_CERT_SENHA` está configurada no Railway — **nunca registrar o valor
  da senha em nenhum documento, log ou commit**.
- `serie1_numeracao_liberada=false` — **NF-e real continua desligada**.
  Nenhuma emissão, nem de teste, sem autorização explícita.

## Regra geral

Antes de assumir qual é "a fonte correta" para qualquer métrica de
venda/faturamento, confirmar contra este documento — a confusão entre
pedido/gerencial/fiscal já causou discrepância real no dashboard antes.
