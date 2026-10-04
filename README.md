# Kinfolk Montessori School — school app

A single-school Montessori preschool app: parent messaging and notices, academic calendar with holiday-list
CSV import, school-bus tracking, fee structures, invoices, receipts, refunds and reports, child attendance and
a daily diary. Two entry points share one codebase:

| Entry | What it is | Data |
|---|---|---|
| `index.html` (repository root) | **Public demo** — persona switcher, works offline, GitHub Pages | fake seed data in this browser's `localStorage` |
| `app/index.html` | **Real app** (Phase 2) — email-code sign-in, Supabase backend, Razorpay test mode, live bus across devices, push alerts | the school's Supabase project |

> The repository holds **fake data only**. No real children, parents, staff, phone numbers, keys or money.

## Run it

Requires Node.js 20+ (the tests use node's built-in runner; there are no npm dependencies and no build step).

```sh
npm run serve      # static server → http://localhost:8080 (demo at /, real app at /app/)
npm test           # unit, reconciliation, import and demo-mode api tests (node --test)
npm run scan       # fake-data, leak and secrets scan; exits 1 on any hit
```

On GitHub Pages the repository root is served as-is (`.nojekyll`; all paths relative; hash routing, e.g. `#/parent/bus`).

## Demo personas

Pick a persona on the start screen; switch any time from the top bar. The persona lives in `sessionStorage`,
so two tabs can be two different people (e.g. Driver and Parent) at once.

| Persona | Try this |
|---|---|
| Principal — Kavita Exampleton | Calendar → import `data/holidays-2026-27.csv`; Notices → send to Primary A + Primary B with acknowledgement; Learning → Curriculum → import `data/curriculum-sample.csv`, publish a submitted termly report |
| Teacher — Anita Demoson (Primary A) | Attendance (blocked on holidays/weekends with the reason), Daily diary, **Learning**: observations with a photo (a file from your device, or the drawn demo photos), share one, record progress, start a termly report; reply to parent threads |
| Accountant — Mohan Samplekar | Generate invoices, record cash/UPI payments, print an A5 receipt, cancel/refund, late fees, Reports → Reconciliation, data import |
| Driver — Sunil Samplekar / Imran Fakeswaran | Start a trip (real GPS or "simulated trip"), mark children boarded |
| Parent — Meena Notrealsen | Two children in two programs: one notice "about both children", one message thread per child; **Learning**: shared observations with photos and a published termly report to read and print (no progress grid) |
| Parent — Priyanka Demoson | A bus child: live map, "nearing / arrived", boarded time; mock online payment |

All names come from an allow-listed set of obviously fake surnames; phones are `+91-90000-00NNN`, emails
`@example.com`, and the school and its locality are fictional.

## How it is built

```
src/domain/   pure functions (money, dates, fees, calendar, messaging, transport, gateway, import, reminders, …)
              + commands.js: the ONE registry of write commands and their authorization
src/store/    schema (typedefs, createEmptyDb) + the demo's localStorage adapter (commit/rev, corruption, quota)
src/api/      the ONLY data module screens import: index.js (demo + mode selector), remote.js + supabase/ (real app)
src/ui/       shell, router, screens, map, simulation runner
src/seed/     demo data, built by calling the real domain functions; illustrations.js = the drawn demo photos (SVG)
supabase/     migrations (schema, RLS, snapshot, persist), pgTAP tests, Edge Functions, seed.sql (generated)
scripts/      dev server, scan, domain sync, seed/first-run SQL generators, mock gateway, e2e money check
```

- **Money** is integer paise everywhere; display uses Indian grouping (₹12,34,567.89); receipts print the amount in words.
- **Dates** are `YYYY-MM-DD` internally, shown as DD-MMM-YYYY, parsed by regex (never `Date`). Server code computes
  IST business dates explicitly (`dateInZone(ms, 330)`): Deno runs in UTC.
- **Reconciliation** (Accountant → Reports): five independent checks; mismatches listed row by row.
- **Imports report counts**: `inputRows = imported + skippedDuplicate + rejected` (holidays, curriculum) and
  `inputRows = ok + quarantined + duplicate` (children/fees); nothing is dropped without a reason.

### Learning (Phase 3): curriculum, observations, photos, progress, termly reports

- **Staff only until shared.** An observation (`api.observations.add`) is visible to the principal and the child's
  teachers; a parent sees it only after the teacher shares it (`sharedAt`). Shared text is frozen; a mistake is
  unshared (a teacher within 24 hours, the principal any time). The diary's "Add entry" no longer offers Observation
  (the diary is parent-visible by design); old diary observations still display.
- **Progress never reaches a parent directly.** Progress is append-only events per child and presentation (forward
  `introduced → practising → mastered`; backwards or repeated needs a correction with a reason). The family sees it
  only inside a **termly report** the principal published: a frozen copy (progress as of the term end with names
  copied in, plus the shared observations) at `#/print/report/:id`, A4, stamped DEMO in the demo.
- **Curriculum**: about 160 starter presentations in five areas (`src/domain/curriculum-starter.js`, generic material
  names, ages in months), loaded idempotently by key; the school's own list by CSV (`api.curriculum.previewCsv` then
  `importCsv`: preview shows counts that add up and every duplicate or rejected line with its reason; a repeat is
  never a silent update). Presentations are retired, never deleted.
