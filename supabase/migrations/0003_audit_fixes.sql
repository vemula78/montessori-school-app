-- Phase 2 audit fixes (forward-only: 0001/0002 are never edited). Numbers refer to the audit findings.
--   #1  staff role only for a confirmed mailbox; a password set before confirmation is voided at confirmation
--   #3  children's boarding/drop-off events move out of trips.doc into trip_child_events (RLS per child)
--   #6  parent data needs current app_account consent per child (RLS); the consent screen still sees the children
--   #7  bus and push consent are per child and per notice version
--   #12 #20  load_slice returns the caller's link/consents and a prior request; persist stores the request id
--   #13 persist checks (and moves) every slice revision a command's changes touch, not only its own
--   #28 reminders are claimed atomically, marked sent only after delivery, retried after a failure
--   #29 calendar events by program; notice/receipt student lists in their own RLS-scoped tables
--   #38 stale-trip cleanup every 15 minutes
--   #42 the order-creation limit is taken atomically

-- ---------------------------------------------------------------- #1 auth link
-- The ONLY security definer function (pgTAP enforces it). Links a sign-in to a staff member by exact email, at
-- most once, and only when the mailbox is confirmed: on insert of an already-confirmed user (admin-created, seed),
-- or when email_confirmed_at goes from null to set (OTP/confirmation code entered). At that moment any password
-- set before confirmation is replaced by a random one: whoever set it never proved they own the mailbox
-- (the app signs in by email code only, so no real user loses anything).
create or replace function app.link_new_auth_user() returns trigger language plpgsql security definer set search_path = '' as $$
declare s record;
begin
  if new.email_confirmed_at is null then return new; end if;
  if tg_op = 'UPDATE' then
    if old.email_confirmed_at is not null then return new; end if;
    new.encrypted_password := extensions.crypt(encode(extensions.gen_random_bytes(32), 'hex'), extensions.gen_salt('bf'));
  end if;
  select st.id, st.role into s from public.staff_contacts c join public.staff st on st.id = c.staff_id
   where c.email is not null and lower(c.email) = lower(new.email);
  if found then
    insert into public.app_users (user_id, role, staff_id, status) values (new.id, s.role, s.id, 'active') on conflict (user_id) do nothing;
  end if;
  return new;
end $$;
-- insert: AFTER (app_users references auth.users). confirmation: BEFORE (so the password can be replaced).
create trigger on_auth_user_confirmed before update of email_confirmed_at on auth.users for each row
  when (old.email_confirmed_at is null and new.email_confirmed_at is not null) execute function app.link_new_auth_user();

