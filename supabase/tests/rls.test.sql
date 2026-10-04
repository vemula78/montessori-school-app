-- pgTAP: access model, RLS matrix and ledger guards. Run: supabase db reset && supabase test db
-- Uses the generated seed (fake data): grd-01 = parent-siblings (stu-01 Primary A on route-1, stu-02 Primary B),
-- grd-02 = parent-bus (stu-03 Toddler on route-1, stu-04 Primary A), grd-05 (stu-09 on route-2).
-- Migration 0003 (audit fixes) is covered from "audit fixes" below: auth confirmation, per-child consent, child trip
-- events, notice/calendar scoping, cross-slice revision guards, request ids, reminder claims, order slots.
-- Migration 0005 (Phase 3 learning) from "phase 3" below: observations/photos/progress/reports RLS, consents for
-- teachers, the private photo bucket, persist's delete allow-list, the v2 snapshot, the realtime publication.
-- Migration 0006 (Phase 3 audit fixes): teachers read no consent rows (C2); a parent sees a photo only while photo
-- consent holds for the child across every app-using guardian (C3, photo_consent_flags kept by triggers).
-- Migration 0008 (administration) from "administration" below: blocked accounts, two-step (aal2) for the principal and the
-- accountant, the policy row, the authenticator mirror, sign-in events, end_sessions, the data-rights desk.
-- The definer list is exactly the auth trigger and public.end_sessions. The permission matrix is permissions.test.sql.
-- Impersonation: set local role + request.jwt.claims, exactly what PostgREST does for a signed-in user.
begin;
create extension if not exists pgtap with schema extensions;
select plan(200);

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
insert into public.consents (id, doc) values ('cns-test-r2', jsonb_build_object('id', 'cns-test-r2', 'guardianId', 'grd-05', 'studentId', 'stu-09', 'purpose', 'bus_live', 'version', 'v2', 'withdrawnAt', null));
insert into public.consents (id, doc) values ('cns-test-r2a', jsonb_build_object('id', 'cns-test-r2a', 'guardianId', 'grd-05', 'studentId', 'stu-09', 'purpose', 'app_account', 'version', 'v2', 'withdrawnAt', null));

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
insert into public.consents (id, doc) values ('cns-test-g1-sib', jsonb_build_object('id', 'cns-test-g1-sib', 'guardianId', 'grd-01', 'studentId', 'stu-02', 'purpose', 'bus_live', 'version', 'v2', 'withdrawnAt', null));
select tests.as_user('00000000-0000-4000-8000-000000000005');
select is((select count(*)::int from public.trips), 0, 'bus_consent_is_per_child_and_version: old version or sibling consent opens nothing');
reset role;
insert into public.consents (id, doc) values ('cns-test-g1', jsonb_build_object('id', 'cns-test-g1', 'guardianId', 'grd-01', 'studentId', 'stu-01', 'purpose', 'bus_live', 'version', 'v2', 'withdrawnAt', null));
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
           where p.prosecdef and n.nspname in ('public', 'app')), array['app.link_new_auth_user', 'public.end_sessions'], 'no_security_definer_except_auth_trigger');
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
           where p.prosecdef and n.nspname in ('public', 'app')), array['app.link_new_auth_user', 'public.end_sessions'], 'still_no_other_security_definer_function');

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
insert into public.consents (id, doc) values ('cns-test-g3', jsonb_build_object('id', 'cns-test-g3', 'guardianId', 'grd-03', 'studentId', 'stu-05', 'purpose', 'app_account', 'version', 'v2', 'withdrawnAt', null));
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
-- R4 (migration 0007): the 15-minute job also retries photo clean-up (failed deletions, files put back with an old grant)
select ok((select command from cron.job where jobname = 'cron-trips') ~ '"steps":\s*\["trips",\s*"photosCleanup"\]', 'r4_cron_trips_also_runs_photos_cleanup');

