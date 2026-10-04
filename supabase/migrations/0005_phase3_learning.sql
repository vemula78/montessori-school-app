-- Phase 3: curriculum (presentations), observations with photos, progress events, termly reports, retention.
-- Forward-only (0001–0004 are never edited). Same shape as before: each entity a JSONB `doc` plus GENERATED key
-- columns; RLS SELECT-only by role; every write through public.persist (service role), whose 0004 version moves to
-- schema app and is wrapped here, like load_slice and my_snapshot.
--   * observations are staff-only until shared (shared_at); parents see shared ones of their own children
--   * photos: metadata rows here, bytes in the private bucket `child-photos` with NO storage policies for anon or
--     authenticated — the command function signs every upload/download URL after the registry authorized the caller
--   * progress: append-only events; the snapshot projects the latest event per (child, presentation); parents get none
--   * reports: parents see published ones only
--   * consents: teachers may read the rows of their own students (the "no photo consent" badge); notice version v2
--   * retention: persist may delete rows of observations, progress events, photos, diary entries, reports,
--     attendance and messages (retention.purge only); never ledger, people, consent or audit rows

-- ---------------------------------------------------------------- notice version (adds the photos purpose)
-- Must equal CONSENT_VERSION in src/domain/commands.js and PRIVACY_VERSION in src/ui/privacy.js (unit tests compare them).
create or replace function app.consent_version() returns text language sql immutable set search_path = pg_catalog as $$ select 'v2'::text $$;

-- ---------------------------------------------------------------- tables
create table public.presentations (
  id text primary key, doc jsonb not null,
  key text generated always as (doc->>'key') stored not null,
  area text generated always as (doc->>'area') stored,
  active boolean generated always as ((doc->>'active')::boolean) stored
);
create unique index presentations_key on public.presentations (key);
create table public.observations (
  id text primary key, doc jsonb not null,
  student_id text generated always as (doc->>'studentId') stored not null,
  date text generated always as (doc->>'date') stored,
  shared_at text generated always as (doc->>'sharedAt') stored
);
create index observations_student_date on public.observations (student_id, date);
create table public.photos (
  id text primary key, doc jsonb not null,
  observation_id text generated always as (doc->>'observationId') stored not null,
  student_id text generated always as (doc->>'studentId') stored not null,
  status text generated always as (doc->>'status') stored check (status in ('pending', 'ready', 'rejected', 'deleting', 'deleted', 'expired'))
);
create index photos_observation on public.photos (observation_id);
create index photos_student_status on public.photos (student_id, status);
create table public.progress_events (
  id text primary key, doc jsonb not null,
  student_id text generated always as (doc->>'studentId') stored not null,
  presentation_id text generated always as (doc->>'presentationId') stored not null,
  seq int generated always as ((doc->>'seq')::int) stored not null check (seq >= 1)
);
create unique index progress_events_key on public.progress_events (student_id, presentation_id, seq);
create table public.reports (
  id text primary key, doc jsonb not null,
  student_id text generated always as (doc->>'studentId') stored not null,
  academic_year_id text generated always as (doc->>'academicYearId') stored not null,
  term_name text generated always as (doc->>'termName') stored not null,
  status text generated always as (doc->>'status') stored check (status in ('draft', 'submitted', 'published'))
);
create unique index reports_key on public.reports (student_id, academic_year_id, term_name);

