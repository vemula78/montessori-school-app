-- pgTAP: access model, RLS matrix and ledger guards. Run: supabase db reset && supabase test db
-- Uses the generated seed (fake data): grd-01 = parent-siblings (stu-01 Primary A on route-1, stu-02 Primary B),
-- grd-02 = parent-bus (stu-03 Toddler on route-1, stu-04 Primary A), grd-05 (stu-09 on route-2).
-- Migration 0003 (audit fixes) is covered from "audit fixes" below: auth confirmation, per-child consent, child trip
-- events, notice/calendar scoping, cross-slice revision guards, request ids, reminder claims, order slots.
-- Impersonation: set local role + request.jwt.claims, exactly what PostgREST does for a signed-in user.
begin;
create extension if not exists pgtap with schema extensions;
select plan(86);

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
insert into public.consents (id, doc) values ('cns-test-r2a', jsonb_build_object('id', 'cns-test-r2a', 'guardianId', 'grd-05', 'studentId', 'stu-09', 'purpose', 'app_account', 'version', 'v1', 'withdrawnAt', null));

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
-- #7 an old-version bus consent for the child, or a current one for a sibling, does not open the bus
insert into public.consents (id, doc) values ('cns-test-g1-old', jsonb_build_object('id', 'cns-test-g1-old', 'guardianId', 'grd-01', 'studentId', 'stu-01', 'purpose', 'bus_live', 'version', 'v0', 'withdrawnAt', null));
insert into public.consents (id, doc) values ('cns-test-g1-sib', jsonb_build_object('id', 'cns-test-g1-sib', 'guardianId', 'grd-01', 'studentId', 'stu-02', 'purpose', 'bus_live', 'version', 'v1', 'withdrawnAt', null));
select tests.as_user('00000000-0000-4000-8000-000000000005');
select is((select count(*)::int from public.trips), 0, 'bus_consent_is_per_child_and_version: old version or sibling consent opens nothing');
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

-- ================================================================ audit fixes (migration 0003)
-- #1 a staff email gets its role only once the mailbox is confirmed; a password set before that is void
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-0000000000b1', 'authenticated', 'authenticated', 'teacher-pb@example.com',
        extensions.crypt('chosen-by-someone-else', extensions.gen_salt('bf')), now(), now());
select is((select count(*)::int from public.app_users where user_id = '00000000-0000-4000-8000-0000000000b1'), 0, 'auth_unconfirmed_staff_email_gets_no_role');
update auth.users set email_confirmed_at = now() where id = '00000000-0000-4000-8000-0000000000b1';
select is((select role from public.app_users where user_id = '00000000-0000-4000-8000-0000000000b1'), 'teacher', 'auth_confirming_the_mailbox_links_the_staff_role');
select ok((select encrypted_password <> extensions.crypt('chosen-by-someone-else', encrypted_password) from auth.users where id = '00000000-0000-4000-8000-0000000000b1'),
  'auth_a_password_set_before_confirmation_no_longer_works');
update auth.users set email_confirmed_at = now() + interval '1 minute' where id = '00000000-0000-4000-8000-0000000000b1';
select is((select count(*)::int from public.app_users where user_id = '00000000-0000-4000-8000-0000000000b1'), 1, 'auth_links_at_most_once');
select is((select array_agg(n.nspname || '.' || p.proname order by 1) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where p.prosecdef and n.nspname in ('public', 'app')), array['app.link_new_auth_user'], 'still_no_other_security_definer_function');

-- #6 a linked parent without app_account consent sees the children's names (consent screen) and nothing else
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-0000000000c3', 'authenticated', 'authenticated', 'grd03-test@example.com', '', now(), now());
insert into public.app_users (user_id, role, guardian_id, status) values ('00000000-0000-4000-8000-0000000000c3', 'parent', 'grd-03', 'active');
select tests.as_user('00000000-0000-4000-8000-0000000000c3');
select is((select array_agg(student_id order by student_id) from public.student_display), array['stu-05', 'stu-06'], 'consent_screen_still_lists_the_children');
select is((select count(*)::int from public.students), 0, 'n2_no_student_documents_before_consent');
select ok((select bool_and((e->>'consentPending')::boolean and not e ? 'dob' and not e ? 'admissionNo' and e->'healthNotes' = 'null'::jsonb)
  from jsonb_array_elements(public.my_snapshot()->'students') e) and jsonb_array_length(public.my_snapshot()->'students') = 2, 'n2_snapshot_pending_children_are_display_only');
