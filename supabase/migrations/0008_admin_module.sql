-- Administration module (forward-only: 0001–0007 are applied to the cloud project and never edited).
--   * accounts: app_users.status gains 'blocked' (RLS, my_snapshot and the command function refuse it at once);
--     public.end_sessions(user) ends every session of a sign-in (service role only; the second SECURITY DEFINER function)
--   * two-step sign-in for the principal and the accountant: the JWT `aal` claim must be aal2 when the user has a
--     verified authenticator (two_step_enrolled, mirrored from auth.mfa_factors by a trigger) or the school's policy
--     (app_policy 'two_step' = {"required": true}) asks for it. app.my_link() returns nothing otherwise, so every policy,
--     the snapshot and realtime follow; my_snapshot says 'two_step_required'. SQL twin of twoStepRequired
--     (src/domain/admin.js). Shipped with required = false: each person enrols at their own pace and is protected from the
--     moment the factor is verified; the policy row is switched on later from the Administration screen.
--   * sign-in activity: sign_in_events, written by a trigger on auth.users.last_sign_in_at (auth.audit_log_entries is
--     empty in this kind of project); principal only; pruned at 90 days by cron-daily
--   * data-rights desk: data_requests (schema v3 collection dataRequests); a parent reads their own, the principal all
--   * the school announcement is part of the school document (no table change)
-- persist / load_slice / my_snapshot of 0005 move to schema app and are wrapped here (the 0004/0005 pattern).
-- Both new auth triggers run as supabase_auth_admin (the auth server's role): it gets exactly the grants and RLS policies
-- it needs. The sign-in trigger swallows its own errors (a bug must never block a sign-in); the authenticator mirror
-- does not (a failed mirror fails the enrolment instead of leaving an enrolled principal unprotected).

-- ---------------------------------------------------------------- accounts: blocked
alter table public.app_users drop constraint app_users_status_check;
alter table public.app_users add constraint app_users_status_check check (status in ('pending', 'active', 'revoked', 'withdrawn', 'blocked'));

-- ---------------------------------------------------------------- school policy (two-step for all privileged accounts)
create table public.app_policy (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
insert into public.app_policy (key, value) values ('two_step', '{"required": false}');
alter table public.app_policy enable row level security;
alter table public.app_policy force row level security;
-- readable by every signed-in user (the app shows whether two-step is required); not via app.my_link: my_link reads it
create policy read_all on public.app_policy for select to authenticated using (true);

-- ---------------------------------------------------------------- two-step: who has a verified authenticator
create table public.two_step_enrolled (
  user_id uuid primary key references auth.users (id) on delete cascade,
  verified_at timestamptz not null default now()
);
alter table public.two_step_enrolled enable row level security;
alter table public.two_step_enrolled force row level security;
create policy read_own on public.two_step_enrolled for select to authenticated using (user_id = auth.uid());
create policy auth_server_writes on public.two_step_enrolled for all to supabase_auth_admin using (true) with check (true);

create function app.mirror_two_step() returns trigger language plpgsql security invoker set search_path = '' as $$
declare uid uuid;
begin
  foreach uid in array array(select distinct x from unnest(array[case when tg_op <> 'DELETE' then new.user_id end,
                                                               case when tg_op <> 'INSERT' then old.user_id end]) x where x is not null) loop
    if exists (select 1 from auth.mfa_factors f where f.user_id = uid and f.factor_type = 'totp' and f.status = 'verified') then
      insert into public.two_step_enrolled (user_id) values (uid) on conflict (user_id) do nothing;
    else
      delete from public.two_step_enrolled where user_id = uid;
    end if;
  end loop;
  return null;
end $$;
create trigger two_step_mirror after insert or update of status, user_id, factor_type or delete on auth.mfa_factors
  for each row execute function app.mirror_two_step();
insert into public.two_step_enrolled (user_id)
  select distinct f.user_id from auth.mfa_factors f where f.factor_type = 'totp' and f.status = 'verified' on conflict do nothing;

-- the rule (twoStepRequired in src/domain/admin.js): aal2, or nothing asks for it. STABLE, two indexed point reads.
create function app.two_step_ok(p_user uuid) returns boolean language sql stable security invoker set search_path = public, pg_temp as $$
  select coalesce(auth.jwt()->>'aal', 'aal1') = 'aal2'
      or not (exists (select 1 from public.two_step_enrolled e where e.user_id = p_user)
              or coalesce((select (p.value->>'required')::boolean from public.app_policy p where p.key = 'two_step'), false))
$$;

-- every policy reads the caller through my_link: blocked, or privileged without the second step → no link, no data
create or replace function app.my_link() returns public.app_users language sql stable security invoker set search_path = public, pg_temp as $$
  select u.* from public.app_users u
  where u.user_id = auth.uid() and u.status = 'active'
    and (u.role not in ('admin', 'accountant') or app.two_step_ok(u.user_id))
$$;

-- ---------------------------------------------------------------- sign-in activity
create table public.sign_in_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  at timestamptz not null default now(),
  aal text
);
create index sign_in_events_at on public.sign_in_events (at desc);
alter table public.sign_in_events enable row level security;
alter table public.sign_in_events force row level security;
create policy read_admin on public.sign_in_events for select to authenticated using (app.my_role() = 'admin');
create policy auth_server_inserts on public.sign_in_events for insert to supabase_auth_admin with check (true);

create function app.record_sign_in() returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  begin
    insert into public.sign_in_events (user_id, at, aal)
    values (new.id, coalesce(new.last_sign_in_at, now()),
            (select s.aal::text from auth.sessions s where s.user_id = new.id order by s.created_at desc nulls last limit 1));
  exception when others then
    raise warning 'record_sign_in failed (%); the sign-in itself goes ahead', sqlstate;
  end;
  return new;
end $$;
create trigger on_auth_user_signed_in after update of last_sign_in_at on auth.users for each row
  when (new.last_sign_in_at is distinct from old.last_sign_in_at) execute function app.record_sign_in();

-- ---------------------------------------------------------------- data-rights desk
create table public.data_requests (
  id text primary key, doc jsonb not null,
  guardian_id text generated always as (doc->>'guardianId') stored not null,
  kind text generated always as (doc->>'kind') stored check (kind in ('export', 'erasure', 'correction')),
  status text generated always as (doc->>'status') stored check (status in ('open', 'in_progress', 'done', 'declined'))
);
-- one open request per guardian and kind, even under concurrent filing (the domain refuses it first)
create unique index data_requests_open on public.data_requests (guardian_id, kind) where status in ('open', 'in_progress');
alter table public.data_requests enable row level security;
alter table public.data_requests force row level security;
create policy read_scoped on public.data_requests for select to authenticated using (
  case app.my_role()
    when 'admin' then true
    when 'parent' then guardian_id = app.my_guardian_id()
    else false end);

-- ---------------------------------------------------------------- end every session of a sign-in (service role only)
-- The auth server has no admin "sign out everywhere"; deleting the sessions removes their refresh tokens (cascade), and
-- /auth/v1/user refuses an access token whose session is gone. SECURITY DEFINER because service_role has no rights on
-- auth.sessions; search_path pinned; executable by service_role only.
create function public.end_sessions(p_user uuid) returns int language plpgsql volatile security definer set search_path = '' as $$
declare n int;
begin
  delete from auth.sessions where user_id = p_user;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------- load_slice wrapper: dataRequests, the caller's two-step state
alter function public.load_slice(text[], jsonb) set schema app;
alter function app.load_slice(text[], jsonb) rename to load_slice_0005;
create function public.load_slice(p_collections text[], p_hints jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security invoker set search_path = public, app, pg_temp as $$
declare
  r jsonb := app.load_slice_0005(array(select c from unnest(p_collections) c where c <> 'dataRequests'), p_hints);
  eg text := nullif(p_hints->>'exportGuardianId', '');
  uid uuid;
begin
  if 'dataRequests' = any(p_collections) then
    r := jsonb_set(r, '{db,dataRequests}', coalesce((select jsonb_agg(doc order by id) from public.data_requests
      where eg is null or guardian_id = eg), '[]'::jsonb));
  end if;
  if p_hints ? 'callerUserId' then
    uid := (p_hints->>'callerUserId')::uuid;
    r := jsonb_set(r, '{db,callerTwoStep}', jsonb_build_object(
      'enrolled', exists (select 1 from public.two_step_enrolled e where e.user_id = uid),
      'required', coalesce((select (p.value->>'required')::boolean from public.app_policy p where p.key = 'two_step'), false)));
  end if;
  return jsonb_set(r, '{db,schemaVersion}', '3'::jsonb);
end $$;

-- ---------------------------------------------------------------- persist wrapper: dataRequests upserts (never deleted)
alter function public.persist(text, bigint, jsonb) set schema app;
alter function app.persist(text, bigint, jsonb) rename to persist_0005;
create function public.persist(p_rev_key text, p_expected bigint, p_changes jsonb) returns bigint
language plpgsql volatile security invoker set search_path = public, app, pg_temp as $$
declare
  inner_changes jsonb := p_changes;
  arr jsonb := p_changes->'upserts'->'dataRequests';
  res bigint;
begin
  if p_changes ? 'upserts' then
    inner_changes := jsonb_set(inner_changes, '{upserts}', (p_changes->'upserts') - 'dataRequests');
  end if;
  -- the earlier persist first: revision locks and checks, the caller check, request id, every older collection, audit
  res := app.persist_0005(p_rev_key, p_expected, inner_changes);
  if jsonb_typeof(arr) = 'array' and jsonb_array_length(arr) > 0 then
    insert into public.data_requests (id, doc) select e->>'id', e from jsonb_array_elements(arr) e
      on conflict (id) do update set doc = excluded.doc;
  end if;
  return res;
end $$;

-- ---------------------------------------------------------------- my_snapshot wrapper: blocked, two_step_required, schema v3
alter function public.my_snapshot() set schema app;
alter function app.my_snapshot() rename to my_snapshot_0005;
create function public.my_snapshot() returns jsonb language plpgsql stable security invoker set search_path = public, app, pg_temp as $$
declare
  u public.app_users;
  enrolled boolean := false;
  required boolean := coalesce((select (p.value->>'required')::boolean from public.app_policy p where p.key = 'two_step'), false);
  r jsonb;
begin
  select * into u from public.app_users where user_id = auth.uid();
  if u.user_id is not null then enrolled := exists (select 1 from public.two_step_enrolled e where e.user_id = u.user_id); end if;
  if u.user_id is not null and u.status = 'active' and u.role in ('admin', 'accountant') and not app.two_step_ok(u.user_id) then
    return jsonb_build_object('status', 'two_step_required', 'me', jsonb_build_object('role', u.role),
      'twoStep', jsonb_build_object('enrolled', enrolled, 'required', required));
  end if;
  r := app.my_snapshot_0005(); -- 'blocked' comes back as {status:'blocked'} like any other inactive status
  if r->>'status' <> 'active' then return r; end if;
  return r || jsonb_build_object(
    'schemaVersion', 3,
    'dataRequests', coalesce((select jsonb_agg(doc order by id) from public.data_requests), '[]'::jsonb),
    'twoStep', jsonb_build_object('enrolled', enrolled, 'required', required and u.role in ('admin', 'accountant')));
end $$;

-- ---------------------------------------------------------------- grants
revoke all on public.app_policy, public.two_step_enrolled, public.sign_in_events, public.data_requests from anon, authenticated;
grant select on public.app_policy, public.two_step_enrolled, public.sign_in_events, public.data_requests to authenticated;
grant all on public.app_policy, public.two_step_enrolled, public.sign_in_events, public.data_requests to service_role;
grant usage, select on sequence public.sign_in_events_id_seq to service_role;
-- the auth server's role runs both triggers (security invoker)
grant usage on schema app, public to supabase_auth_admin;
grant select, insert, delete on public.two_step_enrolled to supabase_auth_admin;
grant insert on public.sign_in_events to supabase_auth_admin;
grant usage on sequence public.sign_in_events_id_seq to supabase_auth_admin;
revoke all on function app.two_step_ok(uuid), app.mirror_two_step(), app.record_sign_in() from public, anon, authenticated;
grant execute on function app.two_step_ok(uuid) to authenticated, service_role;
grant execute on function app.mirror_two_step(), app.record_sign_in() to supabase_auth_admin;
revoke all on function public.end_sessions(uuid) from public, anon, authenticated;
grant execute on function public.end_sessions(uuid) to service_role;
revoke all on function public.my_snapshot(), public.load_slice(text[], jsonb), public.persist(text, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.my_snapshot() to authenticated, service_role;
grant execute on function public.load_slice(text[], jsonb), public.persist(text, bigint, jsonb) to service_role;
revoke all on function app.my_snapshot_0005(), app.load_slice_0005(text[], jsonb), app.persist_0005(text, bigint, jsonb) from public, anon;
revoke all on function app.load_slice_0005(text[], jsonb), app.persist_0005(text, bigint, jsonb) from authenticated;
grant execute on function app.my_snapshot_0005() to authenticated, service_role;
grant execute on function app.load_slice_0005(text[], jsonb), app.persist_0005(text, bigint, jsonb) to service_role;