-- ================================================================ phase 3 (migration 0005)
-- fixtures (fake): grd-02 = parent-bus (stu-03 Toddler, stu-04 Primary A); teacher-pa teaches Primary A only
create temp table p3 as select (select id from public.presentations order by id limit 1) pres;
grant select on p3 to authenticated;
insert into public.observations (id, doc) values
  ('obs-t-shared', jsonb_build_object('id', 'obs-t-shared', 'studentId', 'stu-04', 'programId', 'prog-primary-a', 'date', app.ist_today()::text, 'area', 'math', 'presentationId', null, 'text', 'fake shared', 'createdBy', 'stf-teacher-pa', 'createdAt', '2026-10-01T05:00:00.000Z', 'sharedAt', '2026-10-01T06:00:00.000Z', 'sharedBy', 'stf-teacher-pa')),
  ('obs-t-hidden', jsonb_build_object('id', 'obs-t-hidden', 'studentId', 'stu-04', 'programId', 'prog-primary-a', 'date', app.ist_today()::text, 'area', 'math', 'presentationId', null, 'text', 'fake unshared', 'createdBy', 'stf-teacher-pa', 'createdAt', '2026-10-01T05:00:00.000Z', 'sharedAt', null, 'sharedBy', null)),
  ('obs-t-toddler', jsonb_build_object('id', 'obs-t-toddler', 'studentId', 'stu-03', 'programId', 'prog-toddler', 'date', app.ist_today()::text, 'area', 'sensorial', 'presentationId', null, 'text', 'fake toddler', 'createdBy', 'stf-principal', 'createdAt', '2026-10-01T05:00:00.000Z', 'sharedAt', null, 'sharedBy', null));
insert into public.photos (id, doc) select x.id, jsonb_build_object('id', x.id, 'observationId', x.obs, 'studentId', x.sid, 'path', x.sid || '/' || x.id || '.jpg', 'status', x.status)
  from (values ('pho-t-ok', 'obs-t-shared', 'stu-04', 'ready'), ('pho-t-pending', 'obs-t-shared', 'stu-04', 'pending'),
               ('pho-t-unshared', 'obs-t-hidden', 'stu-04', 'ready'), ('pho-t-toddler', 'obs-t-toddler', 'stu-03', 'ready')) x(id, obs, sid, status);
insert into public.progress_events (id, doc) select 'prg-t-' || x.sid, jsonb_build_object('id', 'prg-t-' || x.sid, 'studentId', x.sid, 'presentationId', (select pres from p3), 'seq', 1, 'status', 'introduced', 'date', '2026-09-01')
  from (values ('stu-03'), ('stu-04')) x(sid) where not exists (select 1 from public.progress_events e where e.student_id = x.sid and e.presentation_id = (select pres from p3) and e.seq = 1);
insert into public.reports (id, doc) values
  ('rep-t-pub', jsonb_build_object('id', 'rep-t-pub', 'studentId', 'stu-04', 'academicYearId', 'AY-T', 'termName', 'Term 1', 'status', 'published', 'progress', '[]'::jsonb, 'observations', '[]'::jsonb)),
  ('rep-t-draft', jsonb_build_object('id', 'rep-t-draft', 'studentId', 'stu-04', 'academicYearId', 'AY-T', 'termName', 'Term 2', 'status', 'draft', 'progress', '[]'::jsonb, 'observations', '[]'::jsonb));
insert into storage.objects (bucket_id, name) values ('child-photos', 'stu-04/pho-t-ok.jpg');

select is(app.consent_version(), 'v2', 'p3_consent_version_is_v2');
select tests.as_user('00000000-0000-4000-8000-000000000006');
select ok((select count(*) from public.observations) > 0 and (select bool_and(shared_at is not null and student_id in ('stu-03', 'stu-04')) from public.observations),
  'p3_parent_sees_only_shared_observations_of_own_children');
select is((select count(*)::int from public.observations where id in ('obs-t-hidden', 'obs-t-toddler')), 0, 'p3_parent_sees_no_unshared_observation');
select is((select count(*)::int from public.progress_events), 0, 'p3_parent_sees_no_progress_events');
select is((select array_agg(id order by id) from public.reports where id like 'rep-t-%'), array['rep-t-pub'], 'p3_parent_sees_published_reports_only');
select ok((select bool_and(status = 'published') from public.reports), 'p3_parent_reports_all_published');
select is((select array_agg(id order by id) from public.photos where id like 'pho-t-%'), array['pho-t-ok'], 'p3_parent_photos_only_ready_and_shared');
select is((select count(*)::int from public.presentations), 0, 'p3_parent_sees_no_curriculum');
select is((select jsonb_array_length(public.my_snapshot()->'progressEvents')), 0, 'p3_snapshot_parent_has_no_progress_events');
select ok((select bool_and(e->>'sharedAt' is not null) from jsonb_array_elements(public.my_snapshot()->'observations') e)
  and jsonb_array_length(public.my_snapshot()->'observations') > 0, 'p3_snapshot_parent_observations_all_shared');