-- ---------------------------------------------------------------- RLS (SELECT only)
do $$
declare t text;
begin
  foreach t in array array['presentations', 'observations', 'photos', 'progress_events', 'reports'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop;
end $$;

create policy read_staff on public.presentations for select to authenticated using (app.my_role() in ('admin', 'teacher'));
create policy read_scoped on public.observations for select to authenticated using (
  case app.my_role()
    when 'admin' then true
    when 'teacher' then exists (select 1 from public.students s where s.id = student_id and s.program_id = any(app.my_program_ids()))
    when 'parent' then shared_at is not null and student_id = any(app.my_student_ids())
    else false end);
create policy read_scoped on public.photos for select to authenticated using (
  case app.my_role()
    when 'admin' then true
    when 'teacher' then exists (select 1 from public.students s where s.id = student_id and s.program_id = any(app.my_program_ids()))
    when 'parent' then status = 'ready' and student_id = any(app.my_student_ids())
      and exists (select 1 from public.observations o where o.id = observation_id and o.shared_at is not null)
    else false end);
create policy read_scoped on public.progress_events for select to authenticated using (
  case app.my_role()
    when 'admin' then true
    when 'teacher' then exists (select 1 from public.students s where s.id = student_id and s.program_id = any(app.my_program_ids()))
    else false end);
create policy read_scoped on public.reports for select to authenticated using (
  case app.my_role()
    when 'admin' then true
    when 'teacher' then exists (select 1 from public.students s where s.id = student_id and s.program_id = any(app.my_program_ids()))
    when 'parent' then status = 'published' and student_id = any(app.my_student_ids())
    else false end);
-- consents: the principal all; a parent their own; a teacher the rows of children in their programs (photo consent badge)
drop policy read_scoped on public.consents;
create policy read_scoped on public.consents for select to authenticated using (
  case app.my_role()
    when 'admin' then true
    when 'parent' then guardian_id = app.my_guardian_id()
    when 'teacher' then exists (select 1 from public.students s where s.id = student_id and s.program_id = any(app.my_program_ids()))
    else false end);

-- ---------------------------------------------------------------- storage: one private bucket, no user policies
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('child-photos', 'child-photos', false, 409600, array['image/jpeg'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- the bucket's objects (name, created) for the orphan sweep in cron-daily; service role only
create function public.photo_objects() returns table (name text, created_at timestamptz)
language sql stable security invoker set search_path = pg_catalog as $$
  select o.name, o.created_at from storage.objects o where o.bucket_id = 'child-photos' order by o.name
$$;

-- ---------------------------------------------------------------- load_slice wrapper: the learning collections
-- Hints: learningStudentId | observationId | photoId | reportId → that one child's rows; exportGuardianId or
-- photosOfCaller (+ callerUserId) → the rows of that guardian's children; photoIds → those photos; photosLive → every
-- pending/ready photo; learningAll → everything (retention, sweeps). Without a hint a learning collection loads empty
-- (presentations always load whole).
alter function public.load_slice(text[], jsonb) set schema app;
alter function app.load_slice(text[], jsonb) rename to load_slice_0004;
create function public.load_slice(p_collections text[], p_hints jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security invoker set search_path = public, app, pg_temp as $$
declare
  learn constant text[] := array['presentations', 'observations', 'photos', 'progressEvents', 'reports'];
  r jsonb := app.load_slice_0004(array(select c from unnest(p_collections) c where not c = any(learn)), p_hints);
  want_all boolean := p_hints ? 'learningAll';
  sid text;
  gid text;
  kids text[];
  pids text[] := array(select jsonb_array_elements_text(case when jsonb_typeof(p_hints->'photoIds') = 'array' then p_hints->'photoIds' else '[]'::jsonb end));
  c text;
  v jsonb;
begin
  sid := coalesce(nullif(p_hints->>'learningStudentId', ''),
    (select o.student_id from public.observations o where o.id = p_hints->>'observationId'),
    (select p.student_id from public.photos p where p.id = p_hints->>'photoId'),
    (select x.student_id from public.reports x where x.id = p_hints->>'reportId'));
  gid := coalesce(nullif(p_hints->>'exportGuardianId', ''),
    case when p_hints ? 'photosOfCaller' and p_hints ? 'callerUserId' then (select u.guardian_id from public.app_users u where u.user_id = (p_hints->>'callerUserId')::uuid) end);
  kids := case when gid is null then '{}'::text[] else array(select sg.student_id from public.student_guardians sg where sg.guardian_id = gid) end;
  foreach c in array p_collections loop
    continue when not c = any(learn);
    v := case c
      when 'presentations' then (select jsonb_agg(doc order by id) from public.presentations)
      when 'observations' then (select jsonb_agg(doc order by id) from public.observations where want_all or student_id = sid or student_id = any(kids))
      when 'photos' then (select jsonb_agg(doc order by id) from public.photos
          where want_all or student_id = sid or student_id = any(kids) or id = any(pids) or (p_hints ? 'photosLive' and status in ('pending', 'ready')))
      when 'progressEvents' then (select jsonb_agg(doc order by student_id, presentation_id, seq) from public.progress_events where want_all or student_id = sid or student_id = any(kids))
      when 'reports' then (select jsonb_agg(doc order by id) from public.reports where want_all or student_id = sid or student_id = any(kids))
    end;
    r := jsonb_set(r, array['db', c], coalesce(v, '[]'::jsonb));
  end loop;
  return jsonb_set(r, '{db,schemaVersion}', '2'::jsonb);
end $$;

-- ---------------------------------------------------------------- persist wrapper: learning upserts, retention deletes
alter function public.persist(text, bigint, jsonb) set schema app;
alter function app.persist(text, bigint, jsonb) rename to persist_0004;
create function public.persist(p_rev_key text, p_expected bigint, p_changes jsonb) returns bigint
language plpgsql volatile security invoker set search_path = public, app, pg_temp as $$
declare
  learn constant jsonb := '{"presentations":"presentations","observations":"observations","photos":"photos","progressEvents":"progress_events","reports":"reports"}';
  -- the only rows a change may delete besides calendar events and import rows (both handled by the earlier persist)
  purge constant jsonb := '{"observations":"observations","progressEvents":"progress_events","photos":"photos","diaryEntries":"diary_entries",
    "reports":"reports","attendance":"attendance","messages":"messages"}';
  inner_changes jsonb := p_changes;
  col text;
  arr jsonb;
  res bigint;
begin
  -- the earlier persist first: revision locks and checks, the caller check, request id, every older collection, audit;
  -- it still refuses any delete outside its own list and these
  if p_changes ? 'upserts' then
    inner_changes := jsonb_set(inner_changes, '{upserts}', (p_changes->'upserts') - array(select jsonb_object_keys(learn)));
  end if;
  if p_changes ? 'deletes' then
    inner_changes := jsonb_set(inner_changes, '{deletes}', (p_changes->'deletes') - array(select jsonb_object_keys(purge)));
  end if;
  res := app.persist_0004(p_rev_key, p_expected, inner_changes);
  for col, arr in select * from jsonb_each(coalesce(p_changes->'upserts', '{}'::jsonb)) loop
    continue when not learn ? col or jsonb_typeof(arr) <> 'array';
    execute format('insert into public.%I (id, doc) select e->>''id'', e from jsonb_array_elements($1) e on conflict (id) do update set doc = excluded.doc', learn->>col)
      using arr;
  end loop;
  for col, arr in select * from jsonb_each(coalesce(p_changes->'deletes', '{}'::jsonb)) loop
    continue when not purge ? col;
    execute format('delete from public.%I where id = any(array(select jsonb_array_elements_text($1)))', purge->>col) using arr;
  end loop;
  return res;
end $$;

-- ---------------------------------------------------------------- my_snapshot wrapper: schema v2 collections
-- Staff: observations of the last 120 days and their photos (reports carry their own copies), the latest progress
-- event per child and presentation, every report in scope, the curriculum, the consents RLS lets them read (a teacher:
-- id, guardian, child, purpose, version, dates only). Parent: every shared observation of their children, the ready
-- photos of those, published reports; no progress events, no curriculum. RLS decides every row.
alter function public.my_snapshot() set schema app;
alter function app.my_snapshot() rename to my_snapshot_0004;
create function public.my_snapshot() returns jsonb language plpgsql stable security invoker set search_path = public, app, pg_temp as $$
declare
  r jsonb := app.my_snapshot_0004();
  who text;
  since text := (app.ist_today() - 120)::text;
begin
  if r->>'status' <> 'active' then return r; end if;
  who := r->'me'->>'role';
  r := r || jsonb_build_object(
    'schemaVersion', 2,
    'presentations', coalesce((select jsonb_agg(doc order by id) from public.presentations), '[]'::jsonb),
    'observations', coalesce((select jsonb_agg(doc order by id) from public.observations where who = 'parent' or date >= since), '[]'::jsonb),
    'photos', coalesce((select jsonb_agg(p.doc order by p.id) from public.photos p
        where exists (select 1 from public.observations o where o.id = p.observation_id and (who = 'parent' or o.date >= since))), '[]'::jsonb),
    'progressEvents', coalesce((select jsonb_agg(e.doc order by e.student_id, e.presentation_id) from (
        select distinct on (student_id, presentation_id) doc, student_id, presentation_id from public.progress_events
        order by student_id, presentation_id, seq desc) e), '[]'::jsonb),
    'reports', coalesce((select jsonb_agg(doc order by id) from public.reports), '[]'::jsonb));
  if who = 'admin' then
    r := r || jsonb_build_object('consents', coalesce((select jsonb_agg(doc order by id) from public.consents), '[]'::jsonb));
  elsif who = 'teacher' then
    r := r || jsonb_build_object('consents', coalesce((select jsonb_agg(jsonb_build_object('id', c.doc->'id', 'guardianId', c.doc->'guardianId', 'studentId', c.doc->'studentId',
        'purpose', c.doc->'purpose', 'version', c.doc->'version', 'givenAt', c.doc->'givenAt', 'withdrawnAt', c.doc->'withdrawnAt') order by c.id) from public.consents c), '[]'::jsonb));
  end if;
  return r;
end $$;

-- ---------------------------------------------------------------- grants
revoke all on public.presentations, public.observations, public.photos, public.progress_events, public.reports from anon, authenticated;
grant select on public.presentations, public.observations, public.photos, public.progress_events, public.reports to authenticated;
grant all on public.presentations, public.observations, public.photos, public.progress_events, public.reports to service_role;
revoke all on function public.my_snapshot(), public.load_slice(text[], jsonb), public.persist(text, bigint, jsonb), public.photo_objects() from public, anon, authenticated;
grant execute on function public.my_snapshot() to authenticated, service_role;
grant execute on function public.load_slice(text[], jsonb), public.persist(text, bigint, jsonb), public.photo_objects() to service_role;
revoke all on function app.my_snapshot_0004(), app.load_slice_0004(text[], jsonb), app.persist_0004(text, bigint, jsonb) from public, anon;
revoke all on function app.load_slice_0004(text[], jsonb), app.persist_0004(text, bigint, jsonb) from authenticated;
grant execute on function app.my_snapshot_0004() to authenticated, service_role;
grant execute on function app.load_slice_0004(text[], jsonb), app.persist_0004(text, bigint, jsonb) to service_role;

-- ---------------------------------------------------------------- realtime: a shared observation or a published report nudges a refetch
alter publication supabase_realtime add table public.observations, public.reports;
