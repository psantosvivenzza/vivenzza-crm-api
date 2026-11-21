# Restauração da integração FZAP — 21/11/2026

Os deploys de main em 21/11 substituíram a publicação operacional anterior por uma árvore que não continha a integração FZAP. A consulta das conexões passou a responder404. Restaurar apenas o painel deixaria o pareamento sem receptor de eventos e os envios sem roteamento pelo proprietário durável.

O reparo restaura a integração e suas dependências do pacote operacional local `output/custos-publicacao-api`, associado ao deploy anterior `654bbb80-aecf-449e-8b8b-f7b38e5156a7`. A base Git permanece `95a3bbb1ccbe25b9f70cabc9a3499d81dc9fc500`. O SDR foi reconciliado por merge de três vias com ancestral `cd9f02f`, preservando a qualificação B2B, seus módulos e o coach publicados hoje. Nenhum conflito permaneceu no SDR.

## Comportamento autorizado preservado

Lara atende o primeiro contato e continua qualificando enquanto a conversa não tiver sido assumida por humano. O horário comercial não é, por si só, uma tomada humana. Recusas, opt-out e atendimento humano continuam bloqueando a IA. Esta é a regra expressamente autorizada pelo responsável nesta conversa e já publicada no pacote operacional anterior; não é uma nova autorização inferida do reparo.

## Validação e limites

- Leitura de produção confirmou `whatsapp_connections` com owner, identidade, intenção e timestamps; `financial_ai_contacts`, `financial_ai_runs`, `financial_manual_sends` e `direction_notification_deliveries` também existem.
- Catálogo confirmou os RPCs `financial_reserve_budget`, `stop_site_campaign_contact`, `claim_site_campaign_contact`, `site_campaign_leads_for_contact` e `set_operational_automation`. Nenhum foi executado nessa verificação.
- A configuração real foi lida sem expor valores: FZAP configurada, segredo de webhook com formato válido e DTO de sete conexões retornado. Nenhuma alteração de credencial ou configuração.
- Contratos FZAP cobrem QR, identidade fixada, ownership/CAS, HMAC por conexão, replay, isolamento financeiro, mídia e resultado incerto. Testes financeiros cobrem tomada humana, DNC, horário, anexos e ausência de reenvio.
- O smoke de importação nega toda rede de saída. O aviso IPv6 do rate limit do coach já existe no código de hoje e não impede a importação; não foi alterado neste reparo.
- Um teste financeiro antigo esperava tomada humana permanente fora do horário. Foi atualizado para o contrato operacional já publicado: bloquear a resposta nesse período sem assumir a conversa; anexos continuam indo para a fila humana. A lógica de runtime não foi alterada para acomodar o teste.

Não executar migrations nem alterar flags, cotas, títulos, saldos, preços ou cadência de prospecção durante este reparo. Não usar mensagens/ligação reais para testar. Sessão desconectada exige pareamento humano; reconectar não autoriza campanhas nem remove a pausa de prospecção.

Antes de publicar: `npm run test:whatsapp-conexoes` e `npm run test:api-imports`, revisão crítica do Claude e confirmação do head remoto. Depois: deploy SUCCESS, `/health`200, consulta sem login401, webhook sem token401, DTO real e tela autenticada quando houver sessão disponível. HTTP401 confirma a presença da rota e proteção, não substitui validação autenticada nem comprova entrega de mensagens.