select is((public.my_snapshot()->>'schemaVersion')::int, 3, 'p3_snapshot_schema_version (3 since migration 0008)');
select ok((select bool_and(guardian_id = 'grd-02') from public.consents), 'p3_parent_reads_own_consents_only');
select is((select count(*)::int from storage.objects), 0, 'p3_parent_reads_no_storage_objects');
reset role;
select tests.as_user('00000000-0000-4000-8000-000000000005'); -- grd-01: another family
select is((select count(*)::int from public.observations where student_id in ('stu-03', 'stu-04')) + (select count(*)::int from public.photos where id like 'pho-t-%')
  + (select count(*)::int from public.reports where id like 'rep-t-%'), 0, 'p3_other_family_sees_none_of_these');
reset role;

update public.app_users set status = 'active' where user_id = '00000000-0000-4000-8000-000000000002'; -- revoked by the revocation test above
select tests.as_user('00000000-0000-4000-8000-000000000002'); -- teacher, Primary A
select is((select count(*)::int from public.observations o join public.students s on s.id = o.student_id where s.program_id <> 'prog-primary-a'), 0, 'p3_teacher_no_other_program_observations');
select ok((select count(*) from public.observations where id = 'obs-t-hidden') = 1, 'p3_teacher_sees_unshared_of_own_program');
select is((select count(*)::int from public.progress_events where student_id = 'stu-03') + (select count(*)::int from public.photos where student_id = 'stu-03')
  + (select count(*)::int from public.observations where student_id = 'stu-03'), 0, 'p3_teacher_no_toddler_events_photos_observations');
select is((select array_agg(id order by id) from public.photos where id like 'pho-t-%'), array['pho-t-ok', 'pho-t-pending', 'pho-t-unshared'], 'p3_teacher_sees_every_photo_of_own_program');
select is((select count(*)::int from public.consents), 0, 'c2_teacher_reads_no_consent_rows');
select is(jsonb_array_length(public.my_snapshot()->'consents'), 0, 'c2_teacher_snapshot_carries_no_consents');
select is((select count(*)::int from public.photo_consent_flags), 0, 'c2_teacher_reads_no_photo_consent_flags');
select ok((select count(*) from public.presentations) > 0, 'p3_teacher_reads_curriculum');
select ok((select count(*) from public.reports where id like 'rep-t-%') = 2, 'p3_teacher_sees_draft_and_published_reports_of_own_program');
select is((select count(*)::int from storage.objects), 0, 'p3_teacher_reads_no_storage_objects');
reset role;

select tests.as_user('00000000-0000-4000-8000-000000000003'); -- accountant
select is((select count(*)::int from public.presentations) + (select count(*)::int from public.observations) + (select count(*)::int from public.photos)
  + (select count(*)::int from public.progress_events) + (select count(*)::int from public.reports) + (select count(*)::int from public.consents), 0, 'p3_accountant_sees_no_learning_records');
reset role;
select tests.as_user('00000000-0000-4000-8000-000000000004'); -- driver
select is((select count(*)::int from public.presentations) + (select count(*)::int from public.observations) + (select count(*)::int from public.photos)
  + (select count(*)::int from public.progress_events) + (select count(*)::int from public.reports) + (select count(*)::int from public.consents), 0, 'p3_driver_sees_no_learning_records');
reset role;
select tests.as_user('00000000-0000-4000-8000-000000000001'); -- principal
select ok((select count(*) from public.observations where id like 'obs-t-%') = 3 and (select count(*) from public.photos where id like 'pho-t-%') = 4, 'p3_admin_sees_all');
select is((select count(*)::int from storage.objects), 0, 'p3_even_the_principal_reads_no_storage_objects');
reset role;
set local role anon;
select is((select count(*)::int from storage.objects), 0, 'p3_anon_reads_no_storage_objects');
reset role;

