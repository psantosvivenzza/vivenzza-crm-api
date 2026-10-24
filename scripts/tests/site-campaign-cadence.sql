-- No provider I/O; transactional checks roll back configuration changes.
begin;
do $$ declare was_enabled boolean; was_verified boolean; begin
 select enabled,ai_verified into strict was_enabled,was_verified
 from public.site_campaign_config where id='volte10_20261023';
 if exists(select 1 from (values
  (null::timestamptz,true),
  ('2026-10-24T15:54:01Z'::timestamptz,false),
  ('2026-10-24T15:54:00Z'::timestamptz,true),
  ('2026-10-24T16:01:00Z'::timestamptz,false)
 ) t(last_at,expected)
 where public.site_campaign_cadence_ready(last_at,'2026-10-24T16:00:00Z'::timestamptz) is distinct from expected)
 then raise exception 'cadence_boundary_failed'; end if;
 update public.site_campaign_config set daily_limit=50 where id='volte10_20261023';
 begin
  update public.site_campaign_config set daily_limit=51 where id='volte10_20261023';
  raise exception 'daily_ceiling_missing';
 exception when check_violation then null; end;
 if exists(select 1 from public.site_campaign_config where id='volte10_20261023' and
  (hourly_limit>10 or enabled is distinct from was_enabled or ai_verified is distinct from was_verified))
 then raise exception 'campaign_gates_changed'; end if;
 if has_function_privilege('anon','public.site_campaign_cadence_ready(timestamptz,timestamptz)','EXECUTE')
 or has_function_privilege('authenticated','public.site_campaign_cadence_ready(timestamptz,timestamptz)','EXECUTE')
 then raise exception 'cadence_permission_failed'; end if;
end $$;
rollback;
select 'cadence_boundaries_daily_ceiling_and_gates_passed' as result;
