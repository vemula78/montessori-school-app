-- The annual Progress Report (schema v5, part 1; forward-only: 0001–0009 are never edited).
--   * evaluations: one per child and academic year (id 'evl-<academicYearId>-<studentId>', checked here), rated on the
--     rubric of the child's level (students.doc.level; the level is frozen on the evaluation). Read access copies termly
--     reports (0005): the principal all; a teacher the children of their programmes; a parent only PUBLISHED evaluations
--     of their own children with live app_account consent (app.my_student_ids) — either guardian; nobody else.
--   * signatures: staff and director signature images, metadata here, bytes in the PRIVATE bucket `signatures` with NO
--     storage policies (like child-photos): the command function stores an upload after checking it, and signs a
--     60-second download only for the print view (a parent: a published report of their own child) or for the person
--     who manages the signature. Rows: the principal all; a staff member their own; nobody else (parents never read them).
--   * school settings (reportFooter, directorName, privacyContact, officeHours, upi) live in the school document: no table.
-- Writes only through the command function (persist, service role). Retention deletes evaluations of a child who left,
-- under the diary period (src/domain/retention.js): persist's delete allow-list gains evaluations.
-- persist / load_slice / my_snapshot of 0009 move to schema app and are wrapped here (the 0004/0005/0008/0009 pattern).
-- load_slice: hint evalAttendance {evaluationId | studentId+academicYearId | programId+academicYearId | none} loads the
-- register rows the attendance figures need (that year, those children) instead of the default 60 days.
-- Performance (end of file): every policy in schema public is rewritten so its helpers run once per statement.

-- ---------------------------------------------------------------- tables
create table public.evaluations (
  id text primary key, doc jsonb not null,
  student_id text generated always as (doc->>'studentId') stored not null,
  academic_year_id text generated always as (doc->>'academicYearId') stored not null,
  status text generated always as (doc->>'status') stored check (status in ('draft', 'submitted', 'published')),
  -- one per child and year: the id names both, so a second start can only be the same row
  check (id = 'evl-' || academic_year_id || '-' || student_id)
);
create index evaluations_student on public.evaluations (student_id);

create table public.signatures (
  id text primary key, doc jsonb not null,
  owner_kind text generated always as (doc->>'ownerKind') stored check (owner_kind in ('staff', 'director')),
  staff_id text generated always as (doc->>'staffId') stored,
  status text generated always as (doc->>'status') stored check (status in ('ready', 'removed')),
  check ((owner_kind = 'staff') = (staff_id is not null))
);
-- one current signature per person (the domain marks the previous one removed in the same write)
create unique index signatures_one_ready on public.signatures (owner_kind, coalesce(staff_id, '')) where status = 'ready';

alter table public.evaluations enable row level security;
alter table public.evaluations force row level security;
create policy read_scoped on public.evaluations for select to authenticated using (
  case app.my_role()
    when 'admin' then true
    when 'teacher' then exists (select 1 from public.students s where s.id = student_id and s.program_id = any(app.my_program_ids()))
    when 'parent' then status = 'published' and student_id = any(app.my_student_ids())
    else false end);

alter table public.signatures enable row level security;
alter table public.signatures force row level security;
create policy read_scoped on public.signatures for select to authenticated using (
  case app.my_role()
    when 'admin' then true
    when 'teacher' then staff_id = app.my_staff_id()
    else false end);

