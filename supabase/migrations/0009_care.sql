-- Care (schema v4; forward-only: 0001–0008 are never edited).
--   * leave_requests: absences a parent reports in advance (collection leaveRequests). Informational: attendance stays
--     the teacher's record. A parent may later have their reasons erased (people.anonymiseGuardian scrubs them).
--   * pickup_contacts: people a family authorises to collect a child, with a phone number (pickupContacts); removing
--     someone blanks the number and keeps the name for older pick-up records.
--   * pickups: who collected each child each day (pickups; id 'pck-<date>-<studentId>', one row per child and day).
-- Read access copies the diary (0001): the principal all; a teacher the children of their programmes; a parent their own
-- children with live app_account consent (app.my_student_ids); the accountant and the driver nothing.
-- Writes only through the command function (persist, service role). Retention deletes rows of a child who left, under
-- the attendance period (src/domain/retention.js): persist's delete allow-list gains these three tables.
-- persist / load_slice / my_snapshot of 0008 move to schema app and are wrapped here (the 0004/0005/0008 pattern).

-- ---------------------------------------------------------------- tables
create table public.leave_requests (
  id text primary key, doc jsonb not null,
  student_id text generated always as (doc->>'studentId') stored not null,
  from_date text generated always as (doc->>'fromDate') stored not null,
  to_date text generated always as (doc->>'toDate') stored not null,
  status text generated always as (doc->>'status') stored check (status in ('active', 'withdrawn'))
);
create index leave_requests_student_to on public.leave_requests (student_id, to_date);

create table public.pickup_contacts (
  id text primary key, doc jsonb not null,
  student_id text generated always as (doc->>'studentId') stored not null,
  status text generated always as (doc->>'status') stored check (status in ('active', 'removed'))
);
create index pickup_contacts_student on public.pickup_contacts (student_id);

create table public.pickups (
  id text primary key, doc jsonb not null,
  student_id text generated always as (doc->>'studentId') stored not null,
  date text generated always as (doc->>'date') stored not null,
  -- the id names the child and the day, so a second record for the same day can only be a correction of this row
  check (id = 'pck-' || date || '-' || student_id)
);
create index pickups_student_date on public.pickups (student_id, date);

do $$
declare t text;
begin
  foreach t in array array['leave_requests', 'pickup_contacts', 'pickups'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format($p$create policy read_scoped on public.%I for select to authenticated using (
      case app.my_role()
        when 'admin' then true
        when 'teacher' then exists (select 1 from public.students s where s.id = student_id and s.program_id = any(app.my_program_ids()))
        when 'parent' then student_id = any(app.my_student_ids())
        else false end)$p$, t);
  end loop;
end $$;

-- ---------------------------------------------------------------- load_slice wrapper: the care collections (small: loaded whole)
alter function public.load_slice(text[], jsonb) set schema app;
alter function app.load_slice(text[], jsonb) rename to load_slice_0008;
create function public.load_slice(p_collections text[], p_hints jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security invoker set search_path = public, app, pg_temp as $$
declare
  care constant jsonb := '{"leaveRequests":"leave_requests","pickupContacts":"pickup_contacts","pickups":"pickups"}';
  r jsonb := app.load_slice_0008(array(select c from unnest(p_collections) c where not care ? c), p_hints);
  c text;
  v jsonb;
begin
  foreach c in array p_collections loop
    continue when not care ? c;
    execute format('select jsonb_agg(doc order by id) from public.%I', care->>c) into v;
    r := jsonb_set(r, array['db', c], coalesce(v, '[]'::jsonb));
  end loop;
  return jsonb_set(r, '{db,schemaVersion}', '4'::jsonb);
end $$;

-- ---------------------------------------------------------------- persist wrapper: care upserts; retention deletes
alter function public.persist(text, bigint, jsonb) set schema app;
alter function app.persist(text, bigint, jsonb) rename to persist_0008;
create function public.persist(p_rev_key text, p_expected bigint, p_changes jsonb) returns bigint
language plpgsql volatile security invoker set search_path = public, app, pg_temp as $$
declare
  care constant jsonb := '{"leaveRequests":"leave_requests","pickupContacts":"pickup_contacts","pickups":"pickups"}';
  inner_changes jsonb := p_changes;
  col text;
  arr jsonb;
  res bigint;
begin
  -- the earlier persist first: revision locks and checks, the caller check, request id, every older collection, audit;
  -- it still refuses any delete outside its own allow-list and these three
  if p_changes ? 'upserts' then
    inner_changes := jsonb_set(inner_changes, '{upserts}', (p_changes->'upserts') - array(select jsonb_object_keys(care)));
  end if;
  if p_changes ? 'deletes' then
    inner_changes := jsonb_set(inner_changes, '{deletes}', (p_changes->'deletes') - array(select jsonb_object_keys(care)));
  end if;
  res := app.persist_0008(p_rev_key, p_expected, inner_changes);
  for col, arr in select * from jsonb_each(coalesce(p_changes->'upserts', '{}'::jsonb)) loop
    continue when not care ? col or jsonb_typeof(arr) <> 'array';
    execute format('insert into public.%I (id, doc) select e->>''id'', e from jsonb_array_elements($1) e on conflict (id) do update set doc = excluded.doc', care->>col)
      using arr;
  end loop;
  for col, arr in select * from jsonb_each(coalesce(p_changes->'deletes', '{}'::jsonb)) loop
    continue when not care ? col;
    execute format('delete from public.%I where id = any(array(select jsonb_array_elements_text($1)))', care->>col) using arr;
  end loop;
  return res;
end $$;

-- ---------------------------------------------------------------- my_snapshot wrapper: schema v4 collections (RLS decides every row)
-- Absences whose last day is within 60 days (and every later one), pick-ups of the last 30 days, every pick-up person.
alter function public.my_snapshot() set schema app;
alter function app.my_snapshot() rename to my_snapshot_0008;
create function public.my_snapshot() returns jsonb language plpgsql stable security invoker set search_path = public, app, pg_temp as $$
declare
  r jsonb := app.my_snapshot_0008();
begin
  if r->>'status' <> 'active' then return r; end if;
  return r || jsonb_build_object(
    'schemaVersion', 4,
    'leaveRequests', coalesce((select jsonb_agg(doc order by from_date, id) from public.leave_requests where to_date >= (app.ist_today() - 60)::text), '[]'::jsonb),
    'pickupContacts', coalesce((select jsonb_agg(doc order by id) from public.pickup_contacts), '[]'::jsonb),
    'pickups', coalesce((select jsonb_agg(doc order by date desc, id) from public.pickups where date >= (app.ist_today() - 30)::text), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------- grants
revoke all on public.leave_requests, public.pickup_contacts, public.pickups from anon, authenticated;
grant select on public.leave_requests, public.pickup_contacts, public.pickups to authenticated;
grant all on public.leave_requests, public.pickup_contacts, public.pickups to service_role;
revoke all on function public.my_snapshot(), public.load_slice(text[], jsonb), public.persist(text, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.my_snapshot() to authenticated, service_role;
grant execute on function public.load_slice(text[], jsonb), public.persist(text, bigint, jsonb) to service_role;
revoke all on function app.my_snapshot_0008(), app.load_slice_0008(text[], jsonb), app.persist_0008(text, bigint, jsonb) from public, anon;
revoke all on function app.load_slice_0008(text[], jsonb), app.persist_0008(text, bigint, jsonb) from authenticated;
grant execute on function app.my_snapshot_0008() to authenticated, service_role;
grant execute on function app.load_slice_0008(text[], jsonb), app.persist_0008(text, bigint, jsonb) to service_role;
