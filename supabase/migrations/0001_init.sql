-- Phase 2 schema: every entity is a JSONB `doc` (the Phase 1 shape) plus GENERATED key columns used by
-- RLS, indexes and uniqueness. Business rules stay in the shared JS domain (run by the `command` Edge
-- Function); SQL adds what Postgres is strictly better at: uniqueness, RLS, transactions, realtime.
--
-- Access model
--   * anon: nothing (no grants on any table or function).
--   * authenticated: SELECT only, filtered by RLS (policy matrix below); the one write is push_subscriptions (own rows).
--   * all writes: public.persist() — service role only, one transaction, optimistic revision check.
--   * role helpers in schema `app` are SECURITY INVOKER + STABLE; the ONLY security definer function is the
--     auth.users insert trigger (app.link_new_auth_user), with search_path pinned.
-- Forward-only: never edit this file after it is applied anywhere; add a new migration instead.

create schema if not exists app;
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------- revision guard + settings
create table app.revs (slice text primary key, rev bigint not null default 0 check (rev >= 0));
create table app.settings (key text primary key, value jsonb not null);

-- ---------------------------------------------------------------- reference data
create table public.school (id text primary key default 'school' check (id = 'school'), doc jsonb not null);
create table public.academic_years (id text primary key, doc jsonb not null);
create table public.programs (id text primary key, doc jsonb not null);
create table public.fee_heads (id text primary key, doc jsonb not null);
create table public.fee_structures (
  id text primary key, doc jsonb not null,
  academic_year_id text generated always as (doc->>'academicYearId') stored,
  program_id text generated always as (doc->>'programId') stored
);

-- ---------------------------------------------------------------- people
create table public.students (
  id text primary key, doc jsonb not null,
  program_id text generated always as (doc->>'programId') stored,
  route_id text generated always as (doc->>'routeId') stored,
  stop_id text generated always as (doc->>'stopId') stored,
  status text generated always as (doc->>'status') stored,
  admission_no text generated always as (doc->>'admissionNo') stored,
  check (not doc ? 'guardianIds' and not doc ? 'healthNotes')
);
create unique index students_admission_no on public.students (admission_no);
create index students_program on public.students (program_id);
create index students_route on public.students (route_id);
-- health notes live apart from the student doc so drivers and the accountant never receive them
create table public.student_health (student_id text primary key references public.students (id) on delete cascade, notes text not null);
create table public.guardians (
  id text primary key, doc jsonb not null,
  email text generated always as (lower(nullif(doc->>'email', ''))) stored,
  check (not doc ? 'studentIds')
);
-- the RLS truth for "whose child is this"; guardianIds/studentIds arrays are rebuilt from it when loading
create table public.student_guardians (
  student_id text not null references public.students (id) on delete cascade,
  guardian_id text not null references public.guardians (id) on delete cascade,
  ord int not null default 0,
  primary key (student_id, guardian_id)
);
create index student_guardians_guardian on public.student_guardians (guardian_id);
create table public.staff (
  id text primary key, doc jsonb not null,
  role text generated always as (doc->>'role') stored,
  check (not doc ? 'phone' and not doc ? 'email')
);
-- staff phone/email: admin (and the person themself) only; email is how a new auth user is linked to staff
create table public.staff_contacts (
  staff_id text primary key references public.staff (id) on delete cascade,
  phone text, email text
);
create unique index staff_contacts_email on public.staff_contacts (lower(email)) where email is not null;
create table public.staff_programs (
  staff_id text not null references public.staff (id) on delete cascade,
  program_id text not null references public.programs (id) on delete cascade,
  primary key (staff_id, program_id)
);

