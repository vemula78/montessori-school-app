-- Phase 3 audit fixes (forward-only: 0001–0005 are never edited).
--   C2  teachers no longer read consent rows (the rows carry evidence and the notice hash); the "no photo consent"
--       badge asks the command function (photos.consentStatus), which applies photoConsentFor server-side
--   C3  a parent sees a photo only while photo consent holds for the child: every guardian of the child with live
--       app_account consent also holds live photos consent, at the current notice version. A parent's RLS shows only
--       their own consent rows, so the verdict is kept per child in photo_consent_flags, recomputed by triggers on
--       consents and student_guardians (security invoker: only the service role and migrations write those tables).
--       When app.consent_version() changes in a later migration, that migration must refresh every flag.

-- ---------------------------------------------------------------- C2 consents: principal and the guardian only
drop policy read_scoped on public.consents;
create policy read_scoped on public.consents for select to authenticated using (
  case app.my_role()
    when 'admin' then true
    when 'parent' then guardian_id = app.my_guardian_id()
    else false end);
-- (my_snapshot's teacher branch from 0005 now selects nothing: RLS returns no consent row to a teacher)

-- ---------------------------------------------------------------- C3 photo consent per child
create table public.photo_consent_flags (
  student_id text primary key references public.students (id) on delete cascade,
  ok boolean not null,
  updated_at timestamptz not null default now()
);
alter table public.photo_consent_flags enable row level security;
alter table public.photo_consent_flags force row level security;
create policy read_scoped on public.photo_consent_flags for select to authenticated using (
  case app.my_role()
    when 'admin' then true
    when 'parent' then student_id = any(app.my_student_ids())
    else false end);

-- the SQL twin of photoConsentFor (src/domain/commands.js); pgTAP c3_* and tests-supabase/phase3 (C3) exercise the same cases
create function app.refresh_photo_consent(p_student_ids text[]) returns void language sql volatile security invoker set search_path = public, app, pg_temp as $$
  insert into public.photo_consent_flags as f (student_id, ok, updated_at)
  select s.id,
    exists (select 1 from public.consents c join public.student_guardians sg on sg.student_id = c.student_id and sg.guardian_id = c.guardian_id
            where c.student_id = s.id and c.purpose = 'app_account' and c.version = app.consent_version() and c.withdrawn_at is null)
    and not exists (select 1 from public.consents c join public.student_guardians sg on sg.student_id = c.student_id and sg.guardian_id = c.guardian_id
            where c.student_id = s.id and c.purpose = 'app_account' and c.version = app.consent_version() and c.withdrawn_at is null
              and not exists (select 1 from public.consents p where p.guardian_id = c.guardian_id and p.student_id = s.id and p.purpose = 'photos'
                              and p.version = app.consent_version() and p.withdrawn_at is null)),
    now()
  from public.students s where s.id = any(p_student_ids)
  on conflict (student_id) do update set ok = excluded.ok, updated_at = excluded.updated_at where f.ok is distinct from excluded.ok
$$;
create function app.photo_consent_changed() returns trigger language plpgsql security invoker set search_path = public, app, pg_temp as $$
begin
  perform app.refresh_photo_consent(array_remove(array[
    case when tg_op <> 'DELETE' then new.student_id end, case when tg_op <> 'INSERT' then old.student_id end], null));
  return null;
end $$;
create trigger photo_consent_on_consents after insert or update or delete on public.consents for each row execute function app.photo_consent_changed();
create trigger photo_consent_on_guardians after insert or update or delete on public.student_guardians for each row execute function app.photo_consent_changed();
-- a new student gets its flag (false) with its first guardian link; backfill every existing child now
select app.refresh_photo_consent(array(select id from public.students));

drop policy read_scoped on public.photos;
create policy read_scoped on public.photos for select to authenticated using (
  case app.my_role()
    when 'admin' then true
    when 'teacher' then exists (select 1 from public.students s where s.id = student_id and s.program_id = any(app.my_program_ids()))
    when 'parent' then status = 'ready' and student_id = any(app.my_student_ids())
      and exists (select 1 from public.observations o where o.id = observation_id and o.shared_at is not null)
      and exists (select 1 from public.photo_consent_flags f where f.student_id = photos.student_id and f.ok)
    else false end);

-- ---------------------------------------------------------------- grants
revoke all on public.photo_consent_flags from anon, authenticated;
grant select on public.photo_consent_flags to authenticated;
grant all on public.photo_consent_flags to service_role;
revoke all on function app.refresh_photo_consent(text[]), app.photo_consent_changed() from public, anon, authenticated;
grant execute on function app.refresh_photo_consent(text[]), app.photo_consent_changed() to service_role;
