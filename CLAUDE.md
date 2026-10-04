# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Single-school Montessori preschool app. Vanilla ES modules, **no build step, no npm dependencies**. Two entry points share one codebase: root `index.html` is the public demo (fake data in `localStorage`, persona switcher, GitHub Pages); `app/index.html` is the real app (Supabase backend, Razorpay test mode). `README.md` is the detailed technical reference; `docs/GO-LIVE.md` is the user's click-by-click cloud setup.

## Commands

```sh
npm run serve                          # static server, default port 8080 (demo at /, real app at /app/)
node scripts/serve.mjs 8090            # port 8080 is often taken on this machine by an SSH tunnel
npm test                               # node --test "tests/*.test.mjs" (demo-mode + domain + import tests)
node --test tests/fees.test.mjs        # one file
node --test --test-name-pattern="#17" "tests/*.test.mjs"   # one test by name
npm run scan                           # fake-data / real-name / secrets / network-call scan; exits 1 on any hit
npm run check-domain                   # fails if supabase/functions/_shared copies drifted from src/domain
```

Backend (Docker via Colima + Supabase CLI; all local, fake data, local test secrets in gitignored `supabase/.env.local`):

```sh
supabase start && supabase db reset    # migrations + generated supabase/seed.sql
node scripts/mock-razorpay.mjs --write-env   # once: invent local gateway/webhook secrets
npm run functions                      # supabase functions serve --env-file supabase/.env.local
supabase test db                       # pgTAP: supabase/tests/rls.test.sql (RLS matrix, ledger guards)
npm run test:supabase                  # Edge Function HTTP + realtime tests (needs functions serve + mock gateway on 54399)
npm run e2e                            # money scenarios through the functions → reconcile() + SQL second path
```