-- ---------------------------------------------------------------- consent helpers (#6, #7)
-- Must equal CONSENT_VERSION in src/domain/commands.js (a unit test compares them).
create function app.consent_version() returns text language sql immutable set search_path = pg_catalog as $$ select 'v1'::text $$;
-- parent: every linked child, consent or not (the consent screen lists them). Empty for every other role.
create function app.my_linked_student_ids() returns text[] language sql stable security invoker set search_path = public, pg_temp as $$
  select coalesce(array_agg(sg.student_id), '{}') from public.student_guardians sg
  where app.my_role() = 'parent' and sg.guardian_id = app.my_guardian_id()
$$;
-- parent: linked children with live consent for the purpose at the current notice version
create function app.my_consented_student_ids(p_purpose text) returns text[] language sql stable security invoker set search_path = public, pg_temp as $$
  select coalesce(array_agg(distinct c.student_id), '{}') from public.consents c
  where app.my_role() = 'parent' and c.guardian_id = app.my_guardian_id() and c.purpose = p_purpose and c.withdrawn_at is null
    and c.version = app.consent_version() and c.student_id = any(app.my_linked_student_ids())
$$;
-- parent: only children with app_account consent (every data policy uses this one)
create or replace function app.my_student_ids() returns text[] language sql stable security invoker set search_path = public, pg_temp as $$
  select app.my_consented_student_ids('app_account')
$$;
create or replace function app.has_consent(p_purpose text) returns boolean language sql stable security invoker set search_path = public, pg_temp as $$
  select cardinality(app.my_consented_student_ids(p_purpose)) > 0
$$;
-- parent: routes of own children who have both app_account and bus_live consent (current version)
create function app.my_bus_route_ids() returns text[] language sql stable security invoker set search_path = public, pg_temp as $$
  select coalesce(array_agg(distinct s.route_id), '{}') from public.students s
  where s.route_id is not null and s.id = any(app.my_student_ids()) and s.id = any(app.my_consented_student_ids('bus_live'))
$$;

drop policy read_scoped on public.students;
create policy read_scoped on public.students for select to authenticated using (
  case app.my_role()
    when 'admin' then true when 'accountant' then true
    when 'teacher' then program_id = any(app.my_program_ids())
    when 'driver' then route_id = any(app.my_route_ids())
    when 'parent' then id = any(app.my_linked_student_ids())
    else false end);
drop policy read_scoped on public.trips;
create policy read_scoped on public.trips for select to authenticated using (
  case app.my_role()
    when 'admin' then true when 'accountant' then true
    when 'driver' then route_id = any(app.my_route_ids())
    when 'parent' then route_id = any(app.my_bus_route_ids())
    else false end);
drop policy read_scoped on public.threads;
create policy read_scoped on public.threads for select to authenticated using (
  case app.my_role()
    when 'admin' then true
    when 'teacher' then program_id = any(app.my_program_ids())
    when 'parent' then guardian_id = app.my_guardian_id() and student_id = any(app.my_student_ids())
    else false end);

-- ---------------------------------------------------------------- #3 children's trip events, scoped per child
create table public.trip_child_events (
  trip_id text not null references public.trips (id) on delete cascade,
  seq int not null,
  doc jsonb not null,
  student_id text generated always as (doc->>'studentId') stored,
  primary key (trip_id, seq)
);
create index trip_child_events_student on public.trip_child_events (student_id);
insert into public.trip_child_events (trip_id, seq, doc)
  select t.id, e.ord::int, e.value from public.trips t, jsonb_array_elements(coalesce(t.doc->'childEvents', '[]'::jsonb)) with ordinality e(value, ord);
update public.trips set doc = doc - 'childEvents' where doc ? 'childEvents';
alter table public.trips add constraint trips_no_child_events check (not doc ? 'childEvents');
alter table public.trip_child_events enable row level security;
alter table public.trip_child_events force row level security;
create policy read_scoped on public.trip_child_events for select to authenticated using (
  case app.my_role()
    when 'admin' then true when 'accountant' then true
    when 'driver' then exists (select 1 from public.trips t where t.id = trip_id)
    when 'parent' then student_id = any(app.my_student_ids()) and student_id = any(app.my_consented_student_ids('bus_live'))
    else false end);

-- ---------------------------------------------------------------- #29 calendar by program; notice/receipt student lists
drop policy read_active on public.calendar_events;
create policy read_scoped on public.calendar_events for select to authenticated using (
  case app.my_role()
    when 'admin' then true when 'accountant' then true
    when 'teacher' then coalesce(jsonb_array_length(doc->'programIds'), 0) = 0 or (doc->'programIds') ?| app.my_program_ids()
    when 'parent' then coalesce(jsonb_array_length(doc->'programIds'), 0) = 0
      or (doc->'programIds') ?| coalesce((select array_agg(distinct s.program_id) from public.students s where s.id = any(app.my_student_ids())), '{}')
    when 'driver' then coalesce(jsonb_array_length(doc->'programIds'), 0) = 0
    else false end);

create table public.notice_students (
  notice_id text not null references public.notices (id) on delete cascade,
  student_id text not null,
  primary key (notice_id, student_id)
);
create table public.notice_receipt_students (
  notice_id text not null,
  guardian_id text not null,
  student_id text not null,
  primary key (notice_id, guardian_id, student_id)
);
insert into public.notice_students (notice_id, student_id)
  select n.id, x from public.notices n, jsonb_array_elements_text(n.doc->'audience'->'studentIds') x where (n.doc->'audience') ? 'studentIds'
  on conflict do nothing;
update public.notices set doc = doc #- '{audience,studentIds}' where (doc->'audience') ? 'studentIds';
insert into public.notice_receipt_students (notice_id, guardian_id, student_id)
  select r.notice_id, r.guardian_id, x from public.notice_receipts r, jsonb_array_elements_text(coalesce(r.doc->'studentIds', '[]'::jsonb)) x
  on conflict do nothing;
update public.notice_receipts set doc = doc - 'studentIds' where doc ? 'studentIds';
alter table public.notices add constraint notices_no_student_ids check (not coalesce((doc->'audience') ? 'studentIds', false));
alter table public.notice_receipts add constraint receipts_no_student_ids check (not doc ? 'studentIds');
alter table public.notice_students enable row level security;
alter table public.notice_students force row level security;
alter table public.notice_receipt_students enable row level security;
alter table public.notice_receipt_students force row level security;
create policy read_scoped on public.notice_students for select to authenticated using (
  case app.my_role()
    when 'admin' then true when 'accountant' then true
    when 'teacher' then exists (select 1 from public.students s where s.id = student_id and s.program_id = any(app.my_program_ids()))
    when 'parent' then student_id = any(app.my_student_ids())
    else false end);
create policy read_scoped on public.notice_receipt_students for select to authenticated using (
  case app.my_role()
    when 'admin' then true when 'accountant' then true
    when 'teacher' then exists (select 1 from public.students s where s.id = student_id and s.program_id = any(app.my_program_ids()))
    when 'parent' then guardian_id = app.my_guardian_id() and student_id = any(app.my_student_ids())
    else false end);
drop policy read_scoped on public.notices;
create policy read_scoped on public.notices for select to authenticated using (
  case app.my_role()
    when 'admin' then true when 'accountant' then true
    when 'teacher' then doc->'audience'->>'scope' = 'school'
      or (doc->'audience'->>'scope' = 'program' and (doc->'audience'->'programIds') ?| app.my_program_ids())
      or (doc->'audience'->>'scope' = 'students' and exists (select 1 from public.notice_students ns join public.students s on s.id = ns.student_id
            where ns.notice_id = notices.id and s.program_id = any(app.my_program_ids())))
    when 'parent' then exists (select 1 from public.notice_receipts r where r.notice_id = notices.id and r.guardian_id = app.my_guardian_id())
    else false end);
drop policy read_scoped on public.notice_receipts;
create policy read_scoped on public.notice_receipts for select to authenticated using (
  case app.my_role()
    when 'admin' then true when 'accountant' then true
    when 'teacher' then exists (select 1 from public.notice_receipt_students x join public.students s on s.id = x.student_id
                                where x.notice_id = notice_receipts.notice_id and x.guardian_id = notice_receipts.guardian_id and s.program_id = any(app.my_program_ids()))
    when 'parent' then guardian_id = app.my_guardian_id() and exists (select 1 from public.notice_receipt_students x
                                where x.notice_id = notice_receipts.notice_id and x.guardian_id = notice_receipts.guardian_id and x.student_id = any(app.my_student_ids()))
    else false end);

-- ---------------------------------------------------------------- #20 request ids, #42 order attempts (server only)
create table app.command_requests (
  request_id text primary key,
  user_id uuid not null,
  name text not null,
  result jsonb,
  created_at timestamptz not null default now()
);
create table app.order_attempts (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  created_at timestamptz not null default now()
);
create index order_attempts_user on app.order_attempts (user_id, created_at);

-- One slot per gateway order attempt, counted BEFORE the gateway is called (a failed insert still counts) and
-- taken under a per-user transaction lock, so parallel requests cannot all pass the check.
create function public.take_order_slot(p_user uuid, p_max int, p_window interval default '1 hour') returns boolean
language plpgsql volatile security invoker set search_path = public, app, pg_temp as $$
declare n int;
begin
  perform pg_advisory_xact_lock(hashtextextended('order-slot:' || p_user::text, 0));
  select count(*) into n from app.order_attempts where user_id = p_user and created_at > now() - p_window;
  if n >= p_max then return false; end if;
  insert into app.order_attempts (user_id) values (p_user);
  return true;
end $$;

-- cron housekeeping: request ids kept 7 days, order attempts 2 days; returns rows removed
create function public.prune_request_logs() returns jsonb language plpgsql volatile security invoker set search_path = public, app, pg_temp as $$
declare a int; b int;
begin
  delete from app.command_requests where created_at < now() - interval '7 days';
  get diagnostics a = row_count;
  delete from app.order_attempts where created_at < now() - interval '2 days';
  get diagnostics b = row_count;
  return jsonb_build_object('commandRequests', a, 'orderAttempts', b);
end $$;

-- ---------------------------------------------------------------- #28 reminders: claim → deliver → finish
alter table public.reminders_sent
  add column status text not null default 'sent' check (status in ('claimed', 'sent', 'failed')),
  add column claimed_at timestamptz,
  add column attempts int not null default 1,
  add column last_error text;
-- Claims the given reminders for this run: new ones, failed ones, and claims abandoned for 30 minutes (a crash).
-- Returns only the rows THIS call claimed: a concurrent run gets nothing for them and sends nothing.
create function public.claim_reminders(p_rows jsonb, p_stale_after interval default '30 minutes') returns setof public.reminders_sent
language sql volatile security invoker set search_path = public, pg_temp as $$
  insert into public.reminders_sent as r (invoice_id, kind, sent_on, text, status, claimed_at, attempts)
  select x->>'invoiceId', x->>'kind', (x->>'sentOn')::date, x->>'text', 'claimed', now(), 1 from jsonb_array_elements(p_rows) x
  on conflict (invoice_id, kind) do update set status = 'claimed', claimed_at = now(), attempts = r.attempts + 1, sent_on = excluded.sent_on, text = excluded.text
    where r.status = 'failed' or (r.status = 'claimed' and r.claimed_at < now() - p_stale_after)
  returning r.*
$$;
-- p_rows: [{invoiceId, kind, status:'sent'|'failed', pushSent, error}] for rows this run claimed
create function public.finish_reminders(p_rows jsonb) returns int language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare n int;
begin
  update public.reminders_sent r set status = x->>'status', push_sent = coalesce((x->>'pushSent')::int, 0), last_error = x->>'error'
  from jsonb_array_elements(p_rows) x
  where r.invoice_id = x->>'invoiceId' and r.kind = x->>'kind' and r.status = 'claimed' and x->>'status' in ('sent', 'failed');
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------- snapshot (replaces 0001's): child events, notice lists
create or replace function public.my_snapshot() returns jsonb language plpgsql stable security invoker set search_path = public, app, pg_temp as $$
declare
  u public.app_users;
  today date := app.ist_today();
  fin boolean;
begin
  select * into u from public.app_users where user_id = auth.uid();
  if not found then return jsonb_build_object('status', 'unlinked'); end if;
  if u.status <> 'active' then return jsonb_build_object('status', u.status); end if;
  fin := u.role in ('admin', 'accountant');
  return jsonb_build_object(
    'status', 'active',
    'me', jsonb_build_object('userId', u.user_id, 'role', u.role, 'staffId', u.staff_id, 'guardianId', u.guardian_id),
    'schemaVersion', 1,
    'rev', coalesce((select sum(rev) from app.revs), 0),
    'revs', coalesce((select jsonb_object_agg(slice, rev) from app.revs), '{}'::jsonb),
    'school', coalesce((select doc from public.school where id = 'school'), '{}'::jsonb),
    'academicYears', coalesce((select jsonb_agg(doc order by id) from public.academic_years), '[]'),
    'programs', coalesce((select jsonb_agg(doc order by id) from public.programs), '[]'),
    'feeHeads', coalesce((select jsonb_agg(doc order by id) from public.fee_heads), '[]'),
    'feeStructures', case when fin then coalesce((select jsonb_agg(doc order by id) from public.fee_structures), '[]') else '[]' end,
    'students', coalesce((select jsonb_agg(s.doc || jsonb_build_object(
        'guardianIds', coalesce((select jsonb_agg(sg.guardian_id order by sg.ord, sg.guardian_id) from public.student_guardians sg where sg.student_id = s.id), '[]'),
        'healthNotes', (select h.notes from public.student_health h where h.student_id = s.id)) order by s.id) from public.students s), '[]'),
    'guardians', coalesce((select jsonb_agg(g.doc || jsonb_build_object(
        'studentIds', coalesce((select jsonb_agg(sg.student_id order by sg.student_id) from public.student_guardians sg join public.students s on s.id = sg.student_id where sg.guardian_id = g.id), '[]')) order by g.id)
        from public.guardians g), '[]'),
    'staff', coalesce((select jsonb_agg(st.doc || jsonb_build_object('phone', (select c.phone from public.staff_contacts c where c.staff_id = st.id)) order by st.id) from public.staff st), '[]'),
    'notices', coalesce((select jsonb_agg(case when n.doc->'audience'->>'scope' = 'students'
        then jsonb_set(n.doc, '{audience,studentIds}', coalesce((select jsonb_agg(ns.student_id order by ns.student_id) from public.notice_students ns where ns.notice_id = n.id), '[]'))
        else n.doc end order by n.id) from public.notices n), '[]'),
    'noticeReceipts', coalesce((select jsonb_agg(r.doc || jsonb_build_object('studentIds', coalesce((select jsonb_agg(x.student_id order by x.student_id)
        from public.notice_receipt_students x where x.notice_id = r.notice_id and x.guardian_id = r.guardian_id), '[]')) order by r.id) from public.notice_receipts r), '[]'),
    'threads', coalesce((select jsonb_agg(doc order by id) from public.threads), '[]'),
    'messages', coalesce((select jsonb_agg(doc order by id) from public.messages), '[]'),
    'calendarEvents', coalesce((select jsonb_agg(doc order by id) from public.calendar_events), '[]'),
    'routes', coalesce((select jsonb_agg(doc order by id) from public.routes), '[]'),
    -- trips of the last 7 days: positions come from trip_positions; child events only those RLS lets this user see
    'trips', coalesce((select jsonb_agg(t.doc || jsonb_build_object('positions', '[]'::jsonb, 'childEvents',
        coalesce((select jsonb_agg(e.doc order by e.seq) from public.trip_child_events e where e.trip_id = t.id), '[]'::jsonb)) order by t.id)
        from public.trips t where t.date >= (today - 7)::text), '[]'),
    'invoices', coalesce((select jsonb_agg(doc order by id) from public.invoices), '[]'),
    'payments', coalesce((select jsonb_agg(doc order by id) from public.payments), '[]'),
    'refunds', coalesce((select jsonb_agg(doc order by id) from public.refunds), '[]'),
    'credits', coalesce((select jsonb_agg(doc order by id) from public.credits), '[]'),
    'attendance', coalesce((select jsonb_agg(doc order by id) from public.attendance where date >= (today - 60)::text), '[]'),
    'diaryEntries', coalesce((select jsonb_agg(doc order by id) from public.diary_entries where date >= (today - 30)::text), '[]'),
    'auditLog', '[]'::jsonb,
    'counters', jsonb_build_object('invoice', '{}'::jsonb, 'receipt', '{}'::jsonb, 'refund', '{}'::jsonb),
    'consents', coalesce((select jsonb_agg(doc order by id) from public.consents where guardian_id = u.guardian_id), '[]'),
    'remindersSent', coalesce((select jsonb_agg(jsonb_build_object('invoiceId', invoice_id, 'kind', kind, 'sentOn', sent_on, 'text', text) order by sent_on desc)
        from public.reminders_sent where sent_on >= today - 60), '[]')
  );
end $$;

-- ---------------------------------------------------------------- load_slice (replaces 0001's)
-- New hints: tripsAll (every trip, no positions), importRowsAll, exportGuardianId (server-only collections of one
-- guardian), callerUserId (the caller's link + consents, read in the SAME snapshot as the data: a retry after a
-- conflict re-reads them), requestId (a request already committed under that id).
create or replace function public.load_slice(p_collections text[], p_hints jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security invoker set search_path = public, app, pg_temp as $$
declare
  c text;
  res jsonb := jsonb_build_object('schemaVersion', 1, 'rev', 0, 'auditLog', '[]'::jsonb);
  v jsonb;
  today date := app.ist_today();
  eg text := nullif(p_hints->>'exportGuardianId', '');
  link public.app_users;
begin
  res := res || jsonb_build_object('school', coalesce((select doc from public.school where id = 'school'), '{}'::jsonb));
  res := res || jsonb_build_object('counters', jsonb_build_object(
    'invoice', coalesce((select jsonb_object_agg(academic_year_id, n) from public.counters where kind = 'invoice'), '{}'::jsonb),
    'receipt', coalesce((select jsonb_object_agg(academic_year_id, n) from public.counters where kind = 'receipt'), '{}'::jsonb),
    'refund', coalesce((select jsonb_object_agg(academic_year_id, n) from public.counters where kind = 'refund'), '{}'::jsonb)));
  foreach c in array p_collections loop
    v := case c
      when 'academicYears' then (select jsonb_agg(doc order by id) from public.academic_years)
      when 'programs' then (select jsonb_agg(doc order by id) from public.programs)
      when 'feeHeads' then (select jsonb_agg(doc order by id) from public.fee_heads)
      when 'feeStructures' then (select jsonb_agg(doc order by id) from public.fee_structures)
      when 'students' then (select jsonb_agg(s.doc || jsonb_build_object(
          'guardianIds', coalesce((select jsonb_agg(sg.guardian_id order by sg.ord, sg.guardian_id) from public.student_guardians sg where sg.student_id = s.id), '[]'),
          'healthNotes', (select h.notes from public.student_health h where h.student_id = s.id)) order by s.id) from public.students s)
      when 'guardians' then (select jsonb_agg(g.doc || jsonb_build_object(
          'studentIds', coalesce((select jsonb_agg(sg.student_id order by sg.student_id) from public.student_guardians sg where sg.guardian_id = g.id), '[]')) order by g.id) from public.guardians g)
      when 'staff' then (select jsonb_agg(st.doc || jsonb_build_object('phone', coalesce(c2.phone, ''), 'email', c2.email) order by st.id)
          from public.staff st left join public.staff_contacts c2 on c2.staff_id = st.id)
      when 'notices' then (select jsonb_agg(case when n.doc->'audience'->>'scope' = 'students'
          then jsonb_set(n.doc, '{audience,studentIds}', coalesce((select jsonb_agg(ns.student_id order by ns.student_id) from public.notice_students ns where ns.notice_id = n.id), '[]'))
          else n.doc end order by n.id) from public.notices n)
      when 'noticeReceipts' then (select jsonb_agg(r.doc || jsonb_build_object('studentIds', coalesce((select jsonb_agg(x.student_id order by x.student_id)
          from public.notice_receipt_students x where x.notice_id = r.notice_id and x.guardian_id = r.guardian_id), '[]')) order by r.id) from public.notice_receipts r)
      when 'threads' then (select jsonb_agg(doc order by id) from public.threads)
      when 'messages' then (select jsonb_agg(doc order by id) from public.messages)
      when 'calendarEvents' then (select jsonb_agg(doc order by id) from public.calendar_events)
      when 'routes' then (select jsonb_agg(doc order by id) from public.routes)
      when 'trips' then case when p_hints ? 'tripsAll' then (
        select jsonb_agg(t.doc || jsonb_build_object('positions', '[]'::jsonb, 'childEvents',
          coalesce((select jsonb_agg(e.doc order by e.seq) from public.trip_child_events e where e.trip_id = t.id), '[]'::jsonb)) order by t.id) from public.trips t)
      else (
        -- the trip named in the hint (or the route's active trips), with the last 20 kept fixes for downsampling/order checks
        select jsonb_agg(t.doc || coalesce((select jsonb_strip_nulls(ts.state) from public.trip_state ts where ts.trip_id = t.id), '{}'::jsonb)
                              || jsonb_build_object('childEvents', coalesce((select jsonb_agg(e.doc order by e.seq) from public.trip_child_events e where e.trip_id = t.id), '[]'::jsonb))
                              || jsonb_build_object('positions', coalesce((
            select jsonb_agg(jsonb_build_object('lat', p.lat, 'lng', p.lng, 'accuracy', p.accuracy,
                   'ts', to_char(p.ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) order by p.ts)
            from (select * from public.trip_positions tp where tp.trip_id = t.id order by tp.ts desc limit 20) p), '[]'::jsonb)) order by t.id)
        from public.trips t
        where t.id = p_hints->>'tripId'
           or (t.status = 'active' and t.route_id = coalesce(p_hints->>'routeId', (select route_id from public.trips where id = p_hints->>'tripId')))) end
      when 'invoices' then (select jsonb_agg(doc order by id) from public.invoices)
      when 'payments' then (select jsonb_agg(doc order by id) from public.payments)
      when 'refunds' then (select jsonb_agg(doc order by id) from public.refunds)
      when 'credits' then (select jsonb_agg(doc order by id) from public.credits)
      when 'attendance' then (select jsonb_agg(doc order by id) from public.attendance
          where p_hints ? 'attendanceAll' or (p_hints ? 'attendanceDate' and date = p_hints->>'attendanceDate')
             or (not p_hints ? 'attendanceDate' and date >= (today - 60)::text))
      when 'diaryEntries' then (select jsonb_agg(doc order by id) from public.diary_entries where p_hints ? 'diaryAll' or id = p_hints->>'diaryEntryId')
      when 'consents' then (select jsonb_agg(doc order by id) from public.consents)
      when 'invites' then (select jsonb_agg(doc order by id) from public.invites)
      when 'erasureRequests' then (select jsonb_agg(doc order by id) from public.erasure_requests)
      when 'appUsers' then (select jsonb_agg(jsonb_build_object('id', user_id, 'role', role, 'staffId', staff_id, 'guardianId', guardian_id, 'status', status, 'linkedAt', linked_at) order by user_id) from public.app_users)
      when 'importBatches' then (select jsonb_agg(doc order by id) from public.import_batches)
      when 'importRows' then (select jsonb_agg(doc order by id) from public.import_rows where p_hints ? 'importRowsAll' or batch_id = p_hints->>'importBatchId')
      when 'settlementLines' then (select jsonb_agg(doc order by id) from public.settlement_lines)
      -- read-only server collections (data export)
      when 'remindersSent' then (select jsonb_agg(jsonb_build_object('invoiceId', r.invoice_id, 'kind', r.kind, 'sentOn', r.sent_on, 'text', r.text, 'status', r.status) order by r.sent_on, r.invoice_id)
          from public.reminders_sent r join public.invoices i on i.id = r.invoice_id
          where eg is null or i.student_id in (select sg.student_id from public.student_guardians sg where sg.guardian_id = eg))
      when 'pushSubscriptions' then (select jsonb_agg(jsonb_build_object('userId', ps.user_id, 'endpoint', ps.endpoint, 'createdAt', ps.created_at) order by ps.id)
          from public.push_subscriptions ps where eg is null or ps.user_id in (select au.user_id from public.app_users au where au.guardian_id = eg))
      when 'gatewayOrders' then (select jsonb_agg(jsonb_build_object('id', o.id, 'studentId', o.student_id, 'guardianId', o.guardian_id, 'invoiceIds', o.invoice_ids,
          'amountPaise', o.amount_paise, 'status', o.status, 'mode', o.mode, 'paymentId', o.payment_id, 'createdAt', o.created_at) order by o.created_at)
          from public.gateway_orders o where eg is null or o.guardian_id = eg or o.student_id in (select sg.student_id from public.student_guardians sg where sg.guardian_id = eg))
      else null end;
    if v is null and c not in ('academicYears','programs','feeHeads','feeStructures','students','guardians','staff','notices','noticeReceipts',
        'threads','messages','calendarEvents','routes','trips','invoices','payments','refunds','credits','attendance','diaryEntries','consents',
        'invites','erasureRequests','appUsers','importBatches','importRows','settlementLines','remindersSent','pushSubscriptions','gatewayOrders') then
      raise exception 'load_slice: unknown collection %', c using errcode = '22023';
    end if;
    res := res || jsonb_build_object(c, coalesce(v, '[]'::jsonb));
  end loop;
  if p_hints ? 'auditRedeemFailedBy' then
    res := jsonb_set(res, '{auditLog}', coalesce((select jsonb_agg(doc) from public.audit_log
      where entity = 'invite' and doc->>'action' = 'redeemFailed' and doc->>'actorId' = p_hints->>'auditRedeemFailedBy'
        and ts >= to_char((now() - interval '1 hour') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')), '[]'::jsonb));
  end if;
  if p_hints ? 'callerUserId' then
    select * into link from public.app_users where user_id = (p_hints->>'callerUserId')::uuid;
    res := res || jsonb_build_object('callerLink', case when link.user_id is null then null
      else jsonb_build_object('role', link.role, 'staffId', link.staff_id, 'guardianId', link.guardian_id, 'status', link.status) end);
    res := res || jsonb_build_object('callerConsents', coalesce((select jsonb_agg(doc order by id) from public.consents where link.guardian_id is not null and guardian_id = link.guardian_id), '[]'::jsonb));
  end if;
  if p_hints ? 'requestId' then
    res := res || jsonb_build_object('priorRequest', (select jsonb_build_object('userId', r.user_id, 'name', r.name, 'result', r.result)
      from app.command_requests r where r.request_id = p_hints->>'requestId'));
  end if;
  return jsonb_build_object('db', res, 'revs', coalesce((select jsonb_object_agg(slice, rev) from app.revs), '{}'::jsonb));
end $$;

-- ---------------------------------------------------------------- persist (replaces 0001's)
-- p_changes as before, plus:
--   guards:{slice: expectedRev}  other slices whose revision the change must also match (and moves), finding 13
--   request:{id, userId, name, result}  stored once; a second commit with the same id fails (unique) → caller replays
-- Trips' childEvents, notices' audience.studentIds and receipts' studentIds are stored in their own RLS-scoped tables.
create or replace function public.persist(p_rev_key text, p_expected bigint, p_changes jsonb) returns bigint
language plpgsql volatile security invoker set search_path = public, app, pg_temp as $$
declare
  cur bigint;
  k text;
  keys text[];
  expected bigint;
  col text;
  arr jsonb;
  x jsonb;
  tbl text;
  id_expr text;
  v_kind text;
  v_ay text;
  v_counts jsonb;
  v_new int;
  v_old int;
  result_rev bigint;
  -- fixed order so referenced rows exist first (jsonb key order is not insertion order)
  write_order constant text[] := array['academicYears','programs','feeHeads','staff','routes','guardians','students','feeStructures',
    'appUsers','invites','consents','erasureRequests','notices','noticeReceipts','threads','messages','calendarEvents','trips',
    'invoices','payments','refunds','credits','attendance','diaryEntries','importBatches','importRows','settlementLines'];
  doc_tables constant jsonb := '{"academicYears":"academic_years","programs":"programs","feeHeads":"fee_heads","feeStructures":"fee_structures",
    "threads":"threads","messages":"messages","calendarEvents":"calendar_events",
    "routes":"routes","invoices":"invoices","payments":"payments","refunds":"refunds","credits":"credits","attendance":"attendance",
    "diaryEntries":"diary_entries","consents":"consents","invites":"invites","erasureRequests":"erasure_requests",
    "importBatches":"import_batches","importRows":"import_rows","settlementLines":"settlement_lines"}';
begin
  -- every revision this change is guarded by, locked in a fixed (sorted) order so two writers never deadlock
  keys := array(select distinct g from unnest(array[p_rev_key] || array(select jsonb_object_keys(coalesce(p_changes->'guards', '{}'::jsonb)))) g order by g);
  foreach k in array keys loop
    insert into app.revs (slice, rev) values (k, 0) on conflict (slice) do nothing;
  end loop;
  foreach k in array keys loop
    select rev into cur from app.revs where slice = k for update;
    expected := case when k = p_rev_key then p_expected else (p_changes->'guards'->>k)::bigint end;
    if cur <> expected then
      raise exception 'CONFLICT' using errcode = 'PT409', detail = format('slice %s is at rev %s, expected %s', k, cur, expected);
    end if;
  end loop;

  if p_changes ? 'request' then
    insert into app.command_requests (request_id, user_id, name, result)
      values (p_changes->'request'->>'id', (p_changes->'request'->>'userId')::uuid, p_changes->'request'->>'name', p_changes->'request'->'result');
  end if;

  if p_changes ? 'school' and jsonb_typeof(p_changes->'school') = 'object' then
    insert into public.school (id, doc) values ('school', p_changes->'school') on conflict (id) do update set doc = excluded.doc;
  end if;

  for col in select k2 from jsonb_object_keys(coalesce(p_changes->'upserts', '{}'::jsonb)) k2 loop
    if not col = any(write_order) then raise exception 'persist: collection % is not writable', col using errcode = '22023'; end if;
  end loop;
  foreach col in array write_order loop
    arr := p_changes->'upserts'->col;
    continue when arr is null or jsonb_array_length(arr) = 0;
    if col = 'students' then
      for x in select * from jsonb_array_elements(arr) loop
        insert into public.students (id, doc) values (x->>'id', x - 'guardianIds' - 'healthNotes') on conflict (id) do update set doc = excluded.doc;
        delete from public.student_guardians where student_id = x->>'id'
          and not (guardian_id = any(array(select jsonb_array_elements_text(coalesce(x->'guardianIds', '[]'::jsonb)))));
        insert into public.student_guardians (student_id, guardian_id, ord)
          select x->>'id', g.value, g.ordinality::int from jsonb_array_elements_text(coalesce(x->'guardianIds', '[]'::jsonb)) with ordinality g
          on conflict (student_id, guardian_id) do update set ord = excluded.ord;
        if nullif(x->>'healthNotes', '') is not null then
          insert into public.student_health (student_id, notes) values (x->>'id', x->>'healthNotes') on conflict (student_id) do update set notes = excluded.notes;
        else
          delete from public.student_health where student_id = x->>'id';
        end if;
      end loop;
    elsif col = 'guardians' then
      insert into public.guardians (id, doc) select e->>'id', e - 'studentIds' from jsonb_array_elements(arr) e
        on conflict (id) do update set doc = excluded.doc;
    elsif col = 'staff' then
      for x in select * from jsonb_array_elements(arr) loop
        insert into public.staff (id, doc) values (x->>'id', x - 'phone' - 'email') on conflict (id) do update set doc = excluded.doc;
        insert into public.staff_contacts (staff_id, phone, email) values (x->>'id', nullif(x->>'phone', ''), lower(nullif(x->>'email', '')))
          on conflict (staff_id) do update set phone = excluded.phone, email = coalesce(excluded.email, staff_contacts.email);
        delete from public.staff_programs where staff_id = x->>'id'
          and not (program_id = any(array(select jsonb_array_elements_text(coalesce(x->'programIds', '[]'::jsonb)))));
        insert into public.staff_programs (staff_id, program_id)
          select x->>'id', p from jsonb_array_elements_text(coalesce(x->'programIds', '[]'::jsonb)) p on conflict do nothing;
        -- a role change takes effect on the user's next request (role is read from app_users, never from the JWT)
        update public.app_users set role = x->>'role' where staff_id = x->>'id' and role <> x->>'role';
      end loop;
    elsif col = 'trips' then
      insert into public.trips as t (id, doc) select e->>'id', e - 'positions' - 'tracker' - 'lastFixTs' - 'childEvents' from jsonb_array_elements(arr) e
        on conflict (id) do update set doc = excluded.doc where t.doc is distinct from excluded.doc;
      insert into public.trip_state (trip_id, state)
        select e->>'id', jsonb_build_object('tracker', coalesce(e->'tracker', '{}'::jsonb), 'lastFixTs', e->'lastFixTs') from jsonb_array_elements(arr) e
        on conflict (trip_id) do update set state = excluded.state;
      -- child events are append-only per trip: (trip, position in the list)
      insert into public.trip_child_events as ce (trip_id, seq, doc)
        select e->>'id', ev.ord::int, ev.value from jsonb_array_elements(arr) e, jsonb_array_elements(coalesce(e->'childEvents', '[]'::jsonb)) with ordinality ev(value, ord)
        on conflict (trip_id, seq) do update set doc = excluded.doc where ce.doc is distinct from excluded.doc;
    elsif col = 'notices' then
      insert into public.notices (id, doc) select e->>'id', e #- '{audience,studentIds}' from jsonb_array_elements(arr) e
        on conflict (id) do update set doc = excluded.doc;
      for x in select * from jsonb_array_elements(arr) loop
        delete from public.notice_students where notice_id = x->>'id'
          and not (student_id = any(array(select jsonb_array_elements_text(coalesce(x->'audience'->'studentIds', '[]'::jsonb)))));
        insert into public.notice_students (notice_id, student_id)
          select x->>'id', s from jsonb_array_elements_text(coalesce(x->'audience'->'studentIds', '[]'::jsonb)) s on conflict do nothing;
      end loop;
    elsif col = 'noticeReceipts' then
      insert into public.notice_receipts (id, doc) select (e->>'noticeId') || '|' || (e->>'guardianId'), e - 'studentIds' from jsonb_array_elements(arr) e
        on conflict (id) do update set doc = excluded.doc;
      for x in select * from jsonb_array_elements(arr) loop
        delete from public.notice_receipt_students where notice_id = x->>'noticeId' and guardian_id = x->>'guardianId'
          and not (student_id = any(array(select jsonb_array_elements_text(coalesce(x->'studentIds', '[]'::jsonb)))));
        insert into public.notice_receipt_students (notice_id, guardian_id, student_id)
          select x->>'noticeId', x->>'guardianId', s from jsonb_array_elements_text(coalesce(x->'studentIds', '[]'::jsonb)) s on conflict do nothing;
      end loop;
    elsif col = 'appUsers' then
      insert into public.app_users (user_id, role, staff_id, guardian_id, status)
        select (e->>'id')::uuid, e->>'role', e->>'staffId', e->>'guardianId', e->>'status' from jsonb_array_elements(arr) e
        on conflict (user_id) do update set role = excluded.role, staff_id = excluded.staff_id, guardian_id = excluded.guardian_id, status = excluded.status;
    elsif doc_tables ? col then
      tbl := doc_tables->>col;
      id_expr := case col
        when 'attendance' then $e$(e->>'date') || '|' || (e->>'studentId')$e$
        else $e$e->>'id'$e$ end;
      execute format('insert into public.%I (id, doc) select %s, e from jsonb_array_elements($1) e on conflict (id) do update set doc = excluded.doc', tbl, id_expr)
        using arr;
    else
      raise exception 'persist: collection % is not writable', col using errcode = '22023';
    end if;
  end loop;

  for col, arr in select * from jsonb_each(coalesce(p_changes->'deletes', '{}'::jsonb)) loop
    -- ledger, audit and people rows are never deleted; only these may be
    if col = 'calendarEvents' then delete from public.calendar_events where id = any(array(select jsonb_array_elements_text(arr)));
    elsif col = 'importRows' then delete from public.import_rows where id = any(array(select jsonb_array_elements_text(arr)));
    else raise exception 'persist: rows of % cannot be deleted', col using errcode = '42501';
    end if;
  end loop;

  -- document counters only ever move forward (numbers are never reused)
  for v_kind, v_counts in select * from jsonb_each(coalesce(p_changes->'counters', '{}'::jsonb)) loop
    for v_ay, x in select * from jsonb_each(v_counts) loop
      v_new := (x #>> '{}')::int;
      select c.n into v_old from public.counters c where c.kind = v_kind and c.academic_year_id = v_ay;
      if v_old is not null and v_new < v_old then
        raise exception 'persist: % counter for % would go back from % to %', v_kind, v_ay, v_old, v_new using errcode = '23514';
      end if;
      insert into public.counters as c (kind, academic_year_id, n) values (v_kind, v_ay, v_new)
        on conflict (kind, academic_year_id) do update set n = excluded.n;
    end loop;
  end loop;

  insert into public.audit_log (id, doc) select e->>'id', e from jsonb_array_elements(coalesce(p_changes->'audit', '[]'::jsonb)) e;

  insert into public.trip_positions (trip_id, ts, lat, lng, accuracy)
    select e->>'tripId', (e->>'ts')::timestamptz, (e->>'lat')::float8, (e->>'lng')::float8, (e->>'accuracy')::float8
    from jsonb_array_elements(coalesce(p_changes->'positions', '[]'::jsonb)) e
    on conflict (trip_id, ts) do nothing;

  update app.revs set rev = rev + 1 where slice = any(keys);
  select rev into result_rev from app.revs where slice = p_rev_key;
  return result_rev;
end $$;

-- ---------------------------------------------------------------- #38 stale trips every 15 minutes (cron-daily, trips step only)
select cron.schedule(
  'cron-trips',
  '*/15 * * * *',
  $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'functions_url') || '/cron-daily',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Cron-Secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{"steps":["trips"]}'::jsonb,
    timeout_milliseconds := 60000
  )
  $job$
);

-- ---------------------------------------------------------------- grants for the new objects
revoke all on public.trip_child_events, public.notice_students, public.notice_receipt_students from anon, authenticated;
grant select on public.trip_child_events, public.notice_students, public.notice_receipt_students to authenticated;
grant all on public.trip_child_events, public.notice_students, public.notice_receipt_students to service_role;
revoke all on app.command_requests, app.order_attempts from public, anon, authenticated;
grant all on app.command_requests, app.order_attempts to service_role;
revoke all on function app.consent_version(), app.my_linked_student_ids(), app.my_consented_student_ids(text), app.my_bus_route_ids() from public, anon;
grant execute on function app.consent_version(), app.my_linked_student_ids(), app.my_consented_student_ids(text), app.my_bus_route_ids() to authenticated, service_role;
revoke all on function public.take_order_slot(uuid, int, interval), public.prune_request_logs(), public.claim_reminders(jsonb, interval),
  public.finish_reminders(jsonb) from public, anon, authenticated;
grant execute on function public.take_order_slot(uuid, int, interval), public.prune_request_logs(), public.claim_reminders(jsonb, interval),
  public.finish_reminders(jsonb) to service_role;
-- create or replace keeps the earlier grants of my_snapshot / load_slice / persist (and their revokes)

alter publication supabase_realtime add table public.trip_child_events;