- **Photos**: one child per photo (the teacher ticks "only this child is in the frame"), only with photo consent
  (every guardian using the app agrees, per child, at sign-up or in Settings). The browser shrinks to 1280 px and
  re-saves as JPEG (`src/ui/photo-prep.js`), which drops EXIF/GPS, and refuses rather than uploads if it cannot decode.
  Images are shown only as `URL.createObjectURL(blob)` from `api.photos.blob(id)` (revoked when the screen is left);
  no signed URL ever reaches the page. **Demo photos** are drawn SVGs of Montessori materials (no people) or a file
  you choose, kept in this browser's IndexedDB (`montessori.photos.v1`) only: never localStorage, the seed or git;
  Reset to demo data clears it.
- **Retention** (closes the Phase 2 deferred item): `school.retention` holds a period per category in months after
  `students.leftOn`; empty = not decided = nothing deleted. The principal sets them in Settings (real app); the daily
  job deletes what is due and reports counts. Photos also go when photo consent is withdrawn.
- Schema v2: `migrate()` upgrades a stored v1 document in the browser (new collections empty, `leftOn` null).

## Phase 2 / real app

The go-live handoff for the school — click-by-click, from creating the Supabase project to installing the app on
an iPhone — is **[docs/GO-LIVE.md](docs/GO-LIVE.md)**. This section is the technical summary.

### Architecture (one implementation of the rules)

- **Mode is bound to the entry HTML.** `app/index.html` loads `app/config.js` (public values only:
  `{supabaseUrl, supabaseAnonKey, vapidPublicKey, gatewayMode, appVersion}`), then the same `src/ui/app.js`.
  `src/api/index.js` exports `api = window.__APP_CONFIG__ ? await createRemoteApi(...) : demo api`: the demo never
  loads `remote.js` or supabase-js, the real app never loads the seed. A test asserts the root page and `src/ui/**`
  never mention the app config, a Supabase URL or `remote.js`.
- **Writes**: every write is a command in `src/domain/commands.js` (`slice`, `authorize`, `run`). The demo runs it inside
  `storage.commit()`; the real app posts `{name, args}` to the `command` Edge Function, which runs the **same**
  registry: load the slice (`public.load_slice`) → read the caller's role from `app_users` (never from JWT claims) →
  `authorize` → domain `run` → `public.persist(slice, expectedRev, changes)` in one transaction. If another writer
  committed the slice meanwhile, persist raises `CONFLICT` and the command is re-run on fresh data (jittered
  backoff, up to 25 attempts). Receipt/invoice/voucher numbers therefore come from the latest counters and are
  contiguous and never reused — 20 simultaneous payments get 20 consecutive numbers (tested). No SEQUENCE
  (sequences leave gaps); `UNIQUE` on receipt, invoice and voucher numbers as a second guard. Transport is guarded
  per route, so two buses never conflict.
- **The domain code runs unchanged in Deno**: `node scripts/sync-domain.mjs` copies `src/domain/*.js` (and
  `src/store/schema.js`) to `supabase/functions/_shared/`; `--check` (and the acceptance run) fails on any drift.
  **Edit `src/domain/`, never the copies, then run `npm run sync-domain`.**