Local sign-ins are `principal@ teacher-pa@ accountant@ driver1@ parent-siblings@ parent-bus@example.com`; the OTP arrives in Mailpit (http://127.0.0.1:54324). Docker reaches the host mock gateway at `http://host.lima.internal:54399`. For `/app/` locally, put the local URL + anon key in gitignored `app/config.local.js`.

## Regenerate after editing

- `src/store/schema.js`, `src/domain/**` and the starter list also feed `supabase/seed.sql`: run `npm run seed-sql` after changing the seed (consents come from `scripts/seed-sql.mjs`; demo photo rows are left out of the SQL seed).

- `src/domain/**` or `src/store/schema.js` → `npm run sync-domain` (Deno can't import `src/`; the Edge Functions run synced copies in `supabase/functions/_shared/`). **Never edit the copies.**
- `src/seed/seed-data.js` → `npm run seed-sql` (rebuilds `supabase/seed.sql`).

## Architecture

- **Layers**: `src/domain/` pure functions (no DOM, no I/O) → `src/store/` (schema typedefs, demo localStorage adapter with commit/rev) → `src/api/` (the only data module screens may import) → `src/ui/` (shell, hash router, screens). Screens import `api` plus the `money`/`dates` display helpers only.
- **One implementation of every write**: `src/domain/commands.js` is the registry (`slice`, `authorize(persona, db, args)`, `run(db, args, ctx)`). The demo runs commands inside `storage.commit()`; the real app posts `{name, args}` to the `command` Edge Function, which runs the same registry: `public.load_slice` → role read from `app_users` (never JWT claims) → `authorize` → `run` → `public.persist(slice, expectedRev, changes)` in one transaction, retried on `CONFLICT`. This is what makes receipt/invoice numbers contiguous without a SEQUENCE. New writes go in the registry, not in `api/` or SQL.
- **Learning (Phase 3)**: collections `presentations, observations, photos, progressEvents, reports` (+ `consents` in the document, `students.leftOn`, `school.retention`); schema v2 with a real `migrate()` in `src/store/storage.js` (DB_KEY unchanged). Commands are slice `learning`. Observations are staff-only until `sharedAt`; parents never see progress except inside a published, frozen `reports` row. Photos are metadata rows; bytes are a Storage object (real app, signed URLs minted server-side) or an SVG illustration / IndexedDB blob (demo, `src/api/demo-photos.js`). The UI shows photos only through `URL.createObjectURL(blob)` from `api.photos.blob(id)`; never put a URL in the DOM.
- **Mode is bound to the entry HTML**, never a runtime toggle: `src/api/index.js` exports the remote api when `window.__APP_CONFIG__` exists (set by `app/config.js`), else the demo api. `src/ui/**` and root `index.html` must never mention the app config, Supabase or `remote.js` (a test asserts it); UI checks `api.mode`.
- **Reads in the real app**: `public.my_snapshot()` (SECURITY INVOKER) returns the demo's `Db` shape filtered by RLS, so screens and domain read functions are identical in both modes. Tables store each entity as a JSONB `doc` plus generated key columns; sensitive fields live in separate tables (`student_health`, `staff_contacts`, `student_guardians`, `trip_state`, `trip_positions`).
- **RLS is the security boundary** (the anon key is public): `anon` gets nothing; `authenticated` is SELECT-only by role; `load_slice`/`persist` are service-role only; the only SECURITY DEFINER function is the sign-up trigger. pgTAP fails on any other definer function or a view without `security_invoker`.
- **Payments**: amount always computed server-side from invoice balances; `pay-verify`, `rzp-webhook` and `pay-status` all funnel into the one idempotent `fees.recordGatewayPayment` (keyed on gateway payment id; webhook event ids stored once).
- **Transport**: driver posts fixes as `transport.recordPosition`; stop events are derived server-side by the domain hysteresis code; parents receive Realtime `postgres_changes` authorized by RLS and live `bus_live` consent.

## Invariants the tests and scan enforce

- Money is integer paise (`assertPaise`); display via `formatPaise` (Indian grouping). Percentages in basis points.
- Dates are `YYYY-MM-DD` strings parsed by regex; `Date.parse(` / `new Date(<string>)` in `src/domain` fails a lint test. Server code computes IST business dates with `dateInZone(ms, 330)` (Deno runs in UTC).
- Imports/transforms report counts that add up (`inputRows = ok + quarantined + duplicate`, holidays `= imported + skippedDuplicate + rejected`); rejected rows carry line + reason.
- Colours and fonts in `app.css` come from its `:root` tokens (the Kinfolk design system, `docs/DESIGN-SYSTEM.md`); add a token there, with its contrast, before using a new colour. Places that cannot read CSS variables repeat the hex values and must be kept in step: `src/ui/map.js` (route lines), `src/ui/screens/pay-online.js` (Razorpay theme), the `theme-color` meta in both HTML files, `app/manifest.webmanifest`, `app/icons/icon.svg`; `src/ui/print.css` is black on white by design.
- Every interpolated value in UI templates goes through `esc()` (`src/ui/components.js`), numbers included.
- `fetch(` is allowed only in `src/api/remote*.js` and `src/api/supabase/**`. The only external script is Razorpay Checkout, loaded only on the real app's pay screen; supabase-js and Leaflet are vendored.
- Demo photos are drawn SVGs (`src/seed/illustrations.js`, materials only, numbers of at most three digits so the scan's phone/Aadhaar rules cannot match) or an IndexedDB blob; no binary image is committed outside `tests/fixtures/`. Curriculum names are generic material names.
- **Fake data only, public repo**: seed surnames must come from `FAKE_SURNAMES`, phones `+91-90000-00NNN`, emails `@example.com`. The previous vendor's name and domain must never appear in tracked files — the scan checks them by SHA-256 hash, so don't add them in plain text anywhere (including tests, comments, import-mapping presets). The school's own name, Kinfolk Montessori School, is used openly (owner's decision, 03-Oct-2026); the demo's people, addresses and money stay fake, its school name keeps "(Demo)", its fee heads say "(sample)", and every demo receipt carries a DEMO stamp.
- Local-only, gitignored planning records: `PLAN.md`, `PLAN-PHASE2.md`, `PLAN-REVIEW-LOG.md` (append-only audit/disposition log), `school-app-feature-list.md`. Keep them out of git; they contain local paths and real names.

## Deploy

GitHub Pages serves the repo root from `main` as-is (`.nojekyll`, relative paths, hash routing). Pushing `main` deploys the demo and the `app/` shell; the backend is deployed separately per `docs/GO-LIVE.md` (`supabase db push`, `supabase functions deploy`, secrets set by the user).