select is((select public from storage.buckets where id = 'child-photos'), false, 'p3_photo_bucket_is_private');
select is((select array[file_size_limit::text, array_to_string(allowed_mime_types, ',')] from storage.buckets where id = 'child-photos'), array['409600', 'image/jpeg'], 'p3_photo_bucket_limits');
select is((select count(*)::int from pg_policies where schemaname = 'storage'), 0, 'p3_no_storage_policies_at_all');
select is((select array_agg(n.nspname || '.' || p.proname order by 1) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where p.prosecdef and n.nspname in ('public', 'app')), array['app.link_new_auth_user', 'public.end_sessions'], 'p3_still_no_other_security_definer_function');
select is((select array_agg(c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'v' and not coalesce(c.reloptions @> array['security_invoker=true'], false)), null, 'p3_views_still_security_invoker');
select throws_ok($$select public.persist('pgtap-p3', 0, '{"deletes":{"payments":["pay-x"]}}'::jsonb)$$, '42501', null, 'p3_persist_refuses_deletes_outside_the_allow_list');
select throws_ok($$select public.persist('pgtap-p3', 0, '{"deletes":{"consents":["cns-x"]}}'::jsonb)$$, '42501', null, 'p3_persist_never_deletes_consents');
select is(public.persist('pgtap-p3', 0, '{"deletes":{"observations":["obs-t-toddler"]}}'::jsonb), 1::bigint, 'p3_persist_accepts_an_observation_delete');
select is((select count(*)::int from public.observations where id = 'obs-t-toddler'), 0, 'p3_observation_deleted');
select is(public.persist('pgtap-p3', 1, '{"upserts":{"presentations":[{"id":"prs-t","key":"math:pgtap-only","area":"math","name":"pgtap only","active":true}]}}'::jsonb), 2::bigint, 'p3_persist_writes_learning_collections');
select is((select key from public.presentations where id = 'prs-t'), 'math:pgtap-only', 'p3_presentation_written');
select throws_ok($$insert into public.progress_events (id, doc) select 'prg-t-dup', doc || '{"id":"prg-t-dup"}'::jsonb from public.progress_events where id = 'prg-t-stu-04'$$, '23505', null, 'p3_progress_events_unique_per_child_presentation_seq');
select throws_ok($$insert into public.reports (id, doc) select 'rep-t-dup', doc || '{"id":"rep-t-dup"}'::jsonb from public.reports where id = 'rep-t-pub'$$, '23505', null, 'p3_one_report_per_child_year_term');
select is((public.load_slice('{observations,photos}'::text[], '{"observationId":"obs-t-shared"}'::jsonb))->'db'->'photos' @> '[{"id":"pho-t-unshared"}]'::jsonb, true, 'p3_load_slice_observation_hint_loads_the_child_s_photos');
select is(jsonb_array_length((public.load_slice('{observations}'::text[], '{}'::jsonb))->'db'->'observations'), 0, 'p3_load_slice_without_a_hint_loads_no_observations');
select is((select array_agg(x.tablename::text order by x.tablename) from pg_publication_tables x where x.pubname = 'supabase_realtime' and x.tablename in ('observations', 'reports')),
  array['observations', 'reports'], 'p3_realtime_publication_includes_observations_and_reports');
select is((select count(*)::int from public.photo_objects()), 1, 'p3_photo_objects_lists_the_bucket_for_the_service');
select tests.as_user('00000000-0000-4000-8000-000000000001');
select throws_ok('select * from public.photo_objects()', '42501', null, 'p3_users_cannot_list_photo_objects');
reset role;

-- C3: a second guardian of stu-04 starts using the app without photo consent → the flag drops, the parent sees no photo
select is((select ok from public.photo_consent_flags where student_id = 'stu-04'), true, 'c3_flag_true_while_every_app_guardian_consents');
insert into public.student_guardians (student_id, guardian_id, ord) values ('stu-04', 'grd-03', 9);
insert into public.consents (id, doc) values ('cns-t-c3', jsonb_build_object('id', 'cns-t-c3', 'guardianId', 'grd-03', 'studentId', 'stu-04', 'purpose', 'app_account', 'version', 'v2', 'withdrawnAt', null));
select is((select ok from public.photo_consent_flags where student_id = 'stu-04'), false, 'c3_flag_false_when_an_app_guardian_has_no_photo_consent');
select tests.as_user('00000000-0000-4000-8000-000000000006');
select is((select count(*)::int from public.photos where student_id = 'stu-04'), 0, 'c3_parent_sees_no_photo_while_consent_does_not_hold');
select is((select array_agg(student_id order by student_id) from public.photo_consent_flags), array['stu-03', 'stu-04'], 'c3_parent_reads_flags_of_own_children_only');
reset role;
insert into public.consents (id, doc) values ('cns-t-c3p', jsonb_build_object('id', 'cns-t-c3p', 'guardianId', 'grd-03', 'studentId', 'stu-04', 'purpose', 'photos', 'version', 'v2', 'withdrawnAt', null));
select tests.as_user('00000000-0000-4000-8000-000000000006');
select is((select array_agg(id order by id) from public.photos where id like 'pho-t-%'), array['pho-t-ok'], 'c3_visible_again_once_every_app_guardian_consents');
reset role;
delete from public.student_guardians where student_id = 'stu-04' and guardian_id = 'grd-03';
update public.consents set doc = doc || '{"withdrawnAt":"2026-10-02T05:00:00.000Z"}'::jsonb where id = 'cns-t-c3p';
select is((select ok from public.photo_consent_flags where student_id = 'stu-04'), true, 'c3_flags_follow_guardian_links_and_withdrawals');

-- ================================================================ administration (migration 0008)
create function tests.as_user_aal(uid text, aal text) returns void language sql as $$
  select set_config('role', 'authenticated', true), set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'aal', aal)::text, true);
