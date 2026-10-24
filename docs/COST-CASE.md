# The cost case: the Supabase Pro plan against the current vendor

For the school's decision to move the database to Supabase's paid **Pro** plan before families use the app.
Every figure below names its source and the date it was read. Prices change: **check each one again on the day of
the decision**, and use the invoice as the final word.

## What the school pays each year

| Item | Price | Source, date read |
|---|---|---|
| **Supabase Pro** (database, sign-in, files, server functions) | from **US$25 a month** per organisation, i.e. US$300 a year before tax; includes US$10 a month of compute credit (enough for one Micro database, which this app needs) | supabase.com/pricing, read 24-Oct-2026 |
| Tax on the Supabase invoice | GST on a service bought from abroad: check with the school's accountant and on the first invoice | check current position |
| Rupee amount | US$300 at the exchange rate on the card statement, plus the card's foreign-currency fee | check on the statement |
| **Razorpay** (online fee payments) | **2% of each successful payment** (UPI, cards, netbanking, wallets), **plus 18% GST on that 2%**; no setup fee, no annual fee, no refund fee. Example: a ₹10,000 fee costs ₹200 + ₹36 GST = ₹236 | razorpay.com/pricing, read 24-Oct-2026 (standard rate card; schools can ask for a negotiated rate) |
| Domain name for the app's address | yearly fee | check the registrar's current price |
| Gmail (sign-in emails), GitHub Pages (the app's web pages), healthchecks.io (nightly-job alert) | free plans | check each service's current terms |
| SMS / WhatsApp alerts | not used (the app sends notifications only) | — |

The **current vendor**: **₹400, ₹500 or ₹600 per child per year** depending on the plan, **plus 18% GST**. Source: the
current vendor's public pricing page, as recorded in the school's planning notes (the date it was read was not
recorded: check the current price and the school's actual invoice).

| Children | Current vendor, per year incl. GST (₹400 to ₹600 plans) | This app, per year |
|---|---|---|
| 70 | ₹33,040 to ₹49,560 | Supabase US$300 + tax, plus the domain; Razorpay's 2% + GST on online payments |
| 100 | ₹47,200 to ₹70,800 | the same: the Supabase price does not rise per child |

(Vendor figures: price × children × 1.18. Online-payment fees are left out of both columns: check whether the school
pays a payment fee with the current vendor too.)

## What Pro gives that the Free plan does not

Source for every line: supabase.com/pricing, read 24-Oct-2026.

| | Free | Pro |
|---|---|---|
| Pausing | **paused after 1 week of inactivity** (school holidays: the app stops for everyone until someone restores it in the dashboard) | never paused |
| Backups | **none** | daily backups, kept 7 days |
| Database size | 500 MB | 8 GB per project included |
| File storage (photos) | 1 GB | 100 GB included |
| Data sent out (egress) | 5 GB | 250 GB included |
| Spend cap | — | **on by default**: usage beyond what is included is refused instead of billed. Leave it on. |

Do not rely on the app's scheduled jobs (every 15 minutes and every morning) to count as "activity" and keep a Free
project awake: Supabase does not promise that they do.

## Expected use (for checking the invoice)

About 70 children: about 60,000 server-function calls and about 10 MB of bus positions a month (README, "Costs and
limits"); photos about 0.7 GB a year at 40 photos per child (GO-LIVE step 12). All well inside what Pro includes.

## Recommendation

1. Upgrade to Pro **before the first family signs up** (Supabase dashboard > **Organisation settings > Billing**),
   with the school's card. Leave the spend cap on.
2. Put a monthly reminder in the school calendar: check the Supabase invoice (amount, GST) and file it with the
   accounts.
3. Ask Razorpay for its rate for schools before going live; record the agreed rate here, with the date.
4. Re-check every price on this page before signing anything, and write the date you checked next to it.
