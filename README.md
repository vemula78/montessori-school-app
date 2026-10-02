# Little Acorns Montessori (Demo) — Phase 1 prototype

A working, single-school prototype of a Montessori preschool app: parent messaging and notices,
academic calendar with holiday-list CSV import, school-bus tracking (real GPS or a labelled
simulation), fee structures, invoices, receipts, refunds and reports, child attendance and a daily
diary. It runs entirely in the browser from static files (GitHub Pages), with **fake demo data only**.

> Prototype — demo data only. No real children, parents, staff, phone numbers or money are involved.

## Run it

Requires Node.js 20 or newer for the dev server and tests. There are **no dependencies** and no build step.

```sh
npm run serve      # static server → http://localhost:8080   (ES modules do not load from file://)
npm test           # unit + reconciliation tests (node --test, zero dependencies)
npm run scan       # fake-data and leak scan; exits 1 on any hit
```

On GitHub Pages the repository root is served as-is (`.nojekyll` is present; all paths are relative,
routing is hash-based, e.g. `#/parent/bus`).

## Demo personas

Pick a persona on the start screen; switch any time from the top bar. The persona lives in
`sessionStorage`, so two tabs can be two different people (e.g. Driver and Parent) at once.

| Persona | Try this |
|---|---|
| Principal — Kavita Exampleton | Calendar → import `data/holidays-2026-27.csv`; Notices → send to Primary A + Primary B with acknowledgement; recipients view |
| Teacher — Anita Demoson (Primary A) | Attendance (blocked on holidays/weekends with the reason), Daily diary, reply to parent threads |
| Accountant — Mohan Samplekar | Generate invoices, record cash/UPI payments, print an A5 receipt, cancel/refund, late fee apply/waive, Reports → Reconciliation |
| Driver — Sunil Samplekar / Imran Fakeswaran | Start a trip (real GPS or "simulated trip"), mark children boarded |
| Parent — Meena Notrealsen | Two children in two programs: one notice "about both children", one message thread per child |
| Parent — Priyanka Demoson | A bus child: live map, "nearing / arrived", boarded time; mock online payment |

All names are invented from an allow-listed set of obviously fake surnames; phones are
`+91-90000-00NNN`, emails `@example.com`, and the school and its locality are fictional.

## How it is built

```
src/domain/   pure functions (money, dates, fees, calendar, messaging, transport, …) — no DOM, no I/O
src/store/    schema (typedefs, createEmptyDb, SCHEMA_VERSION) + storage adapter (commit/rev, corruption, quota)
src/api/      the ONLY data module screens import — async, persona-scoped, returns clones
src/ui/       shell, router, screens, map, simulation runner
src/seed/     demo data, built by calling the real domain functions
```

- **Money** is integer paise everywhere; display uses Indian grouping (₹12,34,567.89) and receipts
  print the amount in words (lakh/crore).
- **Dates** are `YYYY-MM-DD` internally and shown as DD-MMM-YYYY; date strings are parsed by regex,
  never by `Date`, so nothing shifts a day in IST.
- **Every write** goes through `storage.commit()`: re-read the stored document, apply the command,
  bump `rev`, write. Receipt and invoice numbers come from the freshly read counter, so a stale tab
  never reuses a number (see Known limitations for truly simultaneous writes). Cancelled receipts keep
  their number; numbering is per academic year.
- **Reconciliation** (Accountant → Reports): five independent checks (per-student vs school totals,
  ledger vs invoice balances, payments = allocations + credit, no negative balances, report total =
  reconciled total). Mismatches are listed row by row.
- **Imports report counts**: the holiday CSV preview shows every row's status and line number;
  `inputRows = imported + skippedDuplicate + rejected` always holds.

## Prototype limitations (read before demoing)

Known limitations (fixed only by the backend):
- **Simultaneous writes from two tabs are not atomic.** Web Storage has no lock, so two tabs committing at
  the same instant can issue the same receipt number or lose one write; the backend uses a database
  transaction and sequence.
- **`api.getDb()` returns the whole unscoped database** to the page; persona scoping is applied only by
  the other `api.*` calls, and moves server-side with the backend.

- **Storage is `localStorage` in one browser.** Nothing is shared between devices or people. Use
  Settings → Export JSON for a backup; Reset to seed restores the demo. If stored data is corrupt it is
  copied aside (`montessori.db.corrupt.<timestamp>`) and never silently wiped. Browser storage is
  limited (~5 MB); when the browser refuses a write, that change is **not applied** (so a retry cannot
  record it twice) and the app asks you to export a backup and free space.
- **"Live" bus tracking is same-browser only.** Without a backend, the parent view updates from another
  tab of the same browser (or from the simulation running on the same phone). Cross-device live
  tracking needs the backend. Real GPS also needs a secure context (HTTPS or localhost); on a LAN
  `http://192.168…` address the driver screen explains why and offers the simulated trip instead.
- **Payments are mock.** "Pay online" records a payment stamped *MOCK ONLINE PAYMENT — NO MONEY
  MOVED*. There is no gateway; card data is never collected.
- **Map tiles** come from `tile.openstreetmap.org`. Tile requests carry only map coordinates of the
  fictional locality, never child data. OSM's tile usage policy allows light demo use only:
  **production must self-host tiles or use a paid tile provider.** Leaflet is vendored locally (no CDN
  script); the route, stops and bus marker still draw on a grey background when offline.
- Out of scope for this phase: photo/video sharing, staff attendance, admissions CRM, SMS/WhatsApp,
  multi-language, real login (OTP), payment gateway.

## Data protection (DPDP Act 2023)

This prototype holds **no personal data**: every record is fabricated, and `npm run scan` fails the
build if a surname is outside the fake allow-list, a phone or email is not in the fake pattern, or an
Aadhaar-like / mobile-shaped number, a real school name, or any network call (fetch, XHR or
beacon APIs) appears in the published files. There is no analytics or telemetry.

Before real children's data is entered, the production system needs: verifiable parental consent,
purpose limitation for bus tracking (location only during active trips, retention limits — the
prototype already drops trip positions after 30 days), per-child consent for any media sharing,
role-based access enforced server-side, audit logs for fee edits and refunds (already modelled), and a
legal review of the DPDP Act and its Rules for schools.

## Replacing the prototype storage with a backend

`src/api/index.js` is the seam. Screens import only `api` (plus the pure `money.js` and `dates.js`
formatters). To move to a server:

1. Keep every `api.*` signature and the `ApiError {code, message}` codes.
2. Replace each function body with an HTTP call to the backend; the domain modules in `src/domain/`
   (pure, tested) can run server-side unchanged, inside a database transaction instead of
   `storage.commit()`. Receipt/invoice numbers move to a database sequence.
3. Move persona scoping (what a parent/teacher/driver may read) from `api/` to the server; `session`
   becomes OTP login with the persona taken from the token.
4. Push trip positions to the server and stream them to parent devices — this is what makes bus
   tracking work across devices.

Nothing in `src/ui/` needs to change.