- **Reads**: `public.my_snapshot()` (SECURITY INVOKER) returns the Phase 1 `Db` shape built under the caller's RLS —
  it cannot contain more than RLS allows. Windows: attendance 60 days, diary 30, trips 7 (events only, no positions).
  The same read functions as the demo run over it, so screens are unchanged. The snapshot is refetched after each
  own write, on realtime nudges (messages, notices, invoices, payments, trips; debounced 500 ms) and on tab focus.
- **Schema**: each entity is a JSONB `doc` (the Phase 1 shape) plus GENERATED key columns for RLS/indexes/uniqueness.
  Kept apart from the docs: health notes (`student_health`), staff phone/email (`staff_contacts`, admin only),
  guardian links (`student_guardians`, the RLS truth), trip hysteresis state (`trip_state`) and positions
  (`trip_positions`). `audit_log` is append-only for every role, including the service role (trigger + grants).

### Access model (RLS)

`anon`: nothing. `authenticated`: SELECT only, by role — admin all; accountant all but health notes; teacher own
programs' children, their guardians, threads, attendance, diary, no fees, no trips; driver own routes' children
(no health notes), own trips, nothing else; parent own guardian row and own children's names, and — **per child, only
with current `app_account` consent** — their invoices/payments/refunds/credits, notices/threads, attendance/diary and
routes, and trips/positions of those routes **only for a child with live `bus_live` consent**. Children's
boarding/drop-off events live in `trip_child_events` (a parent sees only their own child's), the student lists of
targeted notices and receipts in `notice_students` / `notice_receipt_students`, and calendar events by program
(migration `0003_audit_fixes.sql`). The one client write is `push_subscriptions` (own rows). Only `public.my_snapshot()` is
executable by users; `load_slice`/`persist` are service-role only; the only SECURITY DEFINER function is the
auth trigger that links a sign-in to a staff record by exact email **once the mailbox is confirmed**. pgTAP
(`supabase/tests/rls.test.sql`) asserts all of this, plus "no other definer functions", "no views without
security_invoker", append-only audit, unique receipt numbers, stale-rev rejection and the cron jobs.

### Sign-in, linking, consent (DPDP)

- **Email OTP** (6-digit code; template `supabase/templates/otp.html`, the same must be set in the dashboard).
  `api.auth.status()` → `state: 'signedOut' | 'unlinked' | 'pending' | 'active' | 'revoked' | 'withdrawn' | 'demo'`.
- **Parents** link with a single-use **invite code** (principal/accountant issue it; stored as SHA-256 only;
  14-day expiry; bound to one guardian; the redeemer must also enter one child's date of birth; failed attempts are
  audited and limited to 5 per hour per sign-in, and a code locks after 5 wrong dates of birth from any sign-ins).
  **Staff** are linked automatically when they first confirm the email on their staff record (email confirmation must
  stay ON: `enable_confirmations` locally, "Confirm email" in the dashboard); a password set on that address before it
  was confirmed is voided at confirmation. Revoking a user or withdrawing app consent cuts access on the next request.
- **Consent** per (guardian, child, purpose, notice version) for `app_account` (required), `push`, `bus_live`, `photos`
  (all optional and never pre-ticked; the sign-up screen asks photos per child when a parent has several), notice v2, with the
  SHA-256 of the notice text the parent saw and the evidence `invite_code+child_dob+email_otp`. Withdrawal is live
  (RLS evaluates consent at query time); withdrawing `app_account` disables the account and opens an erasure request.
  Until `app_account` is given for a child the server neither returns that child's data nor runs parent commands for
  them (only consent itself, invite redemption and the data export). A parent can download their own data
  (`api.admin.dataExport(ownGuardianId)`: children, fees, messages, attendance, diary, the children's boarding/drop-off
  events, sign-in links, invites, erasure requests, reminders, push devices (service only), payment orders and raw
  import rows). The principal can export or erase any guardian: name, phone, email, relation, the guardian's own
  messages, their columns in import rows, their sign-ins (deleted), push devices and payer details in stored gateway
  events are erased; fee records, the children's school records, staff messages, consent records and audit rows are
  kept, and the erasure request records both lists. The request stays `cleanup` until the sign-in deletion and gateway
  scrubbing succeed (cron-daily retries them), then `done`. Exports and invites are audited.

### Administration (principal) and My account

- **Password is optional**: the emailed code stays the default sign-in. Anyone can set or change a password under **Account**
  (`api.auth.setPassword`, at least 8 characters), use it from the sign-in page (*Use a password*), and reset it with an emailed
  recovery code (*Forgot password*). The principal never sees or sets anyone's password.
- **Two-step sign-in (TOTP)** for the principal and accountant: set up under Account (the key and the `otpauth://` link are shown
  as text, no QR library), then every sign-in needs the app's 6-digit code. `src/api/totp.js` is the pure RFC 6238 implementation
  (WebCrypto, runs in browsers and Node 20+). A principal or accountant who has set it up sees only the two-step screen until the
  code is entered (`api.auth.status()` → `state: 'two_step_required'`; `'blocked'` for a blocked account).
- **Administration** (`#/admin`, principal): *Accounts* (block / unblock, sign out everywhere, change sign-in email, invites, reset
  two-step), *Oversight* (sign-in activity, change history, who can see a child, the permission matrix), *Data requests* (the DPDP
  desk: parents file export / erasure / correction requests under Account; the principal answers; closing needs an answer and is
  final), *Announcement* (one plain-text banner, 280 characters, shown to everyone) and *Two-step policy*.
- **In the demo** the same registry commands and domain reads run, with these stand-ins (all cleared by *Reset to demo data*):
  a password is a per-persona SHA-256 in `sessionStorage` (`montessori.demo-password.v1`; recovery by email is real-app-only);
  two-step is real TOTP against a per-persona secret in `sessionStorage` with a **demo authenticator** panel showing the live code;
  a block is a flag in `localStorage` (`montessori.accounts.v1`) that the persona switcher honours; sign-in activity is the persona
  switches made in this tab.

### Payments (Razorpay test mode)

`pay-create-order` computes the amount from current invoice balances (a client amount can only lower it, ≥ ₹100;
≤ 10 order attempts per user per hour, counted atomically before the gateway call; a unique receipt per order) → Razorpay Checkout (the one external script, loaded only on the real app's pay screen)
→ `pay-verify` (HMAC of `order_id|payment_id`, constant-time; amount re-read from Razorpay) → the single idempotent
ledger step `fees.recordGatewayPayment` (allocation recomputed at capture; anything not owed becomes credit; a
captured amount that differs from the order is recorded and flagged). The webhook (`rzp-webhook`, signature over
the raw body, each event id stored once so replays are no-ops) and `pay-status` (on tab focus, if the browser closed
before verify) use the same step, so a capture is never recorded twice. Dashboard refunds arrive as `refund.*`
events and are booked only once the gateway has **processed** them (pending waits, failed never books), split across
the payment's allocations (largest first), then its unused credit, then invoices that its credit was later applied to;
a refund that arrives before its capture is held `pending` and applied when the capture lands; a refund already
recorded by hand with the `rfnd_…` id as reference is not booked again (and vice versa). A gateway capture cannot be
cancelled in the app — the money goes back only as a refund. An event stored but never processed is picked up by
its redelivery or by the daily job. Receipts of test-mode payments are stamped
**TEST MODE — NO MONEY MOVED**; the demo's mock payment is refused by the server. Settlement reports (CSV from the
Razorpay dashboard) are imported idempotently (a line that conflicts with a stored one is rejected, not skipped) and
joined to the ledger with unmatched rows listed on both sides, a payment settled more than once flagged, payment
lines checked `gross = net + fee + tax`, refund lines `debit = refund + fee + tax`, and net to bank after refunds.
The payment functions refuse to work if the key prefix (`rzp_test_` / `rzp_live_`) disagrees with `APP_GATEWAY_MODE`.

### Live bus, alerts, daily job

- The driver's phone posts each GPS fix as `transport.recordPosition`; events (nearing/arrived/departed) are derived
  **on the server** by the Phase 1 hysteresis code. Parents receive positions and trip events through Realtime
  `postgres_changes`, authorized by RLS per subscriber (tested: a parent of another route, or one who withdrew
  `bus_live`, receives nothing).
- **Web Push** (VAPID, aes128gcm) after each commit to guardians with `push` consent **for the child concerned, at
  the current notice version** (plus `bus_live` for bus events): bus nearing/arrived at their child's stop,
  boarded/dropped/absent, payment received, important notices, fee reminders. Only https endpoints of the known push
  services are contacted (no redirects, 10 s timeout); any other subscription is deleted, as is one answering 404/410
  or failing 5 times. iOS needs the app added to the Home Screen (16.4+).
- **`cron-daily`** (pg_cron 08:00 IST → pg_net, secret from Vault): fee reminders at T−3, due day, +7, +14 of the
  effective due date (claimed atomically, marked sent only after delivery, a failed push retried by the next run; in-app
  list = `api.reminders.list()`), the late-fees-due list (computed, **never applied automatically**; the accountant
  applies them in one batch with `api.fees.applyLateFees`), retries of gateway events that errored, are pending or were
  left unprocessed, ending trips left running > 3 h (also every 15 minutes: job `cron-trips`, body
  `{"steps":["trips"]}`), counting trips with no fix for 20 min, pruning positions older than 30 days, counting expired
  invites, and pruning request ids (7 days). Every list is read page by page (no 1000-row cap).
- Phone limits: a web app cannot track in the background and iOS pauses it when the screen locks — keep the screen
  on (Wake Lock), dashboard-mounted phone, app installed. A native Android driver app or a ₹2–3k GPS tracker is a
  Phase 3 option.

### Data import from the previous system

CSV (Excel → Save As CSV): the browser parses (`api.import.parseCsv`), the user maps columns (suggested by
`api.import.suggestMapping`), then `stage → preview → commit`. Children rows are checked strictly (dates day-first,
phones normalised to `+91…`, programs must exist, stops resolved by name), duplicates by admission number against
the app and within the file (a conflicting duplicate is quarantined, never guessed; an existing child whose status,
transport or guardians differ is a conflict, not a duplicate), siblings share one guardian (matched by phone/email;
every phone/email of a guardian must point at the same person, a name clash is quarantined, and a newly seen phone or
email of a matched guardian is kept as an alias and saved where the guardian had none). A row with more fields than
headers (an unquoted comma) is quarantined. Opening balances are keyed by student, academic year and installment. Fees rows become one **"Opening balance (carried from previous
system)"** invoice per student per installment; historical receipts are not recreated. Every report carries
`inputRows = ok + quarantined + duplicate` and `Σ opening balances imported = Σ source outstanding`; re-importing the
same file marks every imported row `duplicate (batch …)`. Mapping presets use generic names only.

