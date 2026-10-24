-- Explicit authorization: 50 daily attempts for the site campaign only.
alter table public.site_campaign_config drop constraint site_campaign_config_daily_limit_check;
alter table public.site_campaign_config add constraint site_campaign_config_daily_limit_check check (daily_limit between 1 and 50);
alter table public.site_campaign_config alter column daily_limit set default 50;
update public.site_campaign_config set daily_limit=50 where id='volte10_20261023';

create or replace function public.site_campaign_cadence_ready(p_last timestamptz,p_now timestamptz) returns boolean
language sql immutable security invoker set search_path=public,pg_temp as $$
 select p_last is null or p_last <= p_now - interval '6 minutes';
$$;
revoke all on function public.site_campaign_cadence_ready(timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.site_campaign_cadence_ready(timestamptz,timestamptz) to service_role;

create or replace function public.claim_site_campaign_contact() returns setof public.site_campaign_contacts
language plpgsql security invoker set search_path=public,pg_temp as $$
declare cfg public.site_campaign_config; picked public.site_campaign_contacts; local_now timestamp := clock_timestamp() at time zone 'America/Sao_Paulo'; day_count integer; hour_count integer; checked_count integer; delivered_count integer;
begin
 select * into cfg from public.site_campaign_config where id='volte10_20261023' for update;
 if not found or not cfg.enabled or not cfg.ai_verified or clock_timestamp()>cfg.expires_at then return; end if;
 if not public.site_campaign_in_send_window(clock_timestamp()) then return; end if;
 if not public.site_campaign_cadence_ready(cfg.last_attempt_at,clock_timestamp()) then return; end if;
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