select is((select count(*)::int from public.invoices) + (select count(*)::int from public.payments) + (select count(*)::int from public.threads)
  + (select count(*)::int from public.student_health) + (select count(*)::int from public.attendance) + (select count(*)::int from public.diary_entries),
  0, 'no_child_data_before_app_account_consent');
reset role;
insert into public.consents (id, doc) values ('cns-test-g3', jsonb_build_object('id', 'cns-test-g3', 'guardianId', 'grd-03', 'studentId', 'stu-05', 'purpose', 'app_account', 'version', 'v1', 'withdrawnAt', null));
select tests.as_user('00000000-0000-4000-8000-0000000000c3');
select is((select array_agg(distinct student_id) from public.invoices), array['stu-05'], 'consent_opens_only_the_consented_child');
select is((select array_agg(id) from public.students), array['stu-05'], 'n2_consent_opens_the_full_record_of_that_child_only');
select is((select array_agg(e->>'id') from jsonb_array_elements(public.my_snapshot()->'students') e where e ? 'consentPending'), array['stu-06'], 'n2_unconsented_sibling_stays_display_only');
reset role;

-- #3 a child's boarding/drop-off events are not in trips.doc; a parent sees only their own child's
select tests.as_user('00000000-0000-4000-8000-000000000006');
select ok((select count(*) from public.trips) > 0 and (select bool_and(not doc ? 'childEvents') from public.trips), 'trip_docs_carry_no_child_events');
select is((select array_agg(distinct student_id) from public.trip_child_events), array['stu-03'], 'parent_sees_only_own_child_trip_events');
select is((select count(*)::int from jsonb_array_elements(public.my_snapshot()->'trips') t, jsonb_array_elements(t->'childEvents') e where e->>'studentId' <> 'stu-03'), 0,
  'snapshot_trip_events_are_own_child_only');
reset role;
create temp table all_child_events as select count(*) n from public.trip_child_events te join public.trips t on t.id = te.trip_id where t.route_id = 'route-1';
grant select on all_child_events to authenticated;
select tests.as_user('00000000-0000-4000-8000-000000000004');
select is((select count(*) from public.trip_child_events), (select n from all_child_events), 'driver_sees_every_child_event_of_own_route');
reset role;

-- #29 notices: a parent gets only their own child in a targeted audience; a teacher no sibling outside their program
select tests.as_user('00000000-0000-4000-8000-0000000000aa');
select ok((select count(*) from public.notices where doc->'audience'->>'scope' = 'students') = 1
  and not exists (select 1 from public.notices where coalesce((doc->'audience') ? 'studentIds', false)), 'notice_docs_carry_no_student_lists');
select is((select array_agg(student_id) from public.notice_students), array['stu-09'], 'parent_sees_only_own_child_in_a_notice_audience');
select is((select jsonb_agg(x) from jsonb_array_elements(public.my_snapshot()->'notices') n, jsonb_array_elements_text(n->'audience'->'studentIds') x), '["stu-09"]'::jsonb,
  'snapshot_notice_audience_is_own_child_only');
reset role;
select tests.as_user('00000000-0000-4000-8000-000000000002');
select is((select count(*)::int from public.notice_receipt_students where student_id = 'stu-02'), 0, 'teacher_sees_no_sibling_outside_own_program_in_receipts');
select is((select count(*)::int from public.calendar_events where doc->'programIds' = '["prog-toddler"]'::jsonb), 0, 'teacher_sees_no_other_programs_calendar_events');
reset role;
select tests.as_user('00000000-0000-4000-8000-000000000004');
select is((select count(*)::int from public.calendar_events where jsonb_array_length(doc->'programIds') > 0), 0, 'driver_sees_school_wide_calendar_events_only');
reset role;

-- #13 a change is checked against (and moves) every slice revision it is guarded by
select throws_ok($$select public.persist('pgtap-a', 0, '{"guards":{"pgtap-b":5}}'::jsonb)$$, 'PT409', 'CONFLICT', 'persist_rejects_a_stale_guard_revision');
select is(public.persist('pgtap-a', 0, '{"guards":{"pgtap-b":0}}'::jsonb), 1::bigint, 'persist_accepts_current_guards');
select is((select rev from app.revs where slice = 'pgtap-b'), 1::bigint, 'persist_moves_the_guarded_slice_too');

