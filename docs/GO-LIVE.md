# Go-live handoff: from the demo to the real school app

This is a click-by-click guide for the person who will switch the real app on. You do not need to be a
developer, but you will paste a few commands into the Terminal on a Mac. Allow about two hours.
Do the steps **in order**. Work on **test settings first** (no real money, no real parents) and only do step 12
when the school is ready.

The public demo at the site root keeps working the whole time. The real app lives in the `app/` folder and
opens at the same address with `/app/` added.

## Read this first: what is secret and what is not

| Value | Public or secret | Where it goes |
|---|---|---|
| Supabase **Project URL** | public | `app/config.js` |
| Supabase **anon public** key (long text starting `eyJ...`, or `sb_publishable_...`) | public | `app/config.js` |
| VAPID **public** key | public | `app/config.js` |
| Supabase **service_role** key (or any key starting `sb_secret_`) | **SECRET - never copy it anywhere** | nowhere. You will never need it. |
| Supabase **database password** | secret | your password manager only |
| Razorpay **Key ID** | semi-public (it is shown to the payer's browser) | step 8 secrets |
| Razorpay **Key Secret** | **secret** (shown once) | step 8 secrets, password manager |
| Razorpay **webhook secret** | **secret** | step 6 and step 8, password manager |
| VAPID **private** key | **secret** | step 8 secrets, password manager |
| `CRON_SECRET` | **secret** | steps 5 and 8, password manager |

Rules that keep children's data safe:

1. Everything in `app/config.js` is downloaded by every visitor, so only the three public values may go in it.
2. Never paste a secret into a file inside this folder, into an email or a chat. Secrets go only into the
   Supabase "secrets" command (step 8) and your password manager.
3. If you ever paste the wrong key into `app/config.js`, the app refuses to start and tells you. Treat that key
   as leaked: create a new one in the dashboard.
4. The repository is public. Before every commit run `npm run scan`; it must say PASS.

## Before you start

You need:

- A Mac with this project folder, and **Node 22 or newer** (`node -v` shows the version).
- The **Supabase command-line tool**: in Terminal run `brew install supabase/tap/supabase`.
- A **password manager** (open it now; you will save about eight values).
- An email address and sender that the school controls, for the sign-in codes (step 3): a Google Workspace
  or Brevo/Resend account.
- A GitHub account that can push to this repository.

## Step 1. Create the database project

1. Go to **supabase.com** and sign in (or create an account).
2. Click **New project**.
3. Choose the organisation. **Name:** anything recognisable, for example `school-app`.
4. **Database password:** click **Generate a password**, then **copy it into your password manager now**.
5. **Region:** choose **South Asia (Mumbai) - ap-south-1**. This keeps the families' data in India. It
   cannot be changed later.
6. **Plan:** Free (for the pilot). Click **Create new project** and wait about two minutes.

## Step 2. Copy the two public values into `app/config.js`

1. In the project, click the **gear icon (Project Settings)** at the bottom left, then **API** (or **Data API / API Keys**).
2. Copy **Project URL** (looks like `https://abcdxyz.supabase.co`).
3. Copy the key labelled **anon** / **public** (or **Publishable key**).
   **Do not copy the `service_role` / secret key.** If you cannot tell which is which: the anon key is the one marked "public".
4. Open `app/config.js` in a text editor and paste the two values between the quotes:
   `supabaseUrl: 'https://abcdxyz.supabase.co'` and `supabaseAnonKey: '...'`. Leave the rest for now.
5. Note the **Project ref**: the first part of the URL (`abcdxyz`). You need it in step 4.

## Step 3. Sign-in by emailed code

Parents and staff sign in with a 6-digit code sent by email (no passwords). The app never uses password sign-up.

1. **Authentication > Providers > Email**: switch it **on**; leave **Confirm email ON** (do **not** switch it off: with it off, anyone could create an account with a staff member's email address without proving they own the mailbox, and be given that staff role); set **Email OTP expiration** to **600** seconds; Save.
2. **Authentication > Email Templates**: there are two templates to change, **Magic Link** and **Confirm signup**. In **both**, replace the body so it contains the code, for example:

   ```
   <h2>Your school app sign-in code</h2>
   <p>Enter this code in the app: <strong>{{ .Token }}</strong></p>
   <p>It works once and expires in 10 minutes. If you did not ask for it, ignore this email.</p>
   ```
   The text `{{ .Token }}` must be there exactly, in both. A new parent's first sign-in uses "Confirm signup"; later sign-ins use "Magic Link". Save each.
3. **Project Settings > Authentication > SMTP Settings** (or **Authentication > Emails > SMTP**): switch on **Custom SMTP**
   and enter the host, port, user and password from the school's email provider (Resend, Brevo or Google Workspace),
   with a sender such as `no-reply@<the school's domain>`. Without this, Supabase's shared sender allows only
   a handful of emails per hour. Send yourself a test.
4. **Authentication > URL Configuration**: set **Site URL** to `https://vemula78.github.io/montessori-school-app/app/`
   and click **Add URL** under **Redirect URLs** with the same address. Save.

## Step 4. Create the tables (one-time, from Terminal)

Open **Terminal**, then:

```
cd "/path/to/the/project folder"
supabase login
supabase link --project-ref <your project ref from step 2>
supabase db push
supabase db diff --linked
```

- `supabase login` opens a browser window; approve it.
- `supabase link` asks for the **database password** from step 1.
- `supabase db push` creates all tables and security rules (Phase 3 adds the learning tables and the **private `child-photos` bucket**). Say **Y** when asked.
- `supabase db diff --linked` must print **nothing** (or "No schema changes found"). If it prints SQL, stop and send it to the developer.

After the push, open **Storage** in the dashboard and check there is a bucket called `child-photos` and that it says **Private** (not Public). If it is public, stop and send a screenshot to the developer. Do not add any storage policies by hand: photos are only ever written and read through the `command` function.

## Step 5. Switch on the scheduler (reminders and clean-up)

1. **Database > Extensions**: search for `pg_cron` and switch it **on**; search `pg_net` and switch it **on**.
2. Make up a long random value for `CRON_SECRET` (for example run `openssl rand -hex 24` in Terminal). Save it in your password manager.
3. **SQL Editor > New query**: paste these two lines, replace `<ref>` with your project ref and `<same value as CRON_SECRET>` with the value you just made, and click **Run**. They store the functions address and the secret in the database's Vault so the nightly job can call the reminder function:

   ```sql
   select vault.create_secret('https://<ref>.supabase.co/functions/v1','functions_url');
   select vault.create_secret('<same value as CRON_SECRET>','cron_secret');
   ```
   Run each line once only. Later, **Database > Cron Jobs** should list `cron-daily` (08:00 India time every day) and `cron-trips` (every 15 minutes). `supabase db push` (step 4) creates both; they use the same two Vault values. From Phase 3 the daily run also does three photo and retention steps (`photosConsentSweep`, `retention`, `photosCleanup`); each shows its counts in the run's report, and nothing extra needs scheduling.

## Step 6. Razorpay (online fee payments) in TEST mode

1. Go to **razorpay.com**, sign up, and verify your email and phone.
2. In the dashboard make sure the **Test Mode** switch (top) is **on**. Everything below is done in Test Mode.
3. **Account & Settings > API Keys > Generate Test Key**. **Copy the Key ID and the Key Secret into your password manager at once** (the secret is shown only once).
4. **Account & Settings > Webhooks > Add New Webhook**:
   - **URL:** `https://<your project ref>.supabase.co/functions/v1/rzp-webhook`
   - **Secret:** invent a random 32-character value (for example `openssl rand -hex 16`) and save it in your password manager.
   - **Events:** tick `payment.captured`, `payment.failed`, `order.paid`, `refund.created`, `refund.processed`.
   - Click **Create Webhook**.

## Step 7. Notification keys (push alerts)

In Terminal: `node scripts/vapid-keys.mjs`. It prints a **public** and a **private** key.

- Paste the **public** key into `app/config.js` as `vapidPublicKey`.
- Save the **private** key in your password manager (it goes into step 8).

## Step 8. Store the secrets and deploy the server functions

In Terminal, put your own values in place of the `<...>` parts (one command; keep it on one line):

```
supabase secrets set RAZORPAY_KEY_ID=<key id> RAZORPAY_KEY_SECRET=<key secret> RAZORPAY_WEBHOOK_SECRET=<webhook secret> APP_GATEWAY_MODE=test VAPID_PUBLIC_KEY=<vapid public> VAPID_PRIVATE_KEY=<vapid private> VAPID_SUBJECT=mailto:<the school's email> CRON_SECRET=<the same CRON_SECRET as step 5>
supabase functions deploy
```

**Do not set `PUSH_TEST_ORIGINS` in the cloud.** It is for local tests only and loosens a safety check on notification addresses; leave it unset.

**Do not set `RAZORPAY_API_BASE` in the cloud.** It exists only for testing on a developer's Mac against a pretend payment server; in the cloud the real Razorpay address must be used, so leave it unset.

`APP_GATEWAY_MODE=test` must match the `rzp_test_` key; the server refuses to start if a test key is used in live mode or the other way round.
Then check **Edge Functions** in the dashboard: you should see `command`, `pay-create-order`, `pay-verify`, `pay-status`, `rzp-webhook` and `cron-daily`.

## Step 9. Publish the app

1. Run `npm test` and `npm run scan` - both must be green / PASS.
2. Commit `app/config.js` (it holds only public values) and push the main branch to GitHub. GitHub Pages publishes it within a minute.
3. Open `https://vemula78.github.io/montessori-school-app/app/`. You should see the sign-in page (not a "not connected" page).
   The public demo at the site root must still show its yellow "demo data only" ribbon.

## Step 10. Set up the school and the first staff login (the principal)

The database starts empty. One generated script loads the school's profile, the academic year, the programmes, the fee heads and the staff list (at least the principal), and optionally the bus routes. After that the principal manages everything in the app.

In Terminal, in the project folder:

```
cp supabase/first-run.example.json first-run.json
node scripts/first-run-sql.mjs first-run.json > first-run.sql
```

1. Open `first-run.json` in a text editor (it is kept out of the repository, so real details are safe there) and replace **every** value:
   - `school`: `name`, `address`, `phone`. Leave `weeklyOffs` as `[0, 6]` (Sunday and Saturday) unless the school differs. Leave the number prefixes (`INV`, `RCP`, `RFD`) unless the school wants others. `lateFeeRule` may stay `null` (no late fees) until the school decides.
   - `academicYears` and `currentAcademicYearId`: for example `AY2026-27` from `2026-06-01` to `2027-05-31`. The current id must be one of the years listed.
   - `programs`: one entry per class group (`id`, `name`, `ageRange`). Use ids without spaces, like `prog-toddler`.
   - `staff`: the principal first (`"role": "admin"`), then the accountant, teachers and drivers (roles: `admin`, `teacher`, `accountant`, `driver`). Every person except a driver needs the **exact email they will sign in with**. Give each teacher the `programIds` they teach. Phone numbers go in `phone`.
   - `routes`: leave `[]` if the school has no bus; otherwise each route needs `id`, `name`, `busNo`, `driverId` (a driver from `staff`), `transportFeePaise` and its `stops` (name and latitude/longitude). Money is whole **paise** (Rs 4,500 is `450000`).
2. Run the second command above. It checks everything and prints a problem in plain words if something is wrong (for example a missing principal email); fix the file and run it again. It writes `first-run.sql`.
3. Supabase dashboard > **SQL Editor > New query**: paste the whole of `first-run.sql` and click **Run**. **Run it once only:** a second run fails with `CONFLICT` and changes nothing.
4. Open the app address from step 9 on a computer, enter the principal's email, type the code from the email. You land on the principal's home page. (The sign-in is linked to the staff record automatically.)
5. In the app: **Import data** to load the children list (CSV saved from the old system's Excel export), then **Import data > Outstanding fees**. Set up **Fee structures**, then **Invite codes** to issue one single-use code per family and **Print slips**. Hand each slip to the right parent.
6. Parents: open the app address, enter their email, enter the emailed code, then the invite code and one child's date of birth, then read and accept the privacy notice.

When you are done, delete `first-run.json` and `first-run.sql` from the project folder (they hold real names and emails; both are ignored by git, but there is no reason to keep them).

## Step 11. Install on an iPhone (needed for notifications)

On iPhone and iPad, notifications work only when the app is on the Home Screen (iOS 16.4 or newer).

1. Open the app address in **Safari** (not inside WhatsApp or another app).
2. Tap **Share** (square with an arrow), scroll, tap **Add to Home Screen**, tap **Add**.
3. Open the app **from the new Home Screen icon**, sign in, go to **Settings > Notifications on this device**, tap **Turn on notifications**, and tap **Allow**.

Android phones: open in Chrome and use **Install app** (or just allow notifications when asked).

## Step 12. Before real families use it

Do these only when the school has decided to go ahead. Do not skip any.

- [ ] **Have the school's legal adviser read the privacy notice** (`src/ui/privacy.js`, version v2: it now has a **photos** section and the retention wording) and the retention periods in it (fees 8 years, messages/diary/attendance/observations 1 year after leaving, bus positions 30 days; the photo period is the school's to set). The notice currently labels them a **draft schedule**; remove that label only once the school has decided the periods and set them in Settings (next item). A new notice version needs **three changes made together**: (1) `PRIVACY_VERSION` in `src/ui/privacy.js`; (2) `CONSENT_VERSION` in `src/domain/commands.js`, followed by `npm run sync-domain` (it refreshes the copy the server functions use); (3) a **new migration file** in `supabase/migrations/` containing `create or replace function app.consent_version() returns text language sql immutable set search_path = pg_catalog as $$ select 'v2'::text $$;` (with the new version in place of `v2`; migration `0005_phase3_learning.sql` already does this for `v2`). If any of the three is missed, consents are refused or the database treats new consents as not current. Then run `npm test` (a test fails if the first two differ), `supabase db push` and `supabase functions deploy`. Every parent then sees the new version.
- [ ] **Retention periods must be decided and set (enforcement is built in).** After a child leaves, the daily job deletes each kind of record once its period has passed: photos (always enforced once a period is set), observations and progress records, diary notes and termly reports, attendance, messages. Fee records are never deleted by it. Get the school's decision on each period (and the legal adviser's view), then set them as the principal in **Settings > How long records are kept**. A period left empty means "not decided": nothing is deleted for it. Check the card's **due** counts before and after, and set a leaving date for any child who left without one (Phase 2 imports have none, so nothing about them can be due). Then update the notice and remove its DRAFT label.
- [ ] **Photos: decide before switching them on.** Photos are optional and need each family's photo consent (the sign-up step asks, per child; when two guardians use the app both must agree). Check with the school: who may take photos, on whose devices, and that only one child is in each photo. Confirm the **storage limit** (Free plan 1 GB; about 0.7 GB a year for 70 children at 40 photos each) and move to the Pro plan before real families (next item). A parent who turns photos off, or withdraws, has their child's photos deleted by the next job run.
- [ ] **Upgrade Supabase to the Pro plan** (Project Settings > Billing; about 25 US dollars a month). The Free plan **pauses after 7 days of inactivity (school holidays!) and keeps no backups**.
- [ ] **Backups:** after upgrading, check **Database > Backups** shows daily backups; keep a monthly `supabase db dump` copy on the school's computer.
- [ ] **Razorpay KYC:** complete the account activation (the trust/society registration, PAN, bank proof). Then in Terminal repeat `supabase secrets set` with the **live** key id and secret, a **live-mode webhook** (the same URL and events, created while Test Mode is off), and `APP_GATEWAY_MODE=live`; run `supabase functions deploy`; change `gatewayMode` in `app/config.js` to `'live'` and push.
- [ ] **Map tiles:** the bus map uses the free OpenStreetMap tile server, which is allowed only for light demo use. For real use, create a free MapTiler account (or host tiles yourself) and ask the developer to switch the tile address.
- [ ] **Email sender:** make sure the school's domain has SPF/DKIM set up for the sign-in emails so they do not land in spam.
- [ ] **Test with two phones:** one parent, one driver; run a simulated trip, make a Rs 100 test payment in test mode, check the receipt says TEST MODE, then repeat with a live Rs 1 payment after step above and refund it from the Razorpay dashboard.
- [ ] **SMS / WhatsApp alerts** are not included (they need regulator-approved sender registration and cost money per message). Say so to parents: notifications work through the app only.

## If something goes wrong

| What you see | Likely cause | What to do |
|---|---|---|
| "This app is not connected yet" | `app/config.js` still empty or not pushed | step 2, then step 9 |
| Sign-in email never arrives | SMTP not set, or template lacks `{{ .Token }}` | step 3 |
| "Code expired" | more than 10 minutes passed | ask for a new code |
| Parent says "invite code not recognised" | typo, code used, or expired (14 days) | issue a new code (the old one stops working) |
| Payment taken but no receipt | browser closed before confirming | wait a minute: the app and the webhook record it; check Online settlements |
| No notifications on iPhone | app not on Home Screen | step 11 |
| Whole app empty after school holiday | free project was paused | dashboard > Restore project (and upgrade, step 12) |
