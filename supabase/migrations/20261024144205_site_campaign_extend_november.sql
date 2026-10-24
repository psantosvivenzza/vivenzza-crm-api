-- User approved extending VOLTE10 through November 6, 2026 at 23:59 BRT.
-- Apply only after the storefront coupon and new artwork have been verified.
do $$ begin
 if exists(select 1 from public.site_campaign_config where id='volte10_20261023' and enabled)
 then raise exception 'pause_site_campaign_before_extension'; end if;
end $$;
create or replace function public.site_campaign_suppressed_phones() returns setof text
language sql stable security invoker set search_path=public,pg_temp as $$
 select regexp_replace(cliente_telefone,'[^0-9]','','g')
 from public.collection_do_not_contact where expira_em is null or expira_em>now()
 union
 select regexp_replace(telefone,'[^0-9]','','g') from public.sdr_conversas where status_atendimento='vendedor_assumiu';
$$;
revoke all on function public.site_campaign_suppressed_phones() from public,anon,authenticated;
grant execute on function public.site_campaign_suppressed_phones() to service_role;

create or replace function public.site_campaign_leads_for_contact(p_lead_id uuid,p_phones text[])
returns table(id uuid,telefone text,whatsapp_opt_out boolean,atendimento_humano boolean,ativo boolean)
language sql stable security invoker set search_path=public,pg_temp as $$
 select l.id,l.telefone,
  (l.whatsapp_opt_out or exists(select 1 from public.collection_do_not_contact d
   where regexp_replace(d.cliente_telefone,'[^0-9]','','g')=any(p_phones)
   and (d.expira_em is null or d.expira_em>now()))),
  (l.atendimento_humano or exists(select 1 from public.sdr_conversas s
   where regexp_replace(s.telefone,'[^0-9]','','g')=any(p_phones) and s.status_atendimento='vendedor_assumiu')),
  l.ativo
 from public.leads l where l.id=p_lead_id or regexp_replace(l.telefone,'[^0-9]','','g')=any(p_phones);
$$;
revoke all on function public.site_campaign_leads_for_contact(uuid,text[]) from public,anon,authenticated;
grant execute on function public.site_campaign_leads_for_contact(uuid,text[]) to service_role;

alter table public.site_campaign_config alter column expires_at set default '2026-11-07T02:59:59.999Z';
update public.site_campaign_config set expires_at='2026-11-07T02:59:59.999Z' where id='volte10_20261023';
