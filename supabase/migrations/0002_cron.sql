-- Daily job at 02:30 UTC = 08:00 IST: fee reminders, late-fees-due list, gateway event retries, stale trips,
-- trip-position pruning, invite expiry (all inside the cron-daily Edge Function).
-- The function URL and the shared secret come from Vault (set once per project; see README "Go-live"):
--   select vault.create_secret('https://<ref>.supabase.co/functions/v1', 'functions_url');
--   select vault.create_secret('<random 32+ chars, same as the CRON_SECRET function secret>', 'cron_secret');
-- Until both secrets exist the job runs and fails visibly in cron.job_run_details (url is null); nothing else breaks.

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

select cron.schedule(
  'cron-daily',
  '30 2 * * *',
  $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'functions_url') || '/cron-daily',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Cron-Secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  )
  $job$
);
