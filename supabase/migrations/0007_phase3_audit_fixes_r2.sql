-- Phase 3 audit fixes, round 2 (forward-only: 0001–0006 are never edited).
--   R4  pg_cron never retries a failed run, and a file put back with a still-valid upload grant would otherwise wait for
--       the daily run: the 15-minute job (0003's cron-trips) now also runs photosCleanup, which retries failed object
--       deletions and removes files of closed photo rows at once. Its trips step is unchanged. cron.schedule with an
--       existing job name replaces that job's command.
select cron.schedule(
  'cron-trips',
  '*/15 * * * *',
  $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'functions_url') || '/cron-daily',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Cron-Secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{"steps":["trips","photosCleanup"]}'::jsonb,
    timeout_milliseconds := 60000
  )
  $job$
);
