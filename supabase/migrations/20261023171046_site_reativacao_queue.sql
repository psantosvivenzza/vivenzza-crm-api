create table public.site_campaign_config (
 id text primary key check (id = 'volte10_20261023'),
 enabled boolean not null default false,
 ai_verified boolean not null default false,
 instance_name text not null,
 expires_at timestamptz not null default '2026-10-31T02:59:59.999Z',
 last_attempt_at timestamptz,
 daily_limit integer not null default 30 check (daily_limit between 1 and 30),
 hourly_limit integer not null default 10 check (hourly_limit between 1 and 10)
);
create table public.site_campaign_contacts (
 id uuid primary key default gen_random_uuid(),
 campaign_id text not null references public.site_campaign_config(id),
 lead_id uuid not null references public.leads(id),
 nome text not null,
 telefone text not null check (telefone ~ '^55[0-9]{10,11}$'),
 status text not null default 'pending' check (status in ('pending','reserved','sent','blocked','uncertain','replied')),
 reserved_at timestamptz,
 sent_at timestamptz,
 evolution_id text unique,
 last_error text,
 unique(campaign_id,telefone)
);
create index site_campaign_contacts_pending on public.site_campaign_contacts(campaign_id,status,reserved_at);
create table public.site_campaign_conversas (like public.sdr_conversas including all);
alter table public.site_campaign_config enable row level security;
alter table public.site_campaign_contacts enable row level security;
alter table public.site_campaign_conversas enable row level security;
revoke all on public.site_campaign_config,public.site_campaign_contacts,public.site_campaign_conversas from public,anon,authenticated;
grant all on public.site_campaign_config,public.site_campaign_contacts,public.site_campaign_conversas to service_role;

create function public.claim_site_campaign_contact() returns setof public.site_campaign_contacts
language plpgsql security invoker set search_path=public,pg_temp as $$
declare cfg public.site_campaign_config; picked public.site_campaign_contacts; local_now timestamp := clock_timestamp() at time zone 'America/Sao_Paulo'; day_count integer; hour_count integer; checked_count integer; delivered_count integer;
begin
 select * into cfg from public.site_campaign_config where id='volte10_20261023' for update;
 if not found or not cfg.enabled or not cfg.ai_verified or clock_timestamp()>cfg.expires_at then return; end if;
 if extract(isodow from local_now)>5 or local_now::time<time '09:00' or local_now::time>time '17:30' then return; end if;
 if cfg.last_attempt_at>clock_timestamp()-interval '90 seconds' then return; end if;
 select count(*) filter(where reserved_at >= (local_now::date::timestamp at time zone 'America/Sao_Paulo')),count(*) filter(where reserved_at>clock_timestamp()-interval '1 hour') into day_count,hour_count from public.site_campaign_contacts where campaign_id=cfg.id;
 if day_count>=cfg.daily_limit or hour_count>=cfg.hourly_limit then return; end if;
 select count(*), count(*) filter(where c.status='replied' or m.status in ('entregue','lido','reproduzido')) into checked_count,delivered_count from public.site_campaign_contacts c left join public.whatsapp_mensagens m on m.evolution_id=c.evolution_id and m.instance_name=cfg.instance_name where c.campaign_id=cfg.id and c.reserved_at>=clock_timestamp()-interval '1 day' and c.reserved_at<clock_timestamp()-interval '3 minutes' and c.status in ('sent','uncertain','replied');
 if checked_count>=8 and delivered_count::numeric/checked_count<0.5 then update public.site_campaign_config set enabled=false where id=cfg.id; return; end if;
 select c.* into picked from public.site_campaign_contacts c join public.leads l on l.id=c.lead_id where c.campaign_id=cfg.id and c.status='pending' and not l.whatsapp_opt_out and not l.atendimento_humano and l.ativo order by c.id for update of c skip locked limit 1;
 if not found then return; end if;
 update public.site_campaign_contacts set status='reserved',reserved_at=clock_timestamp() where id=picked.id returning * into picked;
 update public.site_campaign_config set last_attempt_at=clock_timestamp() where id=cfg.id;
 return next picked;
end $$;
revoke all on function public.claim_site_campaign_contact() from public,anon,authenticated;
grant execute on function public.claim_site_campaign_contact() to service_role;

create function public.stop_site_campaign_contact(p_contact_id uuid,p_phones text[]) returns void
language plpgsql security invoker set search_path=public,pg_temp as $$
declare c public.site_campaign_contacts;
begin
 select * into strict c from public.site_campaign_contacts where id=p_contact_id for update;
 update public.leads set whatsapp_opt_out=true,whatsapp_opt_out_em=clock_timestamp(),whatsapp_opt_out_motivo='pedido_cliente_campanha_site',status_reativacao='encerrado',atendimento_humano=true where id=c.lead_id or regexp_replace(telefone,'[^0-9]','','g')=any(p_phones);
 update public.site_campaign_contacts set status='blocked' where id=c.id;
end $$;
revoke all on function public.stop_site_campaign_contact(uuid,text[]) from public,anon,authenticated;
grant execute on function public.stop_site_campaign_contact(uuid,text[]) to service_role;
