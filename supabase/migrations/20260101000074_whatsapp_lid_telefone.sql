-- Continuação do incidente "WhatsApp/IA sem resposta" (PR #111, 2026-09-21):
-- @lid sem remoteJidAlt é a própria Evolution API/Baileys entregando um
-- identificador que não revela o telefone real da lead (política de
-- privacidade "Linked ID" do WhatsApp/Meta) — confirmado como problema
-- upstream conhecido e sem solução garantida via nenhum endpoint read-only
-- da Evolution API (findContacts/findChats não guardam telefone associado a
-- um @lid; issues públicas do evolution-api e do próprio Baileys confirmam
-- que "getPNForLID only succeeds for pairs Baileys has previously cached
-- from inbound traffic — it cannot fetch a PN for an unknown LID").
--
-- A única via legítima (confirmada pelos mantenedores do Baileys) é manter
-- nós mesmos um cache persistente lid->telefone, populado SOMENTE nas
-- ocasiões em que o próprio WhatsApp já revelou os dois lados na mesma
-- mensagem (remoteJidAlt presente) — nunca a partir dos dígitos do @lid em
-- si (isso seria o mesmo bug de "leads fantasma" do commit 4fa14d8,
-- 2026-07-06). Ver src/lib/whatsappLid.js.
--
-- Escopo: cache exclusivo do fluxo comercial (sdr.js/webhook-handler.js) —
-- nunca tocado pelo motor financeiro (inboundMessageHandler.js), que
-- permanece fora do escopo desta mudança. instance_name na chave garante
-- que um lid nunca é reaproveitado entre instâncias diferentes.
create table if not exists public.whatsapp_lid_telefone (
  lid            text not null,
  instance_name  text not null,
  telefone       text not null,
  criado_em      timestamptz not null default now(),
  atualizado_em  timestamptz not null default now(),
  primary key (lid, instance_name)
);

create index if not exists idx_whatsapp_lid_telefone_telefone
  on public.whatsapp_lid_telefone (telefone);

-- Mesmo padrão de segurança da migration 20260101000073 (achado real:
-- anon/authenticated têm SELECT por padrão em tabela nova sem RLS) — sem
-- nenhuma policy, só service_role (que ignora RLS) lê/escreve. O backend
-- nunca fala com o Supabase por outro papel.
alter table public.whatsapp_lid_telefone enable row level security;
