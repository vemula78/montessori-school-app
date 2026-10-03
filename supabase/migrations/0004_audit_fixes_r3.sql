-- Fix round 3 (re-audit of 0003). Forward-only. The 0003 versions of persist / load_slice / my_snapshot move to
-- schema app (not exposed by the API) and the public functions wrap them:
--   N2  before app_account consent a parent sees only id, name, program and status of a linked child
--       (student_display); the full student document waits for consent for that child
--   N3  persist re-checks the caller's app_users link (active, same role/staff/guardian) inside its transaction,
--       after the revision locks, holding the row FOR SHARE: a revoke or role change that commits first refuses
--       the write; one that comes later waits for it
--   N8  a request id is stored with a digest of its arguments
--   N10 reminder claims carry a claim token; finish_reminders updates only the matching claim
--   #9  load_slice can return a guardian's stored gateway events (data export)

-- ---------------------------------------------------------------- N2 pre-consent child display
create table public.student_display (
  student_id text primary key references public.students (id) on delete cascade,
  first_name text not null,
  last_name text not null default '',
  program_id text,
  status text
);
insert into public.student_display (student_id, first_name, last_name, program_id, status)
  select id, coalesce(doc->>'firstName', ''), coalesce(doc->>'lastName', ''), doc->>'programId', doc->>'status' from public.students;
alter table public.student_display enable row level security;
alter table public.student_display force row level security;
create policy read_scoped on public.student_display for select to authenticated using (
  case app.my_role()
    when 'admin' then true
    when 'parent' then student_id = any(app.my_linked_student_ids())
    else false end);
drop policy read_scoped on public.students;
create policy read_scoped on public.students for select to authenticated using (
  case app.my_role()
    when 'admin' then true when 'accountant' then true
    when 'teacher' then program_id = any(app.my_program_ids())
    when 'driver' then route_id = any(app.my_route_ids())
    when 'parent' then id = any(app.my_student_ids())
    else false end);

alter function public.my_snapshot() set schema app;
alter function app.my_snapshot() rename to my_snapshot_0003;
-- the 0003 snapshot (RLS-scoped) plus, for a parent, the linked children still waiting for consent as display-only
-- entries {id, firstName, lastName, programId, status, consentPending:true} so the consent screen can name them
create function public.my_snapshot() returns jsonb language plpgsql stable security invoker set search_path = public, app, pg_temp as $$
declare
  r jsonb := app.my_snapshot_0003();
  pending jsonb;
begin
  if r->>'status' <> 'active' then return r; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', d.student_id, 'firstName', d.first_name, 'lastName', d.last_name, 'programId', d.program_id,
      'status', d.status, 'routeId', null, 'stopId', null, 'healthNotes', null, 'consentPending', true,
      'guardianIds', coalesce((select jsonb_agg(sg.guardian_id order by sg.ord, sg.guardian_id) from public.student_guardians sg where sg.student_id = d.student_id), '[]'))
      order by d.student_id), '[]')
    into pending from public.student_display d where not exists (select 1 from public.students s where s.id = d.student_id);
  if jsonb_array_length(pending) = 0 then return r; end if;
  r := jsonb_set(r, '{students}', (r->'students') || pending);
  r := jsonb_set(r, '{guardians}', coalesce((select jsonb_agg(g || jsonb_build_object('studentIds', (g->'studentIds') || coalesce((
      select jsonb_agg(p->'id') from jsonb_array_elements(pending) p where (p->'guardianIds') ? (g->>'id')), '[]'))) from jsonb_array_elements(r->'guardians') g), '[]'));
  return r;
end $$;

-- ---------------------------------------------------------------- N8 request digests, N10 claim tokens
alter table app.command_requests add column args_digest text;
alter table public.reminders_sent add column claim_token uuid;
create or replace function public.claim_reminders(p_rows jsonb, p_stale_after interval default '30 minutes') returns setof public.reminders_sent
language sql volatile security invoker set search_path = public, pg_temp as $$
  insert into public.reminders_sent as r (invoice_id, kind, sent_on, text, status, claimed_at, attempts, claim_token)
  select x->>'invoiceId', x->>'kind', (x->>'sentOn')::date, x->>'text', 'claimed', now(), 1, gen_random_uuid() from jsonb_array_elements(p_rows) x
  on conflict (invoice_id, kind) do update set status = 'claimed', claimed_at = now(), attempts = r.attempts + 1, sent_on = excluded.sent_on, text = excluded.text,
    claim_token = gen_random_uuid()
    where r.status = 'failed' or (r.status = 'claimed' and r.claimed_at < now() - p_stale_after)
  returning r.*
