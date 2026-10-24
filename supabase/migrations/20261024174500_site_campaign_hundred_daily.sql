-- Explicit user authorization on 2026-10-24: site campaign only, 100/day.
-- Preserve hourly cap, cadence, send window and all activation/safety gates.
alter table public.site_campaign_config drop constraint site_campaign_config_daily_limit_check;
alter table public.site_campaign_config add constraint site_campaign_config_daily_limit_check check (daily_limit between 1 and 100);
alter table public.site_campaign_config alter column daily_limit set default 100;
update public.site_campaign_config set daily_limit=100 where id='volte10_20261023';
