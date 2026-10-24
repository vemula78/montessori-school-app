-- Wave 2, part 2 (schema v5; forward-only: 0001–0010 are never edited). New policies here call their helpers inside a
-- scalar sub-select, `(select app.my_role())`, so they run once per statement (0010; pgTAP checks every policy).
--   * health: allergies and medical alerts live in student_health.alerts (never in the student document, which the driver
--     and the accountant read); persist moves students.doc.healthAlerts there; the snapshot and load_slice put it back.
--   * the driver: the dates (never the reasons) of absences parents reported for children on their routes (leave_days,
--     kept by a trigger on leave_requests), and the pick-up people of those children (a drop records who received a child)
--   * teachers: the bus trips and boarding/drop-off marks of their programmes' children (not the bus positions)
--   * a closed staff record (staff.doc.active = false) closes that person's sign-in at once: app.my_link() gives nothing
--     (staff_closed, kept by a trigger on staff) and my_snapshot says 'revoked'
--   * load_slice hints diaryEntryIds (several diary entries) and learningStudentIds (several children's learning records)
--   * conversations with the office (threads.doc.to), UPI payment claims (payment_claims), meeting slots (ptm_slots, with
--     bookings apart in ptm_bookings so parents see a slot is taken, never by whom); retention may delete slots
--   * privacy notice v3: app.consent_version() and every photo consent flag
--   * notice attachments: notice_files rows (staged → attached → removed), bytes in the PRIVATE bucket `notice-files`
--     (no storage policies; the command function signs 60-second downloads for those who may read the notice)
-- persist / load_slice / my_snapshot of 0010 move to schema app and are wrapped here (the 0004–0010 pattern).

-- ---------------------------------------------------------------- health alerts
alter table public.student_health alter column notes drop not null;
alter table public.student_health add column alerts jsonb;
alter table public.students add constraint students_no_health_alerts check (not doc ? 'healthAlerts');

-- ---------------------------------------------------------------- the driver: absences (dates only) of children on their routes
create table public.leave_days (
  id text primary key references public.leave_requests (id) on delete cascade,
  student_id text not null,
  from_date text not null,
  to_date text not null,
  status text not null
);
create index leave_days_student on public.leave_days (student_id, to_date);
create function app.leave_days_sync() returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  insert into public.leave_days (id, student_id, from_date, to_date, status) values (new.id, new.student_id, new.from_date, new.to_date, new.status)
  on conflict (id) do update set student_id = excluded.student_id, from_date = excluded.from_date, to_date = excluded.to_date, status = excluded.status;
  return null;
end $$;
create trigger leave_days_sync after insert or update on public.leave_requests for each row execute function app.leave_days_sync();
insert into public.leave_days (id, student_id, from_date, to_date, status) select id, student_id, from_date, to_date, status from public.leave_requests;
alter table public.leave_days enable row level security;
alter table public.leave_days force row level security;
create policy read_scoped on public.leave_days for select to authenticated using (
  case (select app.my_role())
    when 'admin' then true
    when 'driver' then status = 'active' and to_date >= ((select app.ist_today()))::text
      and exists (select 1 from public.students s where s.id = student_id and s.route_id = any ((select app.my_route_ids())::text[]))
    else false end);

drop policy read_scoped on public.pickup_contacts;
create policy read_scoped on public.pickup_contacts for select to authenticated using (
  case (select app.my_role())
    when 'admin' then true
    when 'teacher' then exists (select 1 from public.students s where s.id = student_id and s.program_id = any ((select app.my_program_ids())::text[]))
    when 'parent' then student_id = any ((select app.my_student_ids())::text[])
    when 'driver' then status = 'active' and exists (select 1 from public.students s where s.id = student_id and s.route_id = any ((select app.my_route_ids())::text[]))
    else false end);

-- ---------------------------------------------------------------- teachers: their children's trips and marks (no positions)
drop policy read_scoped on public.trips;
create policy read_scoped on public.trips for select to authenticated using (
  case (select app.my_role())
    when 'admin' then true when 'accountant' then true
    when 'driver' then route_id = any ((select app.my_route_ids())::text[])
    when 'parent' then route_id = any ((select app.my_bus_route_ids())::text[])
    when 'teacher' then exists (select 1 from public.students s where s.route_id = trips.route_id and s.program_id = any ((select app.my_program_ids())::text[]))
    else false end);
drop policy read_scoped on public.trip_child_events;
create policy read_scoped on public.trip_child_events for select to authenticated using (
  case (select app.my_role())
    when 'admin' then true when 'accountant' then true
    when 'driver' then exists (select 1 from public.trips t where t.id = trip_id)
    when 'parent' then student_id = any ((select app.my_student_ids())::text[]) and student_id = any ((select app.my_consented_student_ids('bus_live'))::text[])
    when 'teacher' then exists (select 1 from public.students s where s.id = student_id and s.program_id = any ((select app.my_program_ids())::text[]))
    else false end);
drop policy read_scoped on public.trip_positions;
create policy read_scoped on public.trip_positions for select to authenticated using (
  (select app.my_role()) is distinct from 'teacher' and exists (select 1 from public.trips t where t.id = trip_id));

-- ---------------------------------------------------------------- a closed staff record closes the sign-in
create table public.staff_closed (staff_id text primary key references public.staff (id) on delete cascade);
create function app.staff_closed_sync() returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if coalesce((new.doc->>'active')::boolean, true) then delete from public.staff_closed where staff_id = new.id;
  else insert into public.staff_closed (staff_id) values (new.id) on conflict do nothing;
  end if;
  return null;
end $$;
create trigger staff_closed_sync after insert or update of doc on public.staff for each row execute function app.staff_closed_sync();
insert into public.staff_closed (staff_id) select id from public.staff where (doc->>'active')::boolean is false on conflict do nothing;
alter table public.staff_closed enable row level security;
alter table public.staff_closed force row level security;
-- app.my_link reads it as the caller: their own row only, found through app_users (whose policy never calls my_link)
create policy read_own on public.staff_closed for select to authenticated using (
  staff_id = (select u.staff_id from public.app_users u where u.user_id = (select auth.uid())));

create or replace function app.my_link() returns public.app_users language sql stable security invoker set search_path = public, pg_temp as $$
  select u.* from public.app_users u
  where u.user_id = auth.uid() and u.status = 'active'
    and (u.role not in ('admin', 'accountant') or app.two_step_ok(u.user_id))
    and not app.session_cut(u.user_id)
    and not exists (select 1 from public.staff_closed c where c.staff_id = u.staff_id)
$$;

-- ---------------------------------------------------------------- notice attachments (#12 #84), bus-route notices (#85)
-- Files are staged by their uploader, then attached to a notice; parents read the rows of notices sent to them (the
-- notices policy decides) unless the notice was withdrawn. A bus-route notice ({scope:'route', routeIds}) reaches parents
-- through their receipts, like every notice; teachers do not read it (the notices policy has no case for it).
create table public.notice_files (
  id text primary key, doc jsonb not null,
  notice_id text generated always as (doc->>'noticeId') stored,
  uploaded_by text generated always as (doc->>'uploadedBy') stored not null,
  status text generated always as (doc->>'status') stored check (status in ('staged', 'attached', 'removed')),
  check ((status = 'attached') <= (notice_id is not null))
);
create index notice_files_notice on public.notice_files (notice_id);
alter table public.notice_files enable row level security;
alter table public.notice_files force row level security;
create policy read_scoped on public.notice_files for select to authenticated using (
  case (select app.my_role())
    when 'admin' then true when 'accountant' then status <> 'staged'
    when 'teacher' then (status = 'staged' and uploaded_by = (select app.my_staff_id()))
      or (status = 'attached' and exists (select 1 from public.notices n where n.id = notice_id))
    when 'parent' then status = 'attached' and exists (select 1 from public.notices n where n.id = notice_id and n.doc->>'withdrawnAt' is null)
    else false end);
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('notice-files', 'notice-files', false, 2097152, array['application/pdf', 'image/jpeg', 'image/png'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------- conversations with the office (#11)
-- thread.doc.to: absent/'teacher' (the child's teachers), 'accountant' (the fee office: the accountant and the principal),
-- 'principal' (the principal only). Teachers never read the office's conversations; messages follow their thread.
drop policy read_scoped on public.threads;
create policy read_scoped on public.threads for select to authenticated using (
  case (select app.my_role())
    when 'admin' then true
    when 'teacher' then coalesce(doc->>'to', 'teacher') = 'teacher' and program_id = any ((select app.my_program_ids())::text[])
    when 'accountant' then doc->>'to' = 'accountant'
    when 'parent' then guardian_id = (select app.my_guardian_id()) and student_id = any ((select app.my_student_ids())::text[])
    else false end);

-- ---------------------------------------------------------------- UPI payments a family reports (#81)
create table public.payment_claims (
  id text primary key, doc jsonb not null,
  student_id text generated always as (doc->>'studentId') stored not null,
  status text generated always as (doc->>'status') stored check (status in ('pending', 'confirmed', 'rejected'))
);
create index payment_claims_student on public.payment_claims (student_id);
alter table public.payment_claims enable row level security;
alter table public.payment_claims force row level security;
create policy read_scoped on public.payment_claims for select to authenticated using (
  case (select app.my_role())
    when 'admin' then true when 'accountant' then true
    when 'parent' then student_id = any ((select app.my_student_ids())::text[])
    else false end);

-- ---------------------------------------------------------------- parent-teacher meeting slots (#88)
-- A slot's booking is kept apart (ptm_bookings) so a parent reads that a slot is taken (doc.booked) but never by whom.
create table public.ptm_slots (
  id text primary key, doc jsonb not null,
  program_id text generated always as (doc->>'programId') stored not null,
  date text generated always as (doc->>'date') stored not null,
  check (not doc ? 'booking')
);
create index ptm_slots_program_date on public.ptm_slots (program_id, date);
create table public.ptm_bookings (
  slot_id text primary key references public.ptm_slots (id) on delete cascade,
  student_id text not null,
  doc jsonb not null
);
create index ptm_bookings_student on public.ptm_bookings (student_id);
alter table public.ptm_slots enable row level security;
alter table public.ptm_slots force row level security;
alter table public.ptm_bookings enable row level security;
alter table public.ptm_bookings force row level security;
create policy read_scoped on public.ptm_slots for select to authenticated using (
  case (select app.my_role())
    when 'admin' then true
    when 'teacher' then program_id = any ((select app.my_program_ids())::text[])
    when 'parent' then program_id in (select s.program_id from public.students s where s.id = any ((select app.my_student_ids())::text[]))
    else false end);
create policy read_scoped on public.ptm_bookings for select to authenticated using (
  case (select app.my_role())
    when 'admin' then true
    when 'teacher' then exists (select 1 from public.ptm_slots x where x.id = slot_id and x.program_id = any ((select app.my_program_ids())::text[]))
    when 'parent' then student_id = any ((select app.my_student_ids())::text[])
    else false end);

-- ---------------------------------------------------------------- privacy notice v3 (#94)
-- Must equal CONSENT_VERSION (src/domain/commands.js) and PRIVACY_VERSION (src/ui/privacy.js). Every parent accepts v3
-- before their children's data shows again (RLS evaluates consent at this version). The photo consent flags are kept by
-- triggers on consents and guardians only, so they are recomputed here against v3 (0006: a version change must refresh
-- every flag): until a guardian accepts v3 with photos, that child's photos are hidden and the nightly sweep deletes them.
create or replace function app.consent_version() returns text language sql immutable set search_path = pg_catalog as $$ select 'v3'::text $$;
select app.refresh_photo_consent(array(select id from public.students));

-- ---------------------------------------------------------------- load_slice wrapper
alter function public.load_slice(text[], jsonb) set schema app;
alter function app.load_slice(text[], jsonb) rename to load_slice_0010;
create function public.load_slice(p_collections text[], p_hints jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security invoker set search_path = public, app, pg_temp as $$
declare
  v5b constant jsonb := '{"noticeFiles":"notice_files","paymentClaims":"payment_claims"}';
  r jsonb := app.load_slice_0010(array(select c from unnest(p_collections) c where not v5b ? c and c <> 'ptmSlots'), p_hints);
  learn constant jsonb := '{"observations":"observations","photos":"photos","progressEvents":"progress_events","reports":"reports"}';
  ids text[];
  c text;
  v jsonb;
begin
  -- wave-2 collections: small, loaded whole
  foreach c in array p_collections loop
    continue when not v5b ? c;
    execute format('select jsonb_agg(doc order by id) from public.%I', v5b->>c) into v;
    r := jsonb_set(r, array['db', c], coalesce(v, '[]'::jsonb));
  end loop;
  if 'ptmSlots' = any(p_collections) then
    r := jsonb_set(r, '{db,ptmSlots}', coalesce((select jsonb_agg((x.doc - 'booked') || jsonb_build_object('booking', b.doc) order by x.id)
      from public.ptm_slots x left join public.ptm_bookings b on b.slot_id = x.id), '[]'::jsonb));
  end if;
  -- the students' allergies and medical alerts (student_health.alerts)
  if 'students' = any(p_collections) then
    r := jsonb_set(r, '{db,students}', coalesce((select jsonb_agg(x || jsonb_build_object('healthAlerts', (select h.alerts from public.student_health h where h.student_id = x->>'id')) order by n)
      from jsonb_array_elements(r->'db'->'students') with ordinality e(x, n)), '[]'::jsonb));
  end if;
  -- several diary entries by id (diary.removeMany)
  if 'diaryEntries' = any(p_collections) and jsonb_typeof(p_hints->'diaryEntryIds') = 'array' then
    ids := array(select jsonb_array_elements_text(p_hints->'diaryEntryIds'));
    r := jsonb_set(r, '{db,diaryEntries}', coalesce((select jsonb_agg(doc order by id) from public.diary_entries where id = any(ids)), '[]'::jsonb));
  end if;
  -- several children's learning records (progress.recordMany): their rows join whatever the other hints loaded
  if jsonb_typeof(p_hints->'learningStudentIds') = 'array' then
    ids := array(select jsonb_array_elements_text(p_hints->'learningStudentIds'));
    foreach c in array p_collections loop
      continue when not learn ? c;
      execute format('select jsonb_agg(doc order by id) from public.%I where student_id = any($1)', learn->>c) into v using ids;
      r := jsonb_set(r, array['db', c], coalesce((select jsonb_agg(x) from (
        select x from jsonb_array_elements(r->'db'->c) x where not (x->>'studentId' = any(ids))
        union all select x from jsonb_array_elements(coalesce(v, '[]'::jsonb)) x) y), '[]'::jsonb));
    end loop;
  end if;
  return r;
end $$;

-- ---------------------------------------------------------------- persist wrapper: health alerts out of the student document
alter function public.persist(text, bigint, jsonb) set schema app;
alter function app.persist(text, bigint, jsonb) rename to persist_0010;
create function public.persist(p_rev_key text, p_expected bigint, p_changes jsonb) returns bigint
language plpgsql volatile security invoker set search_path = public, app, pg_temp as $$
declare
  v5b constant jsonb := '{"noticeFiles":"notice_files","paymentClaims":"payment_claims"}';
  inner_changes jsonb := p_changes;
  studs jsonb := p_changes->'upserts'->'students';
  col text;
  arr jsonb;
  x jsonb;
  res bigint;
begin
  if p_changes ? 'upserts' then
    inner_changes := jsonb_set(inner_changes, '{upserts}', (p_changes->'upserts') - array(select jsonb_object_keys(v5b)) - 'ptmSlots');
  end if;
  if p_changes ? 'deletes' then
    inner_changes := jsonb_set(inner_changes, '{deletes}', (p_changes->'deletes') - 'ptmSlots');
  end if;
  if jsonb_typeof(studs) = 'array' then
    inner_changes := jsonb_set(inner_changes, '{upserts,students}', coalesce((select jsonb_agg(e - 'healthAlerts') from jsonb_array_elements(studs) e), '[]'::jsonb));
  end if;
  -- the earlier persist first (it keeps or deletes the student_health row by the note)
  res := app.persist_0010(p_rev_key, p_expected, inner_changes);
  for col, arr in select * from jsonb_each(coalesce(p_changes->'upserts', '{}'::jsonb)) loop
    continue when not v5b ? col or jsonb_typeof(arr) <> 'array';
    execute format('insert into public.%I (id, doc) select e->>''id'', e from jsonb_array_elements($1) e on conflict (id) do update set doc = excluded.doc', v5b->>col)
      using arr;
  end loop;
  -- meeting slots: the slot (with booked true/false) and its booking apart
  for x in select * from jsonb_array_elements(case when jsonb_typeof(p_changes->'upserts'->'ptmSlots') = 'array' then p_changes->'upserts'->'ptmSlots' else '[]'::jsonb end) loop
    insert into public.ptm_slots (id, doc) values (x->>'id', (x - 'booking') || jsonb_build_object('booked', jsonb_typeof(x->'booking') = 'object'))
      on conflict (id) do update set doc = excluded.doc;
    if jsonb_typeof(x->'booking') = 'object' then
      insert into public.ptm_bookings (slot_id, student_id, doc) values (x->>'id', x->'booking'->>'studentId', x->'booking')
        on conflict (slot_id) do update set student_id = excluded.student_id, doc = excluded.doc;
    else
      delete from public.ptm_bookings where slot_id = x->>'id';
    end if;
  end loop;
  -- retention: slots a departed child had booked (their bookings go with them)
  if jsonb_typeof(p_changes->'deletes'->'ptmSlots') = 'array' then
    delete from public.ptm_slots where id = any(array(select jsonb_array_elements_text(p_changes->'deletes'->'ptmSlots')));
  end if;
  if jsonb_typeof(studs) = 'array' then
    for x in select * from jsonb_array_elements(studs) loop
      continue when not x ? 'healthAlerts';
      if jsonb_typeof(x->'healthAlerts') = 'object' then
        insert into public.student_health (student_id, notes, alerts) values (x->>'id', nullif(x->>'healthNotes', ''), x->'healthAlerts')
          on conflict (student_id) do update set alerts = excluded.alerts;
      else
        update public.student_health set alerts = null where student_id = x->>'id';
        delete from public.student_health where student_id = x->>'id' and notes is null and alerts is null;
      end if;
    end loop;
  end if;
  return res;
end $$;

-- ---------------------------------------------------------------- my_snapshot wrapper
alter function public.my_snapshot() set schema app;
alter function app.my_snapshot() rename to my_snapshot_0010;
create function public.my_snapshot() returns jsonb language plpgsql stable security invoker set search_path = public, app, pg_temp as $$
declare
  r jsonb;
begin
  -- a closed staff record: the sign-in reads nothing and the app says so
  if exists (select 1 from public.app_users u join public.staff_closed c on c.staff_id = u.staff_id where u.user_id = auth.uid() and u.status = 'active') then
    return jsonb_build_object('status', 'revoked');
  end if;
  r := app.my_snapshot_0010();
  if r->>'status' <> 'active' then return r; end if;
  r := jsonb_set(r, '{students}', coalesce((select jsonb_agg(x || jsonb_build_object('healthAlerts', (select h.alerts from public.student_health h where h.student_id = x->>'id')) order by n)
    from jsonb_array_elements(r->'students') with ordinality e(x, n)), '[]'::jsonb));
  r := r || jsonb_build_object(
    'noticeFiles', coalesce((select jsonb_agg(doc - 'path' order by id) from public.notice_files), '[]'::jsonb),
    'paymentClaims', coalesce((select jsonb_agg(doc order by id) from public.payment_claims), '[]'::jsonb),
    -- a parent reads another family's slot as booked:true with booking null (ptm_bookings RLS)
    'ptmSlots', coalesce((select jsonb_agg(x.doc || jsonb_build_object('booking', b.doc) order by x.date, x.id)
      from public.ptm_slots x left join public.ptm_bookings b on b.slot_id = x.id where x.date >= ((app.ist_today() - 30))::text), '[]'::jsonb));
  -- the driver: reported absences of their route's children, dates only (no reason, no guardian)
  if r->'me'->>'role' = 'driver' then
    r := jsonb_set(r, '{leaveRequests}', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'studentId', d.student_id, 'fromDate', d.from_date, 'toDate', d.to_date,
      'status', d.status, 'reason', null, 'guardianId', null) order by d.from_date, d.id) from public.leave_days d), '[]'::jsonb));
  end if;
  return r;
end $$;

-- ---------------------------------------------------------------- grants
revoke all on public.leave_days, public.staff_closed, public.notice_files, public.payment_claims, public.ptm_slots, public.ptm_bookings from anon, authenticated;
grant select on public.leave_days, public.staff_closed, public.notice_files, public.payment_claims, public.ptm_slots, public.ptm_bookings to authenticated;
grant all on public.leave_days, public.staff_closed, public.notice_files, public.payment_claims, public.ptm_slots, public.ptm_bookings to service_role;
revoke all on function app.leave_days_sync(), app.staff_closed_sync() from public, anon, authenticated;
grant execute on function app.leave_days_sync(), app.staff_closed_sync() to service_role;
revoke all on function public.my_snapshot(), public.load_slice(text[], jsonb), public.persist(text, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.my_snapshot() to authenticated, service_role;
grant execute on function public.load_slice(text[], jsonb), public.persist(text, bigint, jsonb) to service_role;
revoke all on function app.my_snapshot_0010(), app.load_slice_0010(text[], jsonb), app.persist_0010(text, bigint, jsonb) from public, anon;
revoke all on function app.load_slice_0010(text[], jsonb), app.persist_0010(text, bigint, jsonb) from authenticated;
grant execute on function app.my_snapshot_0010() to authenticated, service_role;
grant execute on function app.load_slice_0010(text[], jsonb), app.persist_0010(text, bigint, jsonb) to service_role;
