-- Read-only production regression: no queue reservation and no outbound I/O.
do $$ begin
 if exists (
  select 1 from (values
   ('2026-10-24T12:00:00Z'::timestamptz,true), -- Saturday 09:00 BRT
   ('2026-10-25T23:00:00Z'::timestamptz,true), -- Sunday 20:00 BRT
   ('2026-10-26T22:00:00Z'::timestamptz,true), -- Monday 19:00 BRT
   ('2026-10-24T11:59:59Z'::timestamptz,false), -- Before 09:00
   ('2026-10-25T00:59:59Z'::timestamptz,true), -- Saturday 21:59:59 BRT
   ('2026-10-25T01:00:00Z'::timestamptz,false), -- Saturday 22:00 BRT
   ('2026-10-25T05:00:00Z'::timestamptz,false) -- Sunday 02:00 BRT
  ) t(at_time,expected)
  where public.site_campaign_in_send_window(at_time) is distinct from expected
 ) then raise exception 'site_campaign_schedule_regression'; end if;
 if has_function_privilege('anon','public.site_campaign_in_send_window(timestamptz)','EXECUTE')
 or has_function_privilege('authenticated','public.site_campaign_in_send_window(timestamptz)','EXECUTE')
 then raise exception 'site_campaign_schedule_privilege_regression'; end if;
end $$;
select 'site_campaign_schedule_7_cases_and_permissions_passed' as result;
