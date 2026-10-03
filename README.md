# Little Acorns Montessori (Demo) — school app

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
| Principal — Kavita Exampleton | Calendar → import `data/holidays-2026-27.csv`; Notices → send to Primary A + Primary B with acknowledgement |
| Teacher — Anita Demoson (Primary A) | Attendance (blocked on holidays/weekends with the reason), Daily diary, reply to parent threads |
| Accountant — Mohan Samplekar | Generate invoices, record cash/UPI payments, print an A5 receipt, cancel/refund, late fees, Reports → Reconciliation, data import |
| Driver — Sunil Samplekar / Imran Fakeswaran | Start a trip (real GPS or "simulated trip"), mark children boarded |
| Parent — Meena Notrealsen | Two children in two programs: one notice "about both children", one message thread per child |
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
src/seed/     demo data, built by calling the real domain functions
supabase/     migrations (schema, RLS, snapshot, persist), pgTAP tests, Edge Functions, seed.sql (generated)
scripts/      dev server, scan, domain sync, seed/first-run SQL generators, mock gateway, e2e money check
```

- **Money** is integer paise everywhere; display uses Indian grouping (₹12,34,567.89); receipts print the amount in words.
- **Dates** are `YYYY-MM-DD` internally, shown as DD-MMM-YYYY, parsed by regex (never `Date`). Server code computes
  IST business dates explicitly (`dateInZone(ms, 330)`): Deno runs in UTC.
- **Reconciliation** (Accountant → Reports): five independent checks; mismatches listed row by row.
- **Imports report counts**: `inputRows = imported + skippedDuplicate + rejected` (holidays) and
  `inputRows = ok + quarantined + duplicate` (children/fees); nothing is dropped without a reason.

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
(no health notes), own trips, nothing else; parent own guardian row, own children and their invoices/payments/
refunds/credits, own notices/threads, own children's routes, and trips/positions of those routes **only with live
`bus_live` consent**. The one client write is `push_subscriptions` (own rows). Only `public.my_snapshot()` is
executable by users; `load_slice`/`persist` are service-role only; the only SECURITY DEFINER function is the
sign-up trigger that links a new auth user to a staff record by exact email. pgTAP (`supabase/tests/rls.test.sql`)
asserts all of this, plus "no other definer functions", "no views without security_invoker", append-only audit,
unique receipt numbers, stale-rev rejection and the cron job.

### Sign-in, linking, consent (DPDP)

- **Email OTP** (6-digit code; template `supabase/templates/otp.html`, the same must be set in the dashboard).
  `api.auth.status()` → `state: 'signedOut' | 'unlinked' | 'pending' | 'active' | 'revoked' | 'withdrawn' | 'demo'`.
- **Parents** link with a single-use **invite code** (principal/accountant issue it; stored as SHA-256 only;
  14-day expiry; bound to one guardian; the redeemer must also enter one child's date of birth; failed attempts are
  audited and limited to 5 per hour). **Staff** are linked automatically when they first sign in with the email on
  their staff record. Revoking a user or withdrawing app consent cuts access on the next request.
- **Consent** per (guardian, child, purpose, notice version) for `app_account` (required), `push`, `bus_live`, with the
  SHA-256 of the notice text the parent saw and the evidence `invite_code+child_dob+email_otp`. Withdrawal is live
  (RLS evaluates consent at query time); withdrawing `app_account` disables the account and opens an erasure request.
  A parent can download their own data (`api.admin.dataExport(ownGuardianId)`); the principal can export or
  anonymise any guardian (ledger numbers and amounts are retained). Exports and invites are audited.

### Payments (Razorpay test mode)

`pay-create-order` computes the amount from current invoice balances (a client amount can only lower it, ≥ ₹100;
≤ 10 orders per user per hour) → Razorpay Checkout (the one external script, loaded only on the real app's pay screen)
→ `pay-verify` (HMAC of `order_id|payment_id`, constant-time; amount re-read from Razorpay) → the single idempotent
ledger step `fees.recordGatewayPayment` (allocation recomputed at capture; anything not owed becomes credit; a
captured amount that differs from the order is recorded and flagged). The webhook (`rzp-webhook`, signature over
the raw body, each event id stored once so replays are no-ops) and `pay-status` (on tab focus, if the browser closed
before verify) use the same step, so a capture is never recorded twice. Dashboard refunds arrive as `refund.*`
events and are split across the payment's allocations (largest first) then its credit; a refund that arrives before
its capture is held `pending` and applied when the capture lands. Receipts of test-mode payments are stamped
**TEST MODE — NO MONEY MOVED**. Settlement reports (CSV from the Razorpay dashboard) are imported idempotently and
joined to the ledger with unmatched rows listed on both sides and `Σ gross = Σ net + Σ fee + Σ tax` checked.
The payment functions refuse to work if the key prefix (`rzp_test_` / `rzp_live_`) disagrees with `APP_GATEWAY_MODE`.

### Live bus, alerts, daily job

- The driver's phone posts each GPS fix as `transport.recordPosition`; events (nearing/arrived/departed) are derived
  **on the server** by the Phase 1 hysteresis code. Parents receive positions and trip events through Realtime
  `postgres_changes`, authorized by RLS per subscriber (tested: a parent of another route, or one who withdrew
  `bus_live`, receives nothing).
- **Web Push** (VAPID, aes128gcm) after each commit to guardians with `push` consent: bus nearing/arrived at their
  child's stop, boarded/dropped/absent, payment received, important notices, fee reminders. A subscription answering
  404/410 or failing 5 times is deleted. iOS needs the app added to the Home Screen (16.4+).
- **`cron-daily`** (pg_cron 08:00 IST → pg_net, secret from Vault): fee reminders at T−3, due day, +7, +14 of the
  effective due date (deduped; in-app list = `api.reminders.list()`), the late-fees-due list (computed, **never
  applied automatically**; the accountant applies them in one batch with `api.fees.applyLateFees`), retries of
  gateway events that errored or are pending, ending trips left running > 3 h (and counting trips with no fix for
  20 min), pruning positions older than 30 days, and counting expired invites (expired codes are refused at redemption).
- Phone limits: a web app cannot track in the background and iOS pauses it when the screen locks — keep the screen
  on (Wake Lock), dashboard-mounted phone, app installed. A native Android driver app or a ₹2–3k GPS tracker is a
  Phase 3 option.

### Data import from the previous system

CSV (Excel → Save As CSV): the browser parses (`api.import.parseCsv`), the user maps columns (suggested by
`api.import.suggestMapping`), then `stage → preview → commit`. Children rows are checked strictly (dates day-first,
phones normalised to `+91…`, programs must exist, stops resolved by name), duplicates by admission number against
the app and within the file (a conflicting duplicate is quarantined, never guessed), siblings share one guardian
(matched by phone/email; a name clash is quarantined). Fees rows become one **"Opening balance (carried from previous
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
`public.persist()` like every other write and links the principal's sign-in if it already exists. Fee structures,
families and opening balances are then added in the app (or by CSV import).

### Develop and test locally (Docker / Colima, Supabase CLI)

```sh
supabase start                                   # first time pulls the images
supabase db reset                                # migrations + generated seed (6 fake sign-ins, see below)
node scripts/mock-razorpay.mjs --write-env       # once: invents LOCAL test secrets in supabase/.env.local (gitignored)
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
features called in the demo reject with `NOT_ALLOWED` and a message saying so.

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
the fake allow-list, a phone or email is not in the fake pattern, an Aadhaar-like / mobile-shaped number or a real
school name appears, a published file other than the real-app api makes a network call, or anything that looks like
a key or secret (JWTs, Supabase secret keys, Razorpay key + secret, private keys) or a `.env` file would be committed.