$$;
-- p_rows: [{invoiceId, kind, claimToken, status:'sent'|'failed', pushSent, error}]; a run whose claim expired and was
-- taken over by another run changes nothing (its token no longer matches)
create or replace function public.finish_reminders(p_rows jsonb) returns int language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare n int;
begin
  update public.reminders_sent r set status = x->>'status', push_sent = coalesce((x->>'pushSent')::int, 0), last_error = x->>'error'
  from jsonb_array_elements(p_rows) x
  where r.invoice_id = x->>'invoiceId' and r.kind = x->>'kind' and r.status = 'claimed' and x->>'status' in ('sent', 'failed')
    and r.claim_token = nullif(x->>'claimToken', '')::uuid;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------- load_slice wrapper (#9 gateway events, N8 digest)
alter function public.load_slice(text[], jsonb) set schema app;
alter function app.load_slice(text[], jsonb) rename to load_slice_0003;
create function public.load_slice(p_collections text[], p_hints jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security invoker set search_path = public, app, pg_temp as $$
declare
  r jsonb := app.load_slice_0003(array(select c from unnest(p_collections) c where c <> 'gatewayEvents'), p_hints);
  eg text := nullif(p_hints->>'exportGuardianId', '');
begin
  if 'gatewayEvents' = any(p_collections) then
    -- the guardian's own payments only (orders they created); without a guardian hint, none
    r := jsonb_set(r, '{db,gatewayEvents}', coalesce((select jsonb_agg(jsonb_build_object('eventId', e.event_id, 'event', e.event, 'receivedAt', e.received_at, 'payload', e.payload) order by e.received_at, e.event_id)
      from public.gateway_events e
      where eg is not null and (
        e.payload->'payload'->'payment'->'entity'->>'order_id' in (select o.id from public.gateway_orders o where o.guardian_id = eg)
        or e.payload->'payload'->'refund'->'entity'->>'payment_id' in (select p.gateway_payment_id from public.payments p
             where p.doc->>'gatewayOrderId' in (select o.id from public.gateway_orders o where o.guardian_id = eg)))), '[]'::jsonb));
  end if;
  if p_hints ? 'requestId' and r->'db'->'priorRequest' is not null and jsonb_typeof(r->'db'->'priorRequest') = 'object' then
    r := jsonb_set(r, '{db,priorRequest,argsDigest}', to_jsonb((select q.args_digest from app.command_requests q where q.request_id = p_hints->>'requestId')));
  end if;
  return r;
end $$;

-- ---------------------------------------------------------------- persist wrapper (N2 display rows, N3 caller, N8 digest)
alter function public.persist(text, bigint, jsonb) set schema app;
alter function app.persist(text, bigint, jsonb) rename to persist_0003;
-- p_changes.caller: {userId, role, staffId, guardianId} of a signed-in caller (absent for system and unlinked callers)
create function public.persist(p_rev_key text, p_expected bigint, p_changes jsonb) returns bigint
language plpgsql volatile security invoker set search_path = public, app, pg_temp as $$
declare
  k text;
  ok int;
  res bigint;
  c jsonb := p_changes->'caller';
begin
  if c is not null then
    -- same lock order as every other writer (revisions, sorted; then app_users), so a revoke never deadlocks with this
    foreach k in array array(select distinct g from unnest(array[p_rev_key] || array(select jsonb_object_keys(coalesce(p_changes->'guards', '{}'::jsonb)))) g order by g) loop
      insert into app.revs (slice, rev) values (k, 0) on conflict (slice) do nothing;
      perform 1 from app.revs where slice = k for update;
    end loop;
    select 1 into ok from public.app_users u
     where u.user_id = (c->>'userId')::uuid and u.status = 'active' and u.role = c->>'role'
       and u.staff_id is not distinct from (c->>'staffId') and u.guardian_id is not distinct from (c->>'guardianId')
     for share;
    if ok is null then
      raise exception 'NOT_ALLOWED' using errcode = 'PT403', detail = 'the caller''s access changed after the command started';
    end if;
  end if;
  res := app.persist_0003(p_rev_key, p_expected, p_changes - 'caller');
  if p_changes->'upserts' ? 'students' then
    insert into public.student_display (student_id, first_name, last_name, program_id, status)
      select e->>'id', coalesce(e->>'firstName', ''), coalesce(e->>'lastName', ''), e->>'programId', e->>'status' from jsonb_array_elements(p_changes->'upserts'->'students') e
      on conflict (student_id) do update set first_name = excluded.first_name, last_name = excluded.last_name, program_id = excluded.program_id, status = excluded.status;
  end if;
  if p_changes ? 'request' then
    update app.command_requests set args_digest = p_changes->'request'->>'argsDigest' where request_id = p_changes->'request'->>'id';
  end if;
  return res;
end $$;

-- ---------------------------------------------------------------- grants
revoke all on public.student_display from anon, authenticated;
grant select on public.student_display to authenticated;
grant all on public.student_display to service_role;
revoke all on function public.my_snapshot(), public.load_slice(text[], jsonb), public.persist(text, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.my_snapshot() to authenticated, service_role;
grant execute on function public.load_slice(text[], jsonb), public.persist(text, bigint, jsonb) to service_role;
revoke all on function app.my_snapshot_0003(), app.load_slice_0003(text[], jsonb), app.persist_0003(text, bigint, jsonb) from public, anon;
revoke all on function app.load_slice_0003(text[], jsonb), app.persist_0003(text, bigint, jsonb) from authenticated;
grant execute on function app.my_snapshot_0003() to authenticated, service_role;
grant execute on function app.load_slice_0003(text[], jsonb), app.persist_0003(text, bigint, jsonb) to service_role;