### First run of a new project

After `supabase db push`, the database is empty. Create the school profile, academic year(s), programs, fee heads,
staff (at least the principal, with the email they will sign in with) and optional bus routes in one step:

```sh
cp supabase/first-run.example.json first-run.json        # gitignored: holds the school's real details
# edit first-run.json, then:
node scripts/first-run-sql.mjs first-run.json > first-run.sql
# Supabase dashboard → SQL Editor → paste first-run.sql → Run (once; a second run fails with CONFLICT and changes nothing)
```

The generator validates everything with the app's own checks before printing SQL; the SQL goes through
`public.persist()` like every other write and links any staff sign-in that already exists (confirmed mailbox only).
Every staff member, drivers included, needs an email: it is how they sign in. Fee structures,
families and opening balances are then added in the app (or by CSV import).

### Develop and test locally (Docker / Colima, Supabase CLI)

```sh
supabase start                                   # first time pulls the images
supabase db reset                                # migrations + generated seed (6 fake sign-ins, see below)
node scripts/mock-razorpay.mjs --write-env       # once: invents LOCAL test secrets in supabase/.env.local (gitignored)
                                                 # (an older .env.local needs PUSH_TEST_ORIGINS=<RAZORPAY_API_BASE> added)
npm run functions                                # supabase functions serve --env-file supabase/.env.local
supabase test db                                 # pgTAP: RLS matrix and ledger guards
npm run test:supabase                            # Edge Function HTTP tests + realtime test (starts the mock gateway)
npm run e2e                                      # money scenarios → reconcile() on the snapshot + SQL second path
```