create table public.app_users (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role text not null check (role in ('admin', 'teacher', 'accountant', 'driver', 'parent')),
  staff_id text references public.staff (id),
  guardian_id text references public.guardians (id),
  status text not null default 'active' check (status in ('pending', 'active', 'revoked', 'withdrawn')),
  linked_at timestamptz not null default now(),
  check ((role = 'parent') = (guardian_id is not null) and (role <> 'parent') = (staff_id is not null))
);
create table public.invites (
  id text primary key, doc jsonb not null,
  code_hash text generated always as (doc->>'codeHash') stored,
  guardian_id text generated always as (doc->>'guardianId') stored
);
create unique index invites_code_hash on public.invites (code_hash);
create table public.consents (
  id text primary key, doc jsonb not null,
  guardian_id text generated always as (doc->>'guardianId') stored,
  student_id text generated always as (doc->>'studentId') stored,
  purpose text generated always as (doc->>'purpose') stored,
  version text generated always as (doc->>'version') stored,
  withdrawn_at text generated always as (doc->>'withdrawnAt') stored,
  -- SHA-256 of the privacy-notice text the parent saw (the server never sees the text itself)
  text_hash text generated always as (doc->>'textHash') stored check (text_hash is null or text_hash ~ '^[0-9a-f]{64}$')
);
create index consents_guardian on public.consents (guardian_id, purpose);
create table public.erasure_requests (
  id text primary key, doc jsonb not null,
  guardian_id text generated always as (doc->>'guardianId') stored
);

-- ---------------------------------------------------------------- messaging
create table public.notices (id text primary key, doc jsonb not null);
create table public.notice_receipts (
  id text primary key, doc jsonb not null,
  notice_id text generated always as (doc->>'noticeId') stored,
  guardian_id text generated always as (doc->>'guardianId') stored
);
create unique index notice_receipts_key on public.notice_receipts (notice_id, guardian_id);
create table public.threads (
  id text primary key, doc jsonb not null,
  guardian_id text generated always as (doc->>'guardianId') stored,
  student_id text generated always as (doc->>'studentId') stored,
  program_id text generated always as (doc->>'programId') stored
);
create table public.messages (
  id text primary key, doc jsonb not null,
  thread_id text generated always as (doc->>'threadId') stored
);
create index messages_thread on public.messages (thread_id);
create table public.calendar_events (id text primary key, doc jsonb not null);

-- ---------------------------------------------------------------- transport
create table public.routes (
  id text primary key, doc jsonb not null,
  driver_id text generated always as (doc->>'driverId') stored,
  attendant_id text generated always as (doc->>'attendantId') stored
);
create table public.trips (
  id text primary key, doc jsonb not null,
  route_id text generated always as (doc->>'routeId') stored,
  date text generated always as (doc->>'date') stored,
  status text generated always as (doc->>'status') stored,
  check (not doc ? 'positions')
);
create index trips_route_date on public.trips (route_id, date);
-- hysteresis state of the event derivation; kept out of trips.doc so a fix that creates no event does not
-- publish a trips UPDATE (parents' snapshot refetches are nudged by trips changes)
create table public.trip_state (trip_id text primary key references public.trips (id) on delete cascade, state jsonb not null);
-- the bus's positions (not a child's); pruned after 30 days by cron-daily
create table public.trip_positions (
  id bigint generated always as identity primary key,
  trip_id text not null references public.trips (id) on delete cascade,
  ts timestamptz not null,
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  accuracy double precision not null check (accuracy >= 0),
  unique (trip_id, ts)
);

-- ---------------------------------------------------------------- fees ledger
create table public.invoices (
  id text primary key, doc jsonb not null,
  student_id text generated always as (doc->>'studentId') stored,
  academic_year_id text generated always as (doc->>'academicYearId') stored,
  status text generated always as (doc->>'status') stored,
  number text generated always as (doc->>'number') stored not null,
  due_date text generated always as (doc->>'dueDate') stored
);
create unique index invoices_number on public.invoices (number);
create index invoices_student on public.invoices (student_id);
create table public.payments (
  id text primary key, doc jsonb not null,
  student_id text generated always as (doc->>'studentId') stored,
  receipt_number text generated always as (doc->>'receiptNumber') stored not null,
  status text generated always as (doc->>'status') stored,
  gateway_payment_id text generated always as (doc->>'gatewayPaymentId') stored
);
create unique index payments_receipt_number on public.payments (receipt_number);
create unique index payments_gateway_payment_id on public.payments (gateway_payment_id); -- NULLs are distinct
create index payments_student on public.payments (student_id);
create table public.refunds (
  id text primary key, doc jsonb not null,
  payment_id text generated always as (doc->>'paymentId') stored,
  voucher_number text generated always as (doc->>'voucherNumber') stored not null,
  gateway_refund_id text generated always as (doc->>'gatewayRefundId') stored,
  gateway_refund_part int generated always as ((doc->>'gatewayRefundPart')::int) stored
);
create unique index refunds_voucher_number on public.refunds (voucher_number);
-- one gateway refund may be split across allocations: unique per (refund id, part)
create unique index refunds_gateway_refund on public.refunds (gateway_refund_id, gateway_refund_part);
create table public.credits (
  id text primary key, doc jsonb not null,
  student_id text generated always as (doc->>'studentId') stored
);
create table public.counters (
  kind text not null check (kind in ('invoice', 'receipt', 'refund')),
  academic_year_id text not null,
  n int not null check (n >= 0),
  primary key (kind, academic_year_id)
);