-- ---------------------------------------------------------------- storage: one more private bucket, no user policies
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('signatures', 'signatures', false, 204800, array['image/png', 'image/jpeg'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------- load_slice wrapper: v5 collections, the evaluation attendance hint
alter function public.load_slice(text[], jsonb) set schema app;
alter function app.load_slice(text[], jsonb) rename to load_slice_0009;
create function public.load_slice(p_collections text[], p_hints jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security invoker set search_path = public, app, pg_temp as $$
declare
  v5 constant jsonb := '{"evaluations":"evaluations","signatures":"signatures"}';
  ea jsonb := case when jsonb_typeof(p_hints->'evalAttendance') = 'object' then p_hints->'evalAttendance' end;
  r jsonb := app.load_slice_0009(array(select c from unnest(p_collections) c where not v5 ? c and not (ea is not null and c = 'attendance')), p_hints);
  c text;
  v jsonb;
  ay text;
  sids text[] := '{}';
  ay_start text;
  ay_end text;
begin
  foreach c in array p_collections loop
    continue when not v5 ? c;
    execute format('select jsonb_agg(doc order by id) from public.%I', v5->>c) into v;
    r := jsonb_set(r, array['db', c], coalesce(v, '[]'::jsonb));
  end loop;
  if ea is not null and 'attendance' = any(p_collections) then
    if nullif(ea->>'evaluationId', '') is not null then
      select array[e.student_id], e.academic_year_id into sids, ay from public.evaluations e where e.id = ea->>'evaluationId';
    elsif nullif(ea->>'studentId', '') is not null then
      sids := array[ea->>'studentId']; ay := ea->>'academicYearId';
    elsif nullif(ea->>'programId', '') is not null then
      sids := array(select s.id from public.students s where s.program_id = ea->>'programId'); ay := ea->>'academicYearId';
    end if;
    select y.doc->>'startDate', y.doc->>'endDate' into ay_start, ay_end from public.academic_years y where y.id = ay;
    r := jsonb_set(r, '{db,attendance}', coalesce((select jsonb_agg(a.doc order by a.id) from public.attendance a
      where a.student_id = any(coalesce(sids, '{}')) and a.date >= ay_start and a.date <= ay_end), '[]'::jsonb));
  end if;
  return jsonb_set(r, '{db,schemaVersion}', '5'::jsonb);
end $$;

-- ---------------------------------------------------------------- persist wrapper: v5 upserts; retention deletes evaluations
alter function public.persist(text, bigint, jsonb) set schema app;
alter function app.persist(text, bigint, jsonb) rename to persist_0009;
create function public.persist(p_rev_key text, p_expected bigint, p_changes jsonb) returns bigint
language plpgsql volatile security invoker set search_path = public, app, pg_temp as $$
declare
  v5 constant jsonb := '{"evaluations":"evaluations","signatures":"signatures"}';
  purge constant jsonb := '{"evaluations":"evaluations"}';
  inner_changes jsonb := p_changes;
  col text;
  arr jsonb;
  res bigint;
begin
  -- the earlier persist first: revision locks and checks, the caller check, request id, every older collection, audit;
  -- it still refuses any delete outside its own allow-list and evaluations (signatures are never deleted)
  if p_changes ? 'upserts' then
    inner_changes := jsonb_set(inner_changes, '{upserts}', (p_changes->'upserts') - array(select jsonb_object_keys(v5)));
  end if;
  if p_changes ? 'deletes' then
    inner_changes := jsonb_set(inner_changes, '{deletes}', (p_changes->'deletes') - array(select jsonb_object_keys(purge)));
  end if;
  res := app.persist_0009(p_rev_key, p_expected, inner_changes);
  -- removed rows first, so a replacement never meets the old row in the one-ready-per-person index
  for col, arr in select * from jsonb_each(coalesce(p_changes->'upserts', '{}'::jsonb)) loop
    continue when not v5 ? col or jsonb_typeof(arr) <> 'array';
    execute format('insert into public.%I (id, doc) select e->>''id'', e from jsonb_array_elements($1) e where e->>''status'' is distinct from ''ready'' on conflict (id) do update set doc = excluded.doc', v5->>col)
      using arr;
    execute format('insert into public.%I (id, doc) select e->>''id'', e from jsonb_array_elements($1) e where e->>''status'' = ''ready'' on conflict (id) do update set doc = excluded.doc', v5->>col)
      using arr;
  end loop;
  for col, arr in select * from jsonb_each(coalesce(p_changes->'deletes', '{}'::jsonb)) loop
    continue when not purge ? col;
    execute format('delete from public.%I where id = any(array(select jsonb_array_elements_text($1)))', purge->>col) using arr;
  end loop;
  return res;
end $$;

-- ---------------------------------------------------------------- my_snapshot wrapper: schema v5 (RLS decides every row)
alter function public.my_snapshot() set schema app;
alter function app.my_snapshot() rename to my_snapshot_0009;
create function public.my_snapshot() returns jsonb language plpgsql stable security invoker set search_path = public, app, pg_temp as $$
declare
  r jsonb := app.my_snapshot_0009();
begin
  if r->>'status' <> 'active' then return r; end if;
  return r || jsonb_build_object(
    'schemaVersion', 5,
    'evaluations', coalesce((select jsonb_agg(doc order by id) from public.evaluations), '[]'::jsonb),
    'signatures', coalesce((select jsonb_agg(doc order by id) from public.signatures), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------- grants
revoke all on public.evaluations, public.signatures from anon, authenticated;
grant select on public.evaluations, public.signatures to authenticated;
grant all on public.evaluations, public.signatures to service_role;
revoke all on function public.my_snapshot(), public.load_slice(text[], jsonb), public.persist(text, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.my_snapshot() to authenticated, service_role;
grant execute on function public.load_slice(text[], jsonb), public.persist(text, bigint, jsonb) to service_role;
revoke all on function app.my_snapshot_0009(), app.load_slice_0009(text[], jsonb), app.persist_0009(text, bigint, jsonb) from public, anon;
revoke all on function app.load_slice_0009(text[], jsonb), app.persist_0009(text, bigint, jsonb) from authenticated;
grant execute on function app.my_snapshot_0009() to authenticated, service_role;
grant execute on function app.load_slice_0009(text[], jsonb), app.persist_0009(text, bigint, jsonb) to service_role;

-- ---------------------------------------------------------------- realtime: a published progress report nudges a refetch
alter publication supabase_realtime add table public.evaluations;

-- ---------------------------------------------------------------- performance: RLS helpers once per statement, not per row
-- Every read policy calls STABLE helpers (app.my_role(), app.my_student_ids(), auth.uid(), …). Called bare inside a
-- policy they are evaluated for every row, and each call reads app_users, the two-step and session-cutoff rows and, for
-- a parent, the consents: a parent's my_snapshot() took 5–7 s on the small local seed, against the 8 s statement timeout
-- of `authenticated`. Wrapped in a scalar sub-select, `(select app.my_role())`, Postgres computes each once per statement
-- (an InitPlan) with the same result, since none of them reads the row. Every policy in schema public is rewritten here
-- (its USING and WITH CHECK expressions, deparsed and re-applied); the logic of each is unchanged, and pgTAP
-- (rls.test.sql, permissions.test.sql) checks every cell again.
-- `x = ANY (app.f())` (an array helper) becomes `x = ANY ((SELECT app.f())::text[])`: the cast keeps it an array
-- expression rather than a sub-query ANY. Every other `app.f(..)` / `auth.f(..)` call becomes `(SELECT app.f(..))`.
-- A marker (§) keeps the second pass off what the first one wrapped. Used by this migration only, then dropped.
create function app.initplan_helpers(e text) returns text language sql immutable set search_path = pg_catalog as $f$
  select case when e is null then null else replace(
    regexp_replace(
      regexp_replace(e, 'ANY \((app\.[a-z_]+\([^()]*\))\)', 'ANY ((SELECT §\1)::text[])', 'g'),
      '(^|[^§])\m((app|auth)\.[a-z_]+\([^()]*\))', '\1(SELECT \2)', 'g'),
    '§', '') end
$f$;
do $$
declare
  p record;
  q text;
  c text;
begin
  for p in select pol.polname, cls.relname, pg_get_expr(pol.polqual, pol.polrelid) as qual, pg_get_expr(pol.polwithcheck, pol.polrelid) as chk
           from pg_policy pol join pg_class cls on cls.oid = pol.polrelid join pg_namespace n on n.oid = cls.relnamespace
           where n.nspname = 'public' loop
    q := app.initplan_helpers(p.qual);
    c := app.initplan_helpers(p.chk);
    continue when q is not distinct from p.qual and c is not distinct from p.chk;
    if q is not null and c is not null then
      execute format('alter policy %I on public.%I using (%s) with check (%s)', p.polname, p.relname, q, c);
    elsif q is not null then
      execute format('alter policy %I on public.%I using (%s)', p.polname, p.relname, q);
    else
      execute format('alter policy %I on public.%I with check (%s)', p.polname, p.relname, c);
    end if;
  end loop;
end $$;
drop function app.initplan_helpers(text);
