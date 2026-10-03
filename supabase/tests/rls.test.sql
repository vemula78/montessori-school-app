-- pgTAP: access model, RLS matrix and ledger guards. Run: supabase db reset && supabase test db
-- Uses the generated seed (fake data): grd-01 = parent-siblings (stu-01 Primary A on route-1, stu-02 Primary B),
-- grd-02 = parent-bus (stu-03 Toddler on route-1, stu-04 Primary A), grd-05 (stu-09 on route-2).
-- Impersonation: set local role + request.jwt.claims, exactly what PostgREST does for a signed-in user.
begin;
create extension if not exists pgtap with schema extensions;
select plan(46);

-- ---------------------------------------------------------------- helpers (rolled back with the test)
create schema tests;
create function tests.readable_relations() returns text[] language plpgsql as $$
declare t text; ok text[] := '{}';
begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p') order by 1 loop
    begin
      execute format('select 1 from public.%I limit 1', t);
      ok := ok || t;
    exception when insufficient_privilege then null;
    end;
  end loop;
  return ok;
end $$;
create function tests.as_user(uid text) returns void language sql as $$
  select set_config('role', 'authenticated', true), set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
$$;
grant usage on schema tests to anon, authenticated, service_role;
grant execute on all functions in schema tests to anon, authenticated, service_role;

-- a parent on route 2 (other route) with live-bus consent, made for this test only
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-0000000000aa', 'authenticated', 'authenticated', 'route2-parent@example.com', '', now(), now());
insert into public.app_users (user_id, role, guardian_id, status) values ('00000000-0000-4000-8000-0000000000aa', 'parent', 'grd-05', 'active');
insert into public.consents (id, doc) values ('cns-test-r2', jsonb_build_object('id', 'cns-test-r2', 'guardianId', 'grd-05', 'studentId', 'stu-09', 'purpose', 'bus_live', 'version', 'v1', 'withdrawnAt', null));

-- ---------------------------------------------------------------- anon
set local role anon;
select is(tests.readable_relations(), '{}'::text[], 'anon_denied_every_table');
select throws_ok('select public.my_snapshot()', '42501', null, 'anon_cannot_execute_snapshot_or_persist: my_snapshot');
select throws_ok($$select public.persist('x', 0, '{}'::jsonb)$$, '42501', null, 'anon_cannot_execute_snapshot_or_persist: persist');
select throws_ok($$select public.load_slice('{students}'::text[], '{}'::jsonb)$$, '42501', null, 'anon_cannot_execute_snapshot_or_persist: load_slice');
reset role;

-- signed-in users cannot reach the server-only functions either
select tests.as_user('00000000-0000-4000-8000-000000000001');
select throws_ok($$select public.persist('x', 0, '{}'::jsonb)$$, '42501', null, 'anon_cannot_execute_snapshot_or_persist: authenticated cannot persist');
select throws_ok($$select public.load_slice('{students}'::text[], '{}'::jsonb)$$, '42501', null, 'anon_cannot_execute_snapshot_or_persist: authenticated cannot load_slice');
select throws_ok($$insert into public.invoices (id, doc) values ('x', '{"number":"INV/26-27/9999"}')$$, '42501', null, 'authenticated cannot write ledger tables directly');
reset role;

-- ---------------------------------------------------------------- parent (bus child, consent given)
select tests.as_user('00000000-0000-4000-8000-000000000006');
select is((select array_agg(id order by id) from public.students), array['stu-03', 'stu-04'], 'parent_sees_only_own_children_invoices_payments: students');
select is((select array_agg(distinct student_id order by student_id) from public.invoices), array['stu-03', 'stu-04'], 'parent_sees_only_own_children_invoices_payments: invoices');
select ok((select bool_and(student_id in ('stu-03', 'stu-04')) from public.payments) and (select count(*) from public.payments) > 0, 'parent_sees_only_own_children_invoices_payments: payments');
select is((select array_agg(id) from public.guardians), array['grd-02'], 'parent sees only their own guardian row');
select is((select count(*)::int from public.fee_structures), 0, 'parent sees no fee structures');
select ok((select count(*) from public.trip_positions) > 0, 'parent on route 1 with bus_live consent sees the route-1 trip positions');
select is((select jsonb_array_length(public.my_snapshot()->'students')), 2, 'snapshot carries only the two own children');
select ok((select bool_and(e->>'phone' is null) from jsonb_array_elements(public.my_snapshot()->'staff') e), 'snapshot hides staff phones from a parent');
reset role;

-- ---------------------------------------------------------------- parent with siblings, no bus consent
select tests.as_user('00000000-0000-4000-8000-000000000005');
select is((select array_agg(id order by id) from public.students), array['stu-01', 'stu-02'], 'parent_sibling_guardian_sees_both_children');
select is((select count(distinct program_id)::int from public.students), 2, 'parent_sibling_guardian_sees_both_children: two programs');
select is((select count(*)::int from public.trip_positions), 0, 'parent_positions_require_bus_live_consent: none without consent');
select is((select count(*)::int from public.trips), 0, 'parent_positions_require_bus_live_consent: no trips without consent');
reset role;
insert into public.consents (id, doc) values ('cns-test-g1', jsonb_build_object('id', 'cns-test-g1', 'guardianId', 'grd-01', 'studentId', 'stu-01', 'purpose', 'bus_live', 'version', 'v1', 'withdrawnAt', null));
select tests.as_user('00000000-0000-4000-8000-000000000005');
select ok((select count(*) from public.trip_positions) > 0, 'parent_positions_require_bus_live_consent: visible once consent is given');
reset role;
update public.consents set doc = doc || jsonb_build_object('withdrawnAt', '2026-10-02T05:00:00.000Z') where id = 'cns-test-g1';
select tests.as_user('00000000-0000-4000-8000-000000000005');
select is((select count(*)::int from public.trip_positions), 0, 'parent_positions_require_bus_live_consent: withdrawal cuts access immediately');
reset role;