-- gateway (plain columns: written by the payment functions with the service role)
create table public.gateway_orders (
  id text primary key, -- Razorpay order id
  student_id text not null references public.students (id),
  guardian_id text references public.guardians (id),
  invoice_ids text[] not null,
  amount_paise bigint not null check (amount_paise > 0),
  balances_snapshot jsonb not null,
  status text not null default 'created' check (status in ('created', 'paid', 'failed', 'amount_mismatch')),
  mode text not null check (mode in ('test', 'live')),
  payment_id text, -- ledger payment id once recorded
  last_error text,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index gateway_orders_guardian on public.gateway_orders (guardian_id, created_at);
create table public.gateway_events (
  event_id text primary key, -- x-razorpay-event-id: replays are no-ops
  event text not null,
  payload jsonb not null,
  result text not null default 'received' check (result in ('received', 'ok', 'ignored', 'pending', 'error')),
  error text,
  attempts int not null default 0,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);
create table public.settlement_lines (
  id text primary key, doc jsonb not null,
  settlement_id text generated always as (doc->>'settlementId') stored,
  entity_id text generated always as (doc->>'entityId') stored
);
create unique index settlement_lines_key on public.settlement_lines (settlement_id, entity_id);
create view public.settlements with (security_invoker = true) as
  select settlement_id as id, max(doc->>'utr') as utr, max(doc->>'settledOn') as settled_on, count(*) as line_count,
         sum((doc->>'grossPaise')::bigint) as gross_paise, sum((doc->>'netPaise')::bigint) as net_paise
  from public.settlement_lines group by settlement_id;
create table public.reminders_sent (
  invoice_id text not null references public.invoices (id),
  kind text not null check (kind in ('T-3', 'due', '+7', '+14')),
  sent_on date not null,
  text text not null,
  push_sent int not null default 0,
  primary key (invoice_id, kind)
);
create table public.push_subscriptions (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  failures int not null default 0,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- classroom
create table public.attendance (
  id text primary key, doc jsonb not null,
  date text generated always as (doc->>'date') stored,
  student_id text generated always as (doc->>'studentId') stored
);
create unique index attendance_key on public.attendance (date, student_id);
create table public.diary_entries (
  id text primary key, doc jsonb not null,
  student_id text generated always as (doc->>'studentId') stored,
  date text generated always as (doc->>'date') stored
);
create index diary_student_date on public.diary_entries (student_id, date);

-- ---------------------------------------------------------------- audit + import
create table public.audit_log (
  id text primary key, doc jsonb not null,
  ts text generated always as (doc->>'ts') stored,
  entity text generated always as (doc->>'entity') stored
);
create index audit_log_ts on public.audit_log (ts);
create table public.import_batches (id text primary key, doc jsonb not null);
create table public.import_rows (
  id text primary key, doc jsonb not null,
  batch_id text generated always as (doc->>'batchId') stored
);
create index import_rows_batch on public.import_rows (batch_id);

-- audit_log is append-only for everyone, including the service role and the table owner
create function app.audit_log_immutable() returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  raise exception 'audit_log is append-only' using errcode = '42501';
end $$;
create trigger audit_log_no_update before update or delete on public.audit_log for each row execute function app.audit_log_immutable();
create trigger audit_log_no_truncate before truncate on public.audit_log for each statement execute function app.audit_log_immutable();

-- ---------------------------------------------------------------- role helpers (SECURITY INVOKER, STABLE)
-- Each reads only rows its own policies allow; none of them reads a table whose policy calls it back.
create function app.my_link() returns public.app_users language sql stable security invoker set search_path = public, pg_temp as $$
  select u.* from public.app_users u where u.user_id = auth.uid() and u.status = 'active'
$$;
create function app.my_role() returns text language sql stable security invoker set search_path = public, pg_temp as $$
  select (app.my_link()).role
$$;
create function app.my_staff_id() returns text language sql stable security invoker set search_path = public, pg_temp as $$
  select (app.my_link()).staff_id
$$;
create function app.my_guardian_id() returns text language sql stable security invoker set search_path = public, pg_temp as $$
  select (app.my_link()).guardian_id
$$;
create function app.me() returns jsonb language sql stable security invoker set search_path = public, pg_temp as $$
  select to_jsonb(l) from app.my_link() l where l.user_id is not null
$$;
-- parent: own children (any status). Empty for every other role.
create function app.my_student_ids() returns text[] language sql stable security invoker set search_path = public, pg_temp as $$
  select coalesce(array_agg(sg.student_id), '{}') from public.student_guardians sg
  where app.my_role() = 'parent' and sg.guardian_id = app.my_guardian_id()
$$;
-- teacher: programs taught. Empty for every other role.
create function app.my_program_ids() returns text[] language sql stable security invoker set search_path = public, pg_temp as $$
  select coalesce(array_agg(sp.program_id), '{}') from public.staff_programs sp
  where app.my_role() = 'teacher' and sp.staff_id = app.my_staff_id()
$$;
-- driver: routes driven/attended; parent: routes of own children. Empty otherwise.
create function app.my_route_ids() returns text[] language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare r text := app.my_role();
begin
  if r = 'driver' then
    return coalesce((select array_agg(id) from public.routes where driver_id = app.my_staff_id() or attendant_id = app.my_staff_id()), '{}');
  elsif r = 'parent' then
    return coalesce((select array_agg(distinct route_id) from public.students where id = any(app.my_student_ids()) and route_id is not null), '{}');
  end if;
  return '{}';
end $$;
-- live consent (evaluated at query time, so a withdrawal cuts access immediately)
create function app.has_consent(p_purpose text) returns boolean language sql stable security invoker set search_path = public, pg_temp as $$
  select exists (select 1 from public.consents c where c.guardian_id = app.my_guardian_id() and c.purpose = p_purpose and c.withdrawn_at is null)
$$;
create function app.ist_today() returns date language sql stable set search_path = pg_catalog as $$
  select (now() at time zone 'Asia/Kolkata')::date
$$;

-- ---------------------------------------------------------------- RLS: SELECT-only policy matrix
do $$
declare t text;
begin
  foreach t in array array['school','academic_years','programs','fee_heads','fee_structures','students','student_health','guardians',
    'student_guardians','staff','staff_contacts','staff_programs','app_users','invites','consents','erasure_requests','notices',
    'notice_receipts','threads','messages','calendar_events','routes','trips','trip_state','trip_positions','invoices','payments','refunds','credits',
    'counters','gateway_orders','gateway_events','settlement_lines','reminders_sent','push_subscriptions','attendance','diary_entries',
    'audit_log','import_batches','import_rows']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop;
end $$;

-- everyone with an active link: reference data and the staff directory (no contacts in staff.doc)
create policy read_active on public.school for select to authenticated using (app.my_role() is not null);
create policy read_active on public.academic_years for select to authenticated using (app.my_role() is not null);
create policy read_active on public.programs for select to authenticated using (app.my_role() is not null);
create policy read_active on public.fee_heads for select to authenticated using (app.my_role() is not null);
create policy read_active on public.calendar_events for select to authenticated using (app.my_role() is not null);
create policy read_active on public.staff for select to authenticated using (app.my_role() is not null);

create policy read_fin on public.fee_structures for select to authenticated using (app.my_role() in ('admin', 'accountant'));
create policy read_fin on public.counters for select to authenticated using (app.my_role() in ('admin', 'accountant'));
create policy read_fin on public.gateway_events for select to authenticated using (app.my_role() in ('admin', 'accountant'));
create policy read_fin on public.settlement_lines for select to authenticated using (app.my_role() in ('admin', 'accountant'));
create policy read_fin on public.audit_log for select to authenticated using (app.my_role() in ('admin', 'accountant'));
create policy read_fin on public.import_batches for select to authenticated using (app.my_role() in ('admin', 'accountant'));
create policy read_fin on public.import_rows for select to authenticated using (app.my_role() in ('admin', 'accountant'));
create policy read_admin on public.erasure_requests for select to authenticated using (app.my_role() = 'admin');

create policy read_scoped on public.students for select to authenticated using (
  case app.my_role()
    when 'admin' then true when 'accountant' then true
    when 'teacher' then program_id = any(app.my_program_ids())
    when 'driver' then route_id = any(app.my_route_ids())
    when 'parent' then id = any(app.my_student_ids())
    else false end);
create policy read_scoped on public.student_health for select to authenticated using (
  case app.my_role()
    when 'admin' then true
    when 'teacher' then exists (select 1 from public.students s where s.id = student_id and s.program_id = any(app.my_program_ids()))
    when 'parent' then student_id = any(app.my_student_ids())
    else false end);
create policy read_scoped on public.student_guardians for select to authenticated using (
  case app.my_role()
    when 'admin' then true when 'accountant' then true
    when 'teacher' then exists (select 1 from public.students s where s.id = student_id and s.program_id = any(app.my_program_ids()))
    when 'parent' then guardian_id = app.my_guardian_id()
    else false end);
create policy read_scoped on public.guardians for select to authenticated using (
  case app.my_role()
    when 'admin' then true when 'accountant' then true
    when 'teacher' then exists (select 1 from public.student_guardians sg join public.students s on s.id = sg.student_id
                                where sg.guardian_id = guardians.id and s.program_id = any(app.my_program_ids()))
    when 'parent' then id = app.my_guardian_id()
    else false end);
create policy read_scoped on public.staff_contacts for select to authenticated using (app.my_role() = 'admin' or staff_id = app.my_staff_id());
create policy read_scoped on public.staff_programs for select to authenticated using (app.my_role() in ('admin', 'accountant') or staff_id = app.my_staff_id());
create policy read_own on public.app_users for select to authenticated using (user_id = auth.uid());
create policy read_scoped on public.consents for select to authenticated using (app.my_role() = 'admin' or guardian_id = app.my_guardian_id());

create policy read_scoped on public.notices for select to authenticated using (
  case app.my_role()
    when 'admin' then true when 'accountant' then true
    when 'teacher' then doc->'audience'->>'scope' = 'school'
      or (doc->'audience'->>'scope' = 'program' and (doc->'audience'->'programIds') ?| app.my_program_ids())
      or (doc->'audience'->>'scope' = 'students' and exists (select 1 from jsonb_array_elements_text(doc->'audience'->'studentIds') x(sid)
            join public.students s on s.id = x.sid where s.program_id = any(app.my_program_ids())))
    when 'parent' then exists (select 1 from public.notice_receipts r where r.notice_id = notices.id and r.guardian_id = app.my_guardian_id())
    else false end);
create policy read_scoped on public.notice_receipts for select to authenticated using (
  case app.my_role()
    when 'admin' then true when 'accountant' then true
    when 'teacher' then exists (select 1 from jsonb_array_elements_text(doc->'studentIds') x(sid) join public.students s on s.id = x.sid
                                where s.program_id = any(app.my_program_ids()))
    when 'parent' then guardian_id = app.my_guardian_id()
    else false end);
create policy read_scoped on public.threads for select to authenticated using (
  case app.my_role()
    when 'admin' then true
    when 'teacher' then program_id = any(app.my_program_ids())
    when 'parent' then guardian_id = app.my_guardian_id()
    else false end);
create policy read_scoped on public.messages for select to authenticated using (exists (select 1 from public.threads t where t.id = thread_id));

create policy read_scoped on public.routes for select to authenticated using (
  case app.my_role()
    when 'admin' then true when 'accountant' then true when 'teacher' then true
    when 'driver' then driver_id = app.my_staff_id() or attendant_id = app.my_staff_id() -- not my_route_ids(): it reads routes
    when 'parent' then id = any(app.my_route_ids())
    else false end);
create policy read_scoped on public.trips for select to authenticated using (
  case app.my_role()
    when 'admin' then true when 'accountant' then true
    when 'driver' then route_id = any(app.my_route_ids())
    when 'parent' then route_id = any(app.my_route_ids()) and app.has_consent('bus_live')
    else false end);
create policy read_scoped on public.trip_positions for select to authenticated using (exists (select 1 from public.trips t where t.id = trip_id));

create policy read_scoped on public.invoices for select to authenticated using (app.my_role() in ('admin', 'accountant') or student_id = any(app.my_student_ids()));
create policy read_scoped on public.payments for select to authenticated using (app.my_role() in ('admin', 'accountant') or student_id = any(app.my_student_ids()));
create policy read_scoped on public.credits for select to authenticated using (app.my_role() in ('admin', 'accountant') or student_id = any(app.my_student_ids()));
create policy read_scoped on public.refunds for select to authenticated using (app.my_role() in ('admin', 'accountant')
  or exists (select 1 from public.payments p where p.id = payment_id and p.student_id = any(app.my_student_ids())));
create policy read_scoped on public.gateway_orders for select to authenticated using (app.my_role() in ('admin', 'accountant')
  or (app.my_role() = 'parent' and student_id = any(app.my_student_ids())));
create policy read_scoped on public.reminders_sent for select to authenticated using (exists (select 1 from public.invoices i where i.id = invoice_id));

create policy read_scoped on public.attendance for select to authenticated using (
  case app.my_role()
    when 'admin' then true
    when 'teacher' then exists (select 1 from public.students s where s.id = student_id and s.program_id = any(app.my_program_ids()))
    when 'parent' then student_id = any(app.my_student_ids())
    else false end);
create policy read_scoped on public.diary_entries for select to authenticated using (
  case app.my_role()
    when 'admin' then true
    when 'teacher' then exists (select 1 from public.students s where s.id = student_id and s.program_id = any(app.my_program_ids()))
    when 'parent' then student_id = any(app.my_student_ids())
    else false end);

-- the only client write: a signed-in user's own push subscriptions
create policy own_rows_select on public.push_subscriptions for select to authenticated using (user_id = auth.uid());
create policy own_rows_insert on public.push_subscriptions for insert to authenticated with check (user_id = auth.uid() and app.my_role() is not null);
create policy own_rows_delete on public.push_subscriptions for delete to authenticated using (user_id = auth.uid());

-- invites, app.revs, app.settings: no policies → nothing for authenticated (the command function handles them)

-- ---------------------------------------------------------------- snapshot: the Phase 1 Db shape, RLS-scoped
-- SECURITY INVOKER: every sub-select runs under the caller's RLS, so it cannot return more than RLS allows.
create function public.my_snapshot() returns jsonb language plpgsql stable security invoker set search_path = public, app, pg_temp as $$
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
    'notices', coalesce((select jsonb_agg(doc order by id) from public.notices), '[]'),
    'noticeReceipts', coalesce((select jsonb_agg(doc order by id) from public.notice_receipts), '[]'),
    'threads', coalesce((select jsonb_agg(doc order by id) from public.threads), '[]'),
    'messages', coalesce((select jsonb_agg(doc order by id) from public.messages), '[]'),
    'calendarEvents', coalesce((select jsonb_agg(doc order by id) from public.calendar_events), '[]'),
    'routes', coalesce((select jsonb_agg(doc order by id) from public.routes), '[]'),
    -- trips of the last 7 days, events only: positions come from trip_positions (realtime + tail query)
    'trips', coalesce((select jsonb_agg(doc || jsonb_build_object('positions', '[]'::jsonb) order by id) from public.trips where date >= (today - 7)::text), '[]'),
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

-- ---------------------------------------------------------------- server: load a slice (service role only)
-- STABLE: every query inside sees the calling statement's snapshot, so the data and the revs are consistent.
create function public.load_slice(p_collections text[], p_hints jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security invoker set search_path = public, app, pg_temp as $$
declare
  c text;
  res jsonb := jsonb_build_object('schemaVersion', 1, 'rev', 0, 'auditLog', '[]'::jsonb);
  v jsonb;
  route text;
  today date := app.ist_today();
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
      when 'notices' then (select jsonb_agg(doc order by id) from public.notices)
      when 'noticeReceipts' then (select jsonb_agg(doc order by id) from public.notice_receipts)
      when 'threads' then (select jsonb_agg(doc order by id) from public.threads)
      when 'messages' then (select jsonb_agg(doc order by id) from public.messages)
      when 'calendarEvents' then (select jsonb_agg(doc order by id) from public.calendar_events)
      when 'routes' then (select jsonb_agg(doc order by id) from public.routes)
      when 'trips' then (
        -- the trip named in the hint (or the route's active trips), with the last 20 kept fixes for downsampling/order checks
        select jsonb_agg(t.doc || coalesce((select jsonb_strip_nulls(ts.state) from public.trip_state ts where ts.trip_id = t.id), '{}'::jsonb)
                              || jsonb_build_object('positions', coalesce((
            select jsonb_agg(jsonb_build_object('lat', p.lat, 'lng', p.lng, 'accuracy', p.accuracy,
                   'ts', to_char(p.ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) order by p.ts)
            from (select * from public.trip_positions tp where tp.trip_id = t.id order by tp.ts desc limit 20) p), '[]'::jsonb)) order by t.id)
        from public.trips t
        where t.id = p_hints->>'tripId'
           or (t.status = 'active' and t.route_id = coalesce(p_hints->>'routeId', (select route_id from public.trips where id = p_hints->>'tripId'))))
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
      when 'importRows' then (select jsonb_agg(doc order by id) from public.import_rows where batch_id = p_hints->>'importBatchId')
      when 'settlementLines' then (select jsonb_agg(doc order by id) from public.settlement_lines)
      else null end;
    if v is null and c not in ('academicYears','programs','feeHeads','feeStructures','students','guardians','staff','notices','noticeReceipts',
        'threads','messages','calendarEvents','routes','trips','invoices','payments','refunds','credits','attendance','diaryEntries','consents',
        'invites','erasureRequests','appUsers','importBatches','importRows','settlementLines') then
      raise exception 'load_slice: unknown collection %', c using errcode = '22023';
    end if;
    res := res || jsonb_build_object(c, coalesce(v, '[]'::jsonb));
  end loop;
  if p_hints ? 'auditRedeemFailedBy' then
    res := jsonb_set(res, '{auditLog}', coalesce((select jsonb_agg(doc) from public.audit_log
      where entity = 'invite' and doc->>'action' = 'redeemFailed' and doc->>'actorId' = p_hints->>'auditRedeemFailedBy'
        and ts >= to_char((now() - interval '1 hour') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')), '[]'::jsonb));
  end if;
  return jsonb_build_object('db', res, 'revs', coalesce((select jsonb_object_agg(slice, rev) from app.revs), '{}'::jsonb));
end $$;

-- ---------------------------------------------------------------- server: persist one command's changes (service role only)
-- p_changes = {upserts:{collection:[doc]}, deletes:{collection:[id]}, audit:[row], counters:{kind:{ay:n}}, school:doc|null,
--              positions:[{tripId, ts, lat, lng, accuracy}]}
-- Raises SQLSTATE PT409 'CONFLICT' (PostgREST → HTTP 409) when the slice moved since it was loaded: the caller re-runs.
create function public.persist(p_rev_key text, p_expected bigint, p_changes jsonb) returns bigint
language plpgsql volatile security invoker set search_path = public, app, pg_temp as $$
declare
  cur bigint;
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
  -- fixed order so referenced rows exist first (jsonb key order is not insertion order)
  write_order constant text[] := array['academicYears','programs','feeHeads','staff','routes','guardians','students','feeStructures',
    'appUsers','invites','consents','erasureRequests','notices','noticeReceipts','threads','messages','calendarEvents','trips',
    'invoices','payments','refunds','credits','attendance','diaryEntries','importBatches','importRows','settlementLines'];
  doc_tables constant jsonb := '{"academicYears":"academic_years","programs":"programs","feeHeads":"fee_heads","feeStructures":"fee_structures",
    "notices":"notices","noticeReceipts":"notice_receipts","threads":"threads","messages":"messages","calendarEvents":"calendar_events",
    "routes":"routes","invoices":"invoices","payments":"payments","refunds":"refunds","credits":"credits","attendance":"attendance",
    "diaryEntries":"diary_entries","consents":"consents","invites":"invites","erasureRequests":"erasure_requests",
    "importBatches":"import_batches","importRows":"import_rows","settlementLines":"settlement_lines"}';
begin
  insert into app.revs (slice, rev) values (p_rev_key, 0) on conflict (slice) do nothing;
  select rev into cur from app.revs where slice = p_rev_key for update;
  if cur <> p_expected then
    raise exception 'CONFLICT' using errcode = 'PT409', detail = format('slice %s is at rev %s, expected %s', p_rev_key, cur, p_expected);
  end if;

  if p_changes ? 'school' and jsonb_typeof(p_changes->'school') = 'object' then
    insert into public.school (id, doc) values ('school', p_changes->'school') on conflict (id) do update set doc = excluded.doc;
  end if;

  for col in select k from jsonb_object_keys(coalesce(p_changes->'upserts', '{}'::jsonb)) k loop
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
      insert into public.trips as t (id, doc) select e->>'id', e - 'positions' - 'tracker' - 'lastFixTs' from jsonb_array_elements(arr) e
        on conflict (id) do update set doc = excluded.doc where t.doc is distinct from excluded.doc;
      insert into public.trip_state (trip_id, state)
        select e->>'id', jsonb_build_object('tracker', coalesce(e->'tracker', '{}'::jsonb), 'lastFixTs', e->'lastFixTs') from jsonb_array_elements(arr) e
        on conflict (trip_id) do update set state = excluded.state;
    elsif col = 'appUsers' then
      insert into public.app_users (user_id, role, staff_id, guardian_id, status)
        select (e->>'id')::uuid, e->>'role', e->>'staffId', e->>'guardianId', e->>'status' from jsonb_array_elements(arr) e
        on conflict (user_id) do update set role = excluded.role, staff_id = excluded.staff_id, guardian_id = excluded.guardian_id, status = excluded.status;
    elsif doc_tables ? col then
      tbl := doc_tables->>col;
      id_expr := case col
        when 'noticeReceipts' then $e$(e->>'noticeId') || '|' || (e->>'guardianId')$e$
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

  update app.revs set rev = rev + 1 where slice = p_rev_key returning rev into cur;
  return cur;
end $$;

-- ---------------------------------------------------------------- auth: link a new sign-in to staff by exact email
-- The ONLY security definer function. A new auth user whose email matches a staff contact gets that staff
-- member's role; anyone else stays unlinked (RLS returns nothing) until they redeem a guardian invite.
create function app.link_new_auth_user() returns trigger language plpgsql security definer set search_path = '' as $$
declare s record;
begin
  select st.id, st.role into s from public.staff_contacts c join public.staff st on st.id = c.staff_id
   where c.email is not null and lower(c.email) = lower(new.email);
  if found then
    insert into public.app_users (user_id, role, staff_id, status) values (new.id, s.role, s.id, 'active') on conflict (user_id) do nothing;
  end if;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function app.link_new_auth_user();

-- ---------------------------------------------------------------- grants
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
revoke all on schema app from public, anon;
revoke all on all tables in schema app from public, anon, authenticated;
revoke all on all functions in schema app from public, anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on functions from public, anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

grant usage on schema app to authenticated, service_role;
grant execute on function app.my_link(), app.my_role(), app.my_staff_id(), app.my_guardian_id(), app.me(), app.my_student_ids(),
  app.my_program_ids(), app.my_route_ids(), app.has_consent(text), app.ist_today() to authenticated, service_role;
grant select on app.revs to authenticated;
grant all on app.revs, app.settings to service_role;

grant select on public.school, public.academic_years, public.programs, public.fee_heads, public.fee_structures, public.students,
  public.student_health, public.guardians, public.student_guardians, public.staff, public.staff_contacts, public.staff_programs,
  public.app_users, public.consents, public.erasure_requests, public.notices, public.notice_receipts, public.threads, public.messages,
  public.calendar_events, public.routes, public.trips, public.trip_positions, public.invoices, public.payments, public.refunds,
  public.credits, public.counters, public.gateway_orders, public.gateway_events, public.settlement_lines, public.settlements,
  public.reminders_sent, public.attendance, public.diary_entries, public.audit_log, public.import_batches, public.import_rows
  to authenticated;
grant select, insert, delete on public.push_subscriptions to authenticated;
grant execute on function public.my_snapshot() to authenticated;

grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on function public.my_snapshot(), public.load_slice(text[], jsonb), public.persist(text, bigint, jsonb) to service_role;
revoke update, delete, truncate on public.audit_log from service_role, authenticated;

-- ---------------------------------------------------------------- realtime: postgres_changes honours RLS per subscriber
alter publication supabase_realtime add table public.trip_positions, public.trips, public.messages, public.notices, public.invoices, public.payments;
