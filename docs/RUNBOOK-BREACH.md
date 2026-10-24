# If data may have leaked, or a key was exposed

A one-page plan for the principal and the developer. The app holds children's health notes, photos, and families'
names, phone numbers and email addresses. Under India's Digital Personal Data Protection Act 2023 and its Rules, a
personal-data breach must be reported to the families affected and to the Data Protection Board. Act on the same day.

Read it once now, before go-live, and fill in the contact list (step 0). Keep the filled-in list in the school's
password manager, **not** in this repository: the repository is public.

## 0. Before anything happens: the contact list

Write these in the password manager, in an entry called "Data breach contacts":

| Who | Why |
|---|---|
| The principal (decides, signs the notices) | first person told |
| A second principal or the trust's secretary | decides if the principal cannot be reached |
| The developer who maintains the app | rotates keys, reads the logs |
| The school's legal adviser | the reporting duty and the wording of notices |
| Supabase support (dashboard > **Support**) | if the database itself may have been accessed |
| Razorpay support (dashboard > **Help & Support**) | if payment keys may have leaked |

## 1. The first hour: who decides

Signs of a breach include: a key or password pasted somewhere public (a chat, an email, a screenshot, a commit);
a parent seeing another family's child; a lost or stolen phone or laptop that was signed in as principal, accountant or
teacher; a strange entry in **Administration > Oversight > Sign-in activity**; a warning email from Supabase, Google,
GitHub or Razorpay.

1. Whoever notices tells **the principal and the developer at once**, by phone. Do not forward the leaked value itself.
2. The principal decides, with the developer, whether personal data may have been seen by someone who should not see
   it. **If unsure, treat it as a breach.**
3. Start a written log (date, time, what was seen, who did what). It will be needed for the report.

## 2. Close the door: sign out and block

In the app, as principal (two-step sign-in is required for this desk):

- **One account involved** (a lost phone, one parent): **Administration > Accounts**, find the person, press
  **Sign out everywhere**. If the account itself is suspect, press **Block**: that closes the person's access to every
  record at once. **Unblock** later, when it is safe.
- **Staff account involved:** also **Reset two-step** for that person, and ask them to set a new password in
  **Account** after they sign in again.
- **Everyone must be signed out** (a key that signs sessions was exposed): there is no single button in the app. The
  developer rotates the project's signing keys in the Supabase dashboard (**Project Settings > JWT Keys**; the exact
  steps change, so follow Supabase's current "rotating keys" guide). Every family then signs in again with an email code.

## 3. Change the keys, in this order

Each secret has a copy in the password manager; replace that copy too. Never paste a new secret into a file in this
folder, a chat or an email (docs/GO-LIVE.md, "Read this first").

| Order | What leaked or may have leaked | What to do |
|---|---|---|
| 1 | Supabase **secret** / `service_role` key | Dashboard > **Project Settings > API Keys**: create a new secret key, then delete the old one. The server functions get their key from Supabase itself; ask the developer to redeploy them (`supabase functions deploy`). This key can read everything: treat it as a breach (step 5). |
| 2 | **Database password** | **Project Settings > Database > Reset database password**. Save the new one; `supabase link` asks for it next time. |
| 3 | `CRON_SECRET` | Make a new value (`openssl rand -hex 24`). Put it in **both** places: `supabase secrets set CRON_SECRET=<new>` and, in **SQL Editor**, `select vault.update_secret((select id from vault.secrets where name = 'cron_secret'), '<new>');`. If they differ, the nightly job stops (the principal's home says so the next day). |
| 4 | **Gmail app password** (sign-in emails), or the Google account itself | Google account > **Security > App passwords**: delete the old one, create a new one, paste it into Supabase SMTP (GO-LIVE step 3.3). If the Google account was taken over, use Google's account recovery first, then change its password (that cancels all app passwords), then create the new app password. |
| 5 | **Razorpay** key secret or webhook secret | Razorpay dashboard: **Account & Settings > API Keys > Regenerate**; **Webhooks**: edit the webhook and set a new secret. Then `supabase secrets set RAZORPAY_KEY_ID=... RAZORPAY_KEY_SECRET=... RAZORPAY_WEBHOOK_SECRET=...` and `supabase functions deploy`. Tell Razorpay support. |
| 6 | VAPID **private** key (notifications) | `node scripts/vapid-keys.mjs`, new public key in `app/config.js`, new private key with `supabase secrets set`, deploy. Every device must turn notifications on again (the old sign-ups stop working). |
| 7 | `HEALTHCHECK_URL` | healthchecks.io: the check's **Settings > Change ping URL**, then `supabase secrets set HEALTHCHECK_URL=<new>`. |
| 8 | The **publishable** key (in `app/config.js`) | This key is public by design: everyone who opens the app downloads it. Nothing to rotate unless a secret key was put in its place by mistake (then see row 1). |

## 4. Find out what happened

- **Audit log** (menu **Audit log**): every change in the app, who made it and when. Filter by the child or the person.
- **Administration > Oversight > Sign-in activity**: who signed in, when, and with or without two-step (kept 90 days).
- **Administration > Oversight > Who can see**: for one child, every account that can open the record and why.
- Supabase dashboard **Logs** (API, Auth, Edge Functions): the developer reads these. They are kept only a short
  time (check the current retention for the school's plan), so save what matters on the first day.

Write down: which families and children, which kinds of data (contact details, health notes, photos, fees), when it
started and when it was stopped.

## 5. Tell the families and the Board

1. **The legal adviser confirms the duty and the deadline.** The DPDP Rules (notified in November 2025) require the
   school to tell each affected person and the Data Protection Board without delay, and to send the Board a detailed
   report within 72 hours of learning of the breach. Check with the adviser which parts of the Rules are in force on
   the day, and whether the CERT-In 6-hour reporting direction applies to the school.
2. **Families directly affected:** a notice in the app (**Notices**, marked **Important** so it is also pushed), plus a
   phone call from the office for anyone whose child's health notes or photos were involved. A notice should say, in
   plain words: what happened; what data of theirs was involved; what the school has done; what they can do (for
   example, watch for messages pretending to be from the school, which will never ask for a code); and whom to contact.
3. **Everyone, if the app was closed or everyone was signed out:** **Administration > Announcement** (up to 280
   characters, shown at the top of every screen). For example: "We have signed everyone out of the school app as a
   safety step. Please sign in again with the emailed code. We will write to the families affected today."
4. **The Data Protection Board:** the legal adviser files the report, using the written log from step 1.

## 6. Afterwards

- Write down the cause and what will prevent it next time. Add it to this page if the steps were wrong or missing.
- If the cause was in the app's code, the developer fixes it, adds a test, and has the change reviewed.
- Check the next nightly job ran (principal's home: nothing listed under the nightly job).