$$;
grant execute on function tests.as_user_aal(text, text) to authenticated;
create function tests.as_user_iat(uid text, aal text, iat bigint) returns void language sql as $$
  select set_config('role', 'authenticated', true), set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'aal', aal, 'iat', iat)::text, true);
$$;
grant execute on function tests.as_user_iat(text, text, bigint) to authenticated;

-- blocked: accepted by the constraint, closes every read at once, the snapshot says so
update public.app_users set status = 'blocked' where user_id = '00000000-0000-4000-8000-000000000004';
select is((select status from public.app_users where user_id = '00000000-0000-4000-8000-000000000004'), 'blocked', 'adm_blocked_status_accepted');
select tests.as_user('00000000-0000-4000-8000-000000000004');
select is((select count(*)::int from public.students) + (select count(*)::int from public.trip_positions), 0, 'adm_blocked_user_reads_nothing');
select is(public.my_snapshot()->>'status', 'blocked', 'adm_snapshot_says_blocked');
reset role;
update public.app_users set status = 'active' where user_id = '00000000-0000-4000-8000-000000000004';
select throws_ok($$update public.app_users set status = 'suspended' where user_id = '00000000-0000-4000-8000-000000000004'$$, '23514', null, 'adm_unknown_status_refused');

-- the authenticator mirror follows auth.mfa_factors: unverified → nothing; verified → enrolled; deleted → gone
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
values ('00000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-000000000001', 'pgtap', 'totp', 'unverified', now(), now(), 'JBSWY3DPEHPK3PXP');
select is((select count(*)::int from public.two_step_enrolled where user_id = '00000000-0000-4000-8000-000000000001'), 0, 'adm_unverified_factor_is_not_enrolment');
update auth.mfa_factors set status = 'verified' where id = '00000000-0000-4000-8000-0000000000f1';
select is((select count(*)::int from public.two_step_enrolled where user_id = '00000000-0000-4000-8000-000000000001'), 1, 'adm_verified_factor_enrols');