The real app minimises data (no Aadhaar, no photos, no addresses — stop names only; health notes visible to the
principal, the child's teacher and parents only; staff phones to the principal only; positions are the bus's and are
kept 30 days), records consent per purpose, audits every write, and supports access (export) and erasure
(anonymisation keeping the legally retained fee ledger). Retention defaults (fee ledger 8 years; messages, diary,
attendance 1 year after a child leaves; positions 30 days; audit log for the life of the system) and the DPDP Rules
timeline must be confirmed by the school's legal adviser.

## Known limitations

- **Demo only**: the demo keeps everything in one browser's `localStorage`; simultaneous writes from two tabs are
  not atomic and `api.getDb()` returns the whole (fake) document. The real app has neither limit (server
  transactions; RLS-scoped snapshot).
- **Map tiles** come from `tile.openstreetmap.org`, whose policy allows light demo use only: production must
  self-host tiles or use a tile provider (e.g. MapTiler's free tier). Tile requests carry map coordinates only.
- **Settlement CSV columns** follow the dashboard export as documented; verify against a real export before go-live.
- **Background tracking** is impossible for a web app (see Live bus). Out of scope: photo/video sharing, staff
  attendance, admissions CRM, SMS/WhatsApp, multi-language, XLSX import (save as CSV).