-- #20 a request id is committed once
select lives_ok($$select public.persist('pgtap-r', 0, '{"request":{"id":"req-pgtap-0001","userId":"00000000-0000-4000-8000-000000000001","name":"x","result":{"ok":1},"argsDigest":"d1"}}'::jsonb)$$, 'request_id_stored');
select throws_ok($$select public.persist('pgtap-r', 1, '{"request":{"id":"req-pgtap-0001","userId":"00000000-0000-4000-8000-000000000001","name":"x","result":{"ok":2}}}'::jsonb)$$, '23505', null, 'request_id_committed_once');
select is((select (public.load_slice('{}'::text[], '{"requestId":"req-pgtap-0001"}'::jsonb))->'db'->'priorRequest'->'result'), '{"ok":1}'::jsonb, 'load_slice_returns_the_prior_request');
select is((select (public.load_slice('{}'::text[], '{"requestId":"req-pgtap-0001"}'::jsonb))->'db'->'priorRequest'->>'argsDigest'), 'd1', 'n8_prior_request_carries_its_args_digest');

-- #28 reminders are claimed once; a failed one is claimed again by the next run
create temp table rem_inv as select id from public.invoices limit 1;
create temp table claim1 as select * from public.claim_reminders((select jsonb_build_array(jsonb_build_object('invoiceId', id, 'kind', '+14', 'sentOn', '2026-10-02', 'text', 't')) from rem_inv));
select is((select count(*)::int from claim1 where claim_token is not null), 1, 'reminder_claimed');
select is((select count(*)::int from public.claim_reminders((select jsonb_build_array(jsonb_build_object('invoiceId', id, 'kind', '+14', 'sentOn', '2026-10-02', 'text', 't')) from rem_inv))), 0, 'reminder_not_claimed_twice');
select is(public.finish_reminders((select jsonb_build_array(jsonb_build_object('invoiceId', invoice_id, 'kind', kind, 'status', 'sent', 'claimToken', gen_random_uuid())) from claim1)), 0, 'n10_another_claims_finish_changes_nothing');
select is(public.finish_reminders((select jsonb_build_array(jsonb_build_object('invoiceId', invoice_id, 'kind', kind, 'status', 'failed', 'pushSent', 0, 'error', 'x', 'claimToken', claim_token)) from claim1)), 1, 'reminder_marked_failed');
select is((select count(*)::int from public.claim_reminders((select jsonb_build_array(jsonb_build_object('invoiceId', id, 'kind', '+14', 'sentOn', '2026-10-03', 'text', 't')) from rem_inv))), 1, 'failed_reminder_claimed_again');

-- N3 persist refuses a caller whose link was revoked or whose role changed (checked inside the transaction)
select throws_ok($$select public.persist('pgtap-n3', 0, '{"caller":{"userId":"00000000-0000-4000-8000-000000000002","role":"teacher","staffId":"stf-teacher-pa","guardianId":null}}'::jsonb)$$,
  'PT403', 'NOT_ALLOWED', 'n3_persist_refuses_a_revoked_caller');
select throws_ok($$select public.persist('pgtap-n3', 0, '{"caller":{"userId":"00000000-0000-4000-8000-000000000004","role":"admin","staffId":"stf-driver-1","guardianId":null}}'::jsonb)$$,
  'PT403', 'NOT_ALLOWED', 'n3_persist_refuses_a_changed_role');
select is(public.persist('pgtap-n3', 0, '{"caller":{"userId":"00000000-0000-4000-8000-000000000004","role":"driver","staffId":"stf-driver-1","guardianId":null}}'::jsonb), 1::bigint, 'n3_persist_accepts_a_current_caller');

-- #42 order slots are counted atomically per user
select is(array[public.take_order_slot('00000000-0000-4000-8000-0000000000d1', 2), public.take_order_slot('00000000-0000-4000-8000-0000000000d1', 2),
  public.take_order_slot('00000000-0000-4000-8000-0000000000d1', 2)], array[true, true, false], 'order_slots_limited');

-- #38 stale trips are ended within 15 minutes
select is((select count(*)::int from cron.job where jobname = 'cron-trips' and schedule = '*/15 * * * *'), 1, 'cron_trips_job_registered');

select * from finish();
rollback;