-- an enrolled principal: aal1 reaches nothing (snapshot two_step_required), aal2 everything; a teacher is never asked
select tests.as_user_aal('00000000-0000-4000-8000-000000000001', 'aal1');
select is((select count(*)::int from public.students) + (select count(*)::int from public.audit_log) + (select count(*)::int from public.invoices), 0, 'adm_enrolled_principal_aal1_sees_nothing');
select is(public.my_snapshot()->>'status', 'two_step_required', 'adm_enrolled_principal_aal1_snapshot_two_step_required');
select is(public.my_snapshot()->'twoStep', '{"enrolled": true, "required": false}'::jsonb, 'adm_two_step_required_snapshot_says_enrolled');
select is((select count(*)::int from public.two_step_enrolled), 1, 'adm_user_reads_own_enrolment');
reset role;
select tests.as_user_aal('00000000-0000-4000-8000-000000000001', 'aal2');
select is((select count(*) from public.students), (select stu from totals), 'adm_enrolled_principal_aal2_sees_all');
select is(public.my_snapshot()->>'status', 'active', 'adm_aal2_snapshot_active');
select is((public.my_snapshot()->>'schemaVersion')::int, 3, 'adm_snapshot_schema_version_3');
reset role;
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
values ('00000000-0000-4000-8000-0000000000f2', '00000000-0000-4000-8000-000000000002', 'pgtap', 'totp', 'verified', now(), now(), 'JBSWY3DPEHPK3PXP');
select tests.as_user_aal('00000000-0000-4000-8000-000000000002', 'aal1');
select ok((select count(*) from public.students) > 0, 'adm_enrolled_teacher_at_aal1_unaffected');
select is((select count(*)::int from public.two_step_enrolled where user_id <> '00000000-0000-4000-8000-000000000002'), 0, 'adm_enrolment_rows_of_others_unreadable');
reset role;
delete from auth.mfa_factors where id in ('00000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-0000000000f2');
select is((select count(*)::int from public.two_step_enrolled where user_id in ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002')), 0, 'adm_deleted_factor_unenrols');
-- C3: losing the last authenticator writes a session cutoff (old aal1 tokens, refused while enrolled, stay refused)
select is((select count(*)::int from public.session_cutoffs where user_id in ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002')), 2, 'adm_last_factor_removed_writes_a_cutoff');
select tests.as_user_iat('00000000-0000-4000-8000-000000000001', 'aal1', extract(epoch from now())::bigint - 60);
select is((select count(*)::int from public.students), 0, 'adm_token_from_before_the_cutoff_reads_nothing');
select is(public.my_snapshot()->>'status', 'session_ended', 'adm_snapshot_of_a_cut_token_says_session_ended');
select is((select count(*)::int from public.session_cutoffs), 1, 'adm_user_reads_own_cutoff_only');
select throws_ok($$delete from public.session_cutoffs$$, '42501', null, 'adm_users_cannot_remove_cutoffs');
reset role;
select tests.as_user_iat('00000000-0000-4000-8000-000000000001', 'aal1', extract(epoch from now())::bigint + 5);
select is((select count(*) from public.students), (select stu from totals), 'adm_token_issued_after_the_cutoff_reads_again');
reset role;
delete from public.session_cutoffs where user_id in ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002');

-- the policy row: required = true closes an unenrolled accountant at aal1; aal2 opens; teachers never asked
update public.app_policy set value = '{"required": true}' where key = 'two_step';
select tests.as_user_aal('00000000-0000-4000-8000-000000000003', 'aal1');
select is((select count(*)::int from public.invoices), 0, 'adm_policy_required_closes_unenrolled_accountant_at_aal1');
select is(public.my_snapshot()->'twoStep'->>'required', 'true', 'adm_policy_required_snapshot_says_required');
reset role;
select tests.as_user_aal('00000000-0000-4000-8000-000000000003', 'aal2');
select is((select count(*) from public.invoices), (select inv from totals), 'adm_policy_required_accountant_aal2_sees_ledger');
reset role;
select tests.as_user_aal('00000000-0000-4000-8000-000000000002', 'aal1');
select ok((select count(*) from public.students) > 0, 'adm_policy_never_asks_teachers');
select is((select value->>'required' from public.app_policy where key = 'two_step'), 'true', 'adm_policy_readable_by_signed_in_users');
select throws_ok($$update public.app_policy set value = '{"required": false}' where key = 'two_step'$$, '42501', null, 'adm_policy_not_writable_by_users');
reset role;
update public.app_policy set value = '{"required": false}' where key = 'two_step';

-- sign-in events: written when last_sign_in_at moves (the auth server's update); principal only
update auth.users set last_sign_in_at = now() where id = '00000000-0000-4000-8000-000000000006';
select is((select count(*)::int from public.sign_in_events where user_id = '00000000-0000-4000-8000-000000000006'), 1, 'adm_sign_in_event_recorded');
update auth.users set email = email where id = '00000000-0000-4000-8000-000000000006';
select is((select count(*)::int from public.sign_in_events where user_id = '00000000-0000-4000-8000-000000000006'), 1, 'adm_other_user_updates_record_nothing');
select ok(has_table_privilege('supabase_auth_admin', 'public.sign_in_events', 'INSERT') and has_sequence_privilege('supabase_auth_admin', 'public.sign_in_events_id_seq', 'USAGE')
  and has_table_privilege('supabase_auth_admin', 'public.two_step_enrolled', 'INSERT') and has_table_privilege('supabase_auth_admin', 'public.two_step_enrolled', 'DELETE')
  and has_schema_privilege('supabase_auth_admin', 'app', 'USAGE'), 'adm_auth_server_role_has_the_trigger_grants');
select tests.as_user('00000000-0000-4000-8000-000000000003');
select is((select count(*)::int from public.sign_in_events), 0, 'adm_accountant_reads_no_sign_in_events');
reset role;
select tests.as_user('00000000-0000-4000-8000-000000000006');
select is((select count(*)::int from public.sign_in_events), 0, 'adm_parent_reads_no_sign_in_events');
select ok(not (public.my_snapshot() ? 'signInEvents'), 'adm_snapshot_carries_no_sign_in_events');
reset role;
select tests.as_user('00000000-0000-4000-8000-000000000001');
select ok((select count(*) from public.sign_in_events) > 0, 'adm_principal_reads_sign_in_events');
reset role;

-- end_sessions: the user's sessions and refresh tokens go; nobody signed in can call it
insert into auth.sessions (id, user_id, created_at, updated_at, aal) values
  ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-000000000005', now(), now(), 'aal1'),
  ('00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-000000000005', now(), now(), 'aal1'),
  ('00000000-0000-4000-8000-0000000000e3', '00000000-0000-4000-8000-000000000006', now(), now(), 'aal1');
insert into auth.refresh_tokens (instance_id, token, user_id, revoked, created_at, updated_at, session_id)
values ('00000000-0000-0000-0000-000000000000', 'pgtap-refresh-1', '00000000-0000-4000-8000-000000000005', false, now(), now(), '00000000-0000-4000-8000-0000000000e1');
select is(public.end_sessions('00000000-0000-4000-8000-000000000005'), 2, 'adm_end_sessions_counts_the_sessions');
select is((select count(*)::int from auth.sessions where user_id = '00000000-0000-4000-8000-000000000005') + (select count(*)::int from auth.refresh_tokens where token = 'pgtap-refresh-1'), 0,
  'adm_end_sessions_removes_sessions_and_refresh_tokens');
select is((select count(*)::int from auth.sessions where id = '00000000-0000-4000-8000-0000000000e3'), 1, 'adm_end_sessions_leaves_other_users');
-- C4: the old access token (issued before end_sessions) reads nothing through PostgREST or the snapshot; a new one does
select ok((select cut_at from public.session_cutoffs where user_id = '00000000-0000-4000-8000-000000000005') is not null, 'adm_end_sessions_writes_a_cutoff');
select tests.as_user_iat('00000000-0000-4000-8000-000000000005', 'aal1', extract(epoch from now())::bigint - 60);
select is((select count(*)::int from public.students) + (select count(*)::int from public.invoices), 0, 'adm_signed_out_everywhere_old_token_reads_nothing');
select is(public.my_snapshot()->>'status', 'session_ended', 'adm_signed_out_everywhere_old_token_snapshot_session_ended');
reset role;
select tests.as_user_iat('00000000-0000-4000-8000-000000000005', 'aal1', extract(epoch from now())::bigint + 5);
select ok((select count(*) from public.students) > 0, 'adm_signed_out_everywhere_new_sign_in_reads');
reset role;
select ok(not exists (select 1 from public.session_cutoffs where user_id = '00000000-0000-4000-8000-000000000006'), 'adm_cutoff_only_for_that_user');
set local role anon;
select throws_ok($$select public.end_sessions('00000000-0000-4000-8000-000000000006')$$, '42501', null, 'adm_anon_cannot_end_sessions');
reset role;
select tests.as_user('00000000-0000-4000-8000-000000000001');
select throws_ok($$select public.end_sessions('00000000-0000-4000-8000-000000000006')$$, '42501', null, 'adm_authenticated_cannot_end_sessions');
reset role;
select is((select array_agg(n.nspname || '.' || p.proname order by 1) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where p.prosecdef and n.nspname in ('public', 'app')), array['app.link_new_auth_user', 'public.end_sessions'], 'adm_definer_list_is_exactly_two');

-- C9: the account desk's audit rows (entity appUser) are the principal's; the accountant reads the rest of the log
insert into public.audit_log (id, doc) values ('aud-t-acct', jsonb_build_object('id', 'aud-t-acct', 'ts', '2026-10-03T05:00:00.000Z', 'actorRole', 'admin',
  'actorId', 'stf-principal', 'entity', 'appUser', 'entityId', '00000000-0000-4000-8000-000000000006', 'action', 'block', 'summary', 'parent sign-in blocked'));
select tests.as_user('00000000-0000-4000-8000-000000000003');
select is((select count(*)::int from public.audit_log where entity = 'appUser'), 0, 'adm_accountant_reads_no_account_desk_audit');
select ok((select count(*) from public.audit_log where entity <> 'appUser') > 0, 'adm_accountant_still_reads_the_rest_of_the_audit_log');
reset role;
select tests.as_user('00000000-0000-4000-8000-000000000001');
select ok((select count(*) from public.audit_log where entity = 'appUser') > 0, 'adm_principal_reads_account_desk_audit');
reset role;
select throws_ok($$update public.audit_log set doc = doc where id = 'aud-t-acct'$$, '42501', null, 'adm_audit_log_still_append_only');

-- the data-rights desk: written through persist; a parent reads their own, the principal all, a teacher none
select lives_ok($$select public.persist('pgtap-rights', 0, '{"upserts":{"dataRequests":[
  {"id":"drq-t-1","guardianId":"grd-02","kind":"export","details":"","status":"open","filedAt":"2026-10-03T05:00:00.000Z"},
  {"id":"drq-t-2","guardianId":"grd-01","kind":"correction","details":"fake","status":"open","filedAt":"2026-10-03T05:00:00.000Z"}]}}'::jsonb)$$, 'adm_persist_writes_data_requests');
select throws_ok($$insert into public.data_requests (id, doc) values ('drq-t-3', '{"id":"drq-t-3","guardianId":"grd-02","kind":"export","status":"in_progress"}')$$, '23505', null, 'adm_one_open_request_per_kind');
select throws_ok($$select public.persist('pgtap-rights', 1, '{"deletes":{"dataRequests":["drq-t-1"]}}'::jsonb)$$, '42501', null, 'adm_data_requests_never_deleted');
select tests.as_user('00000000-0000-4000-8000-000000000006');
select is((select array_agg(id order by id) from public.data_requests), array['drq-t-1'], 'adm_parent_reads_own_data_requests');
select is((select jsonb_agg(e->>'id') from jsonb_array_elements(public.my_snapshot()->'dataRequests') e), '["drq-t-1"]'::jsonb, 'adm_snapshot_data_requests_own_only');
reset role;
select tests.as_user('00000000-0000-4000-8000-000000000002');
select is((select count(*)::int from public.data_requests), 0, 'adm_teacher_reads_no_data_requests');
reset role;
select tests.as_user('00000000-0000-4000-8000-000000000001');
select is((select count(*)::int from public.data_requests where id like 'drq-t-%'), 2, 'adm_principal_reads_every_data_request');
reset role;
select is((public.load_slice('{dataRequests}'::text[], '{"exportGuardianId":"grd-01"}'::jsonb))->'db'->'dataRequests' @> '[{"id":"drq-t-2"}]'::jsonb
  and jsonb_array_length((public.load_slice('{dataRequests}'::text[], '{"exportGuardianId":"grd-01"}'::jsonb))->'db'->'dataRequests') = 1, true, 'adm_load_slice_data_requests_of_the_export_guardian');
select is((public.load_slice('{}'::text[], '{"callerUserId":"00000000-0000-4000-8000-000000000003"}'::jsonb))->'db'->'callerTwoStep', '{"enrolled": false, "required": false}'::jsonb, 'adm_load_slice_returns_caller_two_step');
select is((public.load_slice('{}'::text[], '{}'::jsonb))->'db'->>'schemaVersion', '3', 'adm_load_slice_schema_version_3');

select * from finish();
rollback;