-- ---------------------------------------------------------------- parent on another route
select tests.as_user('00000000-0000-4000-8000-0000000000aa');
select is((select count(*)::int from public.trip_positions), 0, 'parent_other_route_trip_positions_hidden: positions');
select is((select count(*)::int from public.trips), 0, 'parent_other_route_trip_positions_hidden: trips');
select is((select array_agg(id) from public.routes), array['route-2'], 'parent of a route-2 child sees route 2 only');
reset role;

-- ---------------------------------------------------------------- teacher (Primary A)
select tests.as_user('00000000-0000-4000-8000-000000000002');
select ok((select bool_and(program_id = 'prog-primary-a') from public.students) and (select count(*) from public.students) > 0, 'teacher_program_scope_students_threads_no_fees: students');
select ok((select bool_and(program_id = 'prog-primary-a') from public.threads) and (select count(*) from public.threads) > 0, 'teacher_program_scope_students_threads_no_fees: threads');
select is((select count(*)::int from public.invoices) + (select count(*)::int from public.payments) + (select count(*)::int from public.refunds), 0, 'teacher_program_scope_students_threads_no_fees: no fees');
select is((select count(*)::int from public.trips), 0, 'teacher sees no trips');
reset role;
create temp table expected_teacher_guardians as
  select array_agg(distinct sg.guardian_id order by sg.guardian_id) ids from public.student_guardians sg join public.students s on s.id = sg.student_id where s.program_id = 'prog-primary-a';
grant select on expected_teacher_guardians to authenticated;
select tests.as_user('00000000-0000-4000-8000-000000000002');
select is((select array_agg(id order by id) from public.guardians), (select ids from expected_teacher_guardians), 'teacher_sees_guardians_of_own_students_only');
reset role;

-- ---------------------------------------------------------------- driver (route 1)
select tests.as_user('00000000-0000-4000-8000-000000000004');
select ok((select bool_and(route_id = 'route-1') from public.students) and (select count(*) from public.students) > 0, 'driver_own_route_students_without_health: own route');
select is((select count(*)::int from public.student_health), 0, 'driver_own_route_students_without_health: no health notes');
select is((select count(*)::int from public.invoices) + (select count(*)::int from public.payments), 0, 'driver_no_fees_no_guardians: no fees');
select is((select count(*)::int from public.guardians) + (select count(*)::int from public.student_guardians), 0, 'driver_no_fees_no_guardians: no guardians');
reset role;

-- ---------------------------------------------------------------- accountant, admin
create temp table totals as select (select count(*) from public.invoices) inv, (select count(*) from public.students) stu, (select count(*) from public.guardians) grd, (select count(*) from public.student_health) hl;
grant select on totals to authenticated;
select tests.as_user('00000000-0000-4000-8000-000000000003');
select is((select count(*) from public.invoices), (select inv from totals), 'accountant_all_ledger_no_health: all invoices');
select is((select count(*)::int from public.student_health), 0, 'accountant_all_ledger_no_health: no health notes');
reset role;
select tests.as_user('00000000-0000-4000-8000-000000000001');
select ok((select count(*) from public.students) = (select stu from totals) and (select count(*) from public.guardians) = (select grd from totals)
  and (select count(*) from public.invoices) = (select inv from totals) and (select count(*) from public.student_health) = (select hl from totals) and (select hl from totals) > 0, 'admin_all');
reset role;

-- ---------------------------------------------------------------- revocation is immediate (role read from app_users per request)
update public.app_users set status = 'revoked' where user_id = '00000000-0000-4000-8000-000000000002';
select tests.as_user('00000000-0000-4000-8000-000000000002');
select is((select count(*)::int from public.students) + (select count(*)::int from public.programs), 0, 'revoked_user_sees_nothing');
select is(public.my_snapshot()->>'status', 'revoked', 'revoked_user_sees_nothing: snapshot says revoked');
reset role;

-- ---------------------------------------------------------------- definer functions, views, audit, ledger uniqueness, rev guard, cron
select is((select array_agg(n.nspname || '.' || p.proname order by 1) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where p.prosecdef and n.nspname in ('public', 'app')), array['app.link_new_auth_user'], 'no_security_definer_except_auth_trigger');
select is((select array_agg(c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'v' and not coalesce(c.reloptions @> array['security_invoker=true'], false)), null, 'no_views_without_security_invoker');
set local role service_role;
select throws_ok($$update public.audit_log set doc = doc || '{"summary":"x"}'::jsonb$$, '42501', null, 'audit_log_append_only: no update (service role)');
select throws_ok($$delete from public.audit_log$$, '42501', null, 'audit_log_append_only: no delete (service role)');
reset role;
select throws_ok($$insert into public.payments (id, doc) select 'pay-dup', doc || '{"id":"pay-dup"}'::jsonb from public.payments limit 1$$, '23505', null, 'receipt_number_unique');
select is(public.persist('pgtap-slice', 0, '{}'::jsonb), 1::bigint, 'persist accepts the current rev');
select throws_ok($$select public.persist('pgtap-slice', 0, '{}'::jsonb)$$, 'PT409', 'CONFLICT', 'persist_rejects_stale_rev');
select is((select count(*)::int from cron.job where jobname = 'cron-daily' and schedule = '30 2 * * *'), 1, 'cron_job_registered');

select * from finish();
rollback;