Local sign-ins (OTP arrives in Mailpit, http://127.0.0.1:54324): `principal@`, `teacher-pa@`, `accountant@`,
`driver1@`, `parent-siblings@`, `parent-bus@example.com`. `npm run e2e` also prints two unredeemed invite codes.
The mock gateway listens on port 54399; Docker reaches it at `http://host.lima.internal:54399` (Colima; use
`host.docker.internal` otherwise) via `RAZORPAY_API_BASE`. After editing `src/seed/seed-data.js` run
`npm run seed-sql`; after editing `src/domain/` run `npm run sync-domain`.

For `app/` against the local stack, put the local URL and anon key in `app/config.local.js` (gitignored; loaded on
localhost only).

### api errors

Every `api.*` call rejects with `ApiError {code, message}`: the Phase 1 codes (`NOT_ALLOWED`, `NOT_FOUND`,
`VALIDATION`, `INVALID_AMOUNT`, `OVERPAYMENT_NOT_ALLOWED`, `INVOICE_LOCKED`, `NOT_WORKING_DAY`, `STORAGE_CORRUPT`,
`STORAGE_QUOTA`) plus, in the real app, `UNAUTHENTICATED` (sign in again), `CONFLICT` (too many simultaneous
writers; nothing saved), `OFFLINE` (the server could not be reached or did not answer in time — nothing may have
been saved; check and retry), `RATE_LIMITED`, `GATEWAY` (payment provider problem) and `INTERNAL`. Real-app-only
features called in the demo reject with `NOT_ALLOWED` and a message saying so. In the real app every `/command` call
must carry a request id (400 without one), bound to its arguments (409 if reused with others) and replayed only to a
caller who still has access: an unanswered write is retried once with the same id, and the server returns the stored result for a
repeated id, so a retry never records a payment or refund twice; a write that was saved is not reported as failed
when the refetch afterwards fails. Business dates ("today") are IST on every device.

### Dependencies

None in node. Inside the Edge Functions (Deno) exactly one: **`npm:web-push@3.6.7`** (VAPID signing and aes128gcm
payload encryption; hand-rolling RFC 8291 is ~200 lines of crypto). The browser uses the vendored
`vendor/supabase/supabase-js.esm.js` (see its `VERSION`) and Razorpay's Checkout script, which cannot be self-hosted.

### Costs and limits (verify current pricing before go-live)

Supabase Free: 500 MB database, 5 GB egress, 500k function calls, Realtime 200 concurrent; **it pauses after 7 days
without activity and has no backups** — move to Pro (about $25/month) **before real families are onboarded**; during
a pilot take a weekly `supabase db dump`. Expected use for ~70 children: ~60k function calls and ~10 MB of positions
per month after pruning. Razorpay: no setup fee, about 2% + GST on cards/netbanking (UPI often 0% — check the
pricing page); settlement T+2; live mode needs the school's registration documents (KYC). SMS/WhatsApp alerts are
not built (DLT registration and per-message cost); phone OTP likewise — the school's call. Project region: Mumbai
(ap-south-1).

## Data protection (DPDP Act 2023)

The repository holds no personal data: every record is fabricated, and `npm run scan` fails if a surname is outside
the fake allow-list, a phone or email is not in the fake pattern, an Aadhaar-like / mobile-shaped number or the previous
vendor's or hospital's name appears, a published file other than the real-app api makes a network call, or anything that looks like
a key or secret (JWTs, Supabase secret keys, Razorpay key + secret, private keys) or a `.env` file would be committed.

The real app minimises data (no Aadhaar, no addresses — stop names only; photos only with per-child consent, one child
per photo, in a private bucket, deleted when consent is withdrawn or per the retention period; health notes visible to the
principal, the child's teacher and parents only; staff phones to the principal only; positions are the bus's and are
kept 30 days), records consent per purpose, audits every write, and supports access (export) and erasure
(erasure of the guardian's details, messages, sign-ins, devices and raw import/gateway copies, keeping the legally
retained fee ledger; what is kept is recorded on the request). Retention defaults (fee ledger 8 years; messages, diary,
attendance 1 year after a child leaves; positions 30 days; audit log for the life of the system) and the DPDP Rules
timeline must be confirmed by the school's legal adviser.

## Known limitations

- **Demo only**: the demo keeps everything in one browser's `localStorage`; simultaneous writes from two tabs are
  not atomic and `api.getDb()` returns the whole (fake) document. The real app has neither limit (server
  transactions; RLS-scoped snapshot).
- **Map tiles** come from `tile.openstreetmap.org`, whose policy allows light demo use only: production must
  self-host tiles or use a tile provider (e.g. MapTiler's free tier). Tile requests carry map coordinates only.
- **Settlement CSV columns** follow the dashboard export as documented; verify against a real export before go-live.
- **Background tracking** is impossible for a web app (see Live bus). Demo photos from a chosen file live in one
  browser only (a different browser or a reset shows "not stored in this browser"). Out of scope: video, staff
  attendance, admissions CRM, SMS/WhatsApp, multi-language, XLSX import (save as CSV).
