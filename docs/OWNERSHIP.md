# Who owns the accounts the app depends on

The live app depends on five accounts. Today the first three each have **one** owner: the school's Gmail account owns
the Supabase organisation and sends every sign-in email, and the app is served from the developer's personal GitHub
account, whose user name is part of the app's address. If one of these accounts is locked, loses its 2-step
verification or recovery access, or is renamed, the school loses sign-in, updates or the app's address, and nobody
else can get it back.

The fix costs nothing except the domain (part 4). Do parts 1 to 4 **before the first family signs up**: parts 3 and 4
change the app's address, and changing it later makes every family reinstall the app.

Keep every password, recovery code and app password in the school's password manager, in a vault that the principal
and one other trusted person can open. Never in this repository (it is public), an email or a chat.

| Account | What breaks without it | Owner after this page | Second owner |
|---|---|---|---|
| School Gmail account | sign-in codes, Supabase login, domain and healthchecks.io logins | the school | recovery phone and email held by the school (part 1) |
| Supabase organisation | the database, sign-in, server functions | the school's Gmail account | the principal's own account (part 2) |
| GitHub (the code and the app's web pages) | updates; the app's address while it is on GitHub's address | a school GitHub organisation | the principal, plus the developer as member (part 3) |
| Domain name | the app's address | the school (registrar login = school Gmail) | the principal knows the registrar login (part 4) |
| Razorpay | online fee payments | the school (its KYC documents) | a second team member (part 5) |

## 1. The school's Gmail account

1. Sign in on a computer. **myaccount.google.com > Security**.
2. **2-Step Verification**: turn it on (it must stay on: the sign-in emails use an app password, which needs it).
   Add a second method as well, for example the **Google Authenticator** app on a second staff phone.
3. **Recovery phone**: a phone number the **school** holds (the office phone, or a school SIM), not a personal one.
   **Recovery email**: the principal's own address.
4. **Backup codes** (under 2-Step Verification): **Get backup codes**, store them in the password manager.
5. Never change this account's password or turn 2-Step Verification off without making a new app password straight
   away (GO-LIVE step 3.3): Google cancels app passwords when either happens, and sign-in codes stop.

## 2. Supabase: a second owner

1. The principal creates a free Supabase account with **their own** email (supabase.com > **Start your project**),
   and turns on two-step login in **Account preferences > Security**.
2. Signed in as the school's Gmail account: **Organisation settings > Team > Invite**: the principal's email,
   role **Owner**. The principal accepts the email invitation.
3. Check the team list shows two Owners. If the developer needs access, invite them as **Developer** (not Owner).

## 3. GitHub: move the code to a school organisation

1. Create a GitHub account for the school with the school's Gmail address (github.com > **Sign up**), and turn on
   two-factor authentication (**Settings > Password and authentication**). Save the recovery codes.
2. Signed in as the school: **+ (top right) > New organization > Free**. Name it after the school (this name becomes
   part of the GitHub address until the school's own domain is set up). Invite the principal as **Owner** and the
   developer as **Member**.
3. The developer, signed in as themselves: the repository **Settings > General > Danger Zone > Transfer ownership** to
   the new organisation. GitHub keeps redirecting the old repository address for the code, but **not** the
   GitHub Pages web address: the app's address changes to `<organisation>.github.io/montessori-school-app/app/`.
4. In the organisation's repository: **Settings > Pages**: Source **Deploy from a branch**, branch `main`, folder
   `/ (root)`. Give the developer **Write** access (**Settings > Collaborators and teams**) so they can keep
   publishing updates.
5. Then do part 4 straight away, and update Supabase (**Authentication > URL Configuration**) once, with the final
   address.

## 4. The school's own web address

Follow GO-LIVE **step 9a**. The domain is registered in the school's name, with the school's Gmail account as the
registrar login, auto-renew on, and a calendar reminder a month before it expires. Price: check the registrar's
current price (it is a yearly fee). With the domain, the app's address no longer depends on any GitHub account name.

## 5. Razorpay

The Razorpay account belongs to the school (its KYC uses the school's registration documents). In the Razorpay
dashboard, **Account & Settings > Manage Team** (or **Settings > Team**): add the principal and the accountant with
the roles they need, so the account is not tied to one login. Turn on two-step login for each.

## 6. Check once a year

Each June, before the new academic year: sign in to every account above once, check the second owner is still
listed, the recovery phone still works, the domain auto-renew is on, and the password manager entries are current.
Note the date in the school's IT log.
