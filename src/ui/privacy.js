// Privacy notice (version v3): the text a parent agrees to, the purposes, and a stable hash of that text.
// The hash is stored with each consent so it can later be shown exactly which wording was accepted; it covers the text as
// rendered, including the school's privacy contact (school.privacyContact, set by the principal; never invented here: when
// it is not set the notice names the school office and the email from the report footer).
// The wording below is a working draft (v3 adds wave 2: absences and pick-up, allergies and medical alerts, progress
// reports and signatures, UPI payment reports, meeting bookings, notice files, office conversations, the service
// providers and the sign-in log): the school's legal adviser must review it, and the retention periods, before real
// families are onboarded - see docs/GO-LIVE.md.
import { esc, pageHead } from './components.js';

export const PRIVACY_VERSION = 'v3';

export const PURPOSES = [
  {
    key: 'app_account', required: true,
    title: 'My account and my children’s school records',
    detail: 'The school keeps your name, phone and email, your child’s name, date of birth, programme, attendance, daily diary, allergies and medical alerts, absences you report, the people you allow to collect your child and who collected them, the teacher’s observations of your child’s work (shared with you only when the teacher chooses), termly and annual progress reports, fees, receipts and UPI payments you report, meeting bookings, notices sent to you, and your messages with the school. You need this to use the app at all.',
  },
  {
    key: 'push', required: false,
    title: 'Notifications on my phone',
    detail: 'The school may send alerts to this phone for fee reminders, new important notices, payment receipts, things to send to school, messages from the school and bus updates. Your phone’s notification service (Google, Apple or Mozilla) carries them. You can turn this off at any time in Settings.',
  },
  {
    key: 'photos', required: false,
    title: 'Photos of my child in class',
    detail: 'Teachers may take a photo of your child’s work and share it with you in the app. Each photo shows one child only and is seen only by your family and the school’s staff. Location and camera details are removed. If you do not agree, no photo of your child is taken or kept, and everything else works as normal. If you agree and later turn it off, the school deletes your child’s photos. Every parent or guardian of your child who uses the app must agree: while one has not, photos of your child are hidden from everyone and deleted at the next nightly clean-up.',
  },
  {
    key: 'bus_live', required: false,
    title: 'Live bus location and arrival alerts',
    detail: 'You can see the school bus on a map and receive alerts when it is near your child’s stop, and who received your child at the stop. The location shown is the bus’s, not your child’s or yours. If you do not agree, you still receive the normal notices.',
  },
];

/** "Who is responsible": the school's own contact for privacy questions, as the principal entered it, or the school office. */
export function contactLine(school) {
  const c = school && school.privacyContact;
  const office = school && school.reportFooter && school.reportFooter.email ? `the school office (${school.reportFooter.email})` : 'the school office';
  return c && c.name && c.email
    ? `For any question about it, or to use your rights, contact ${c.name} (${c.role}) at ${c.email}, or ${office}.`
    : `For any question about it, or to use your rights, contact ${office}.`;
}

// Sections of the notice. Plain strings only: they are escaped when drawn and hashed exactly as rendered (sectionsFor).
export const SECTIONS = [
  { h: 'Who is responsible', p: ['Kinfolk Montessori School (the “school”) decides why and how your family’s information is used.'] },
  { h: 'What we collect, and why', p: [
    'We collect only what the school needs to run your child’s education, care and fees: names, dates of birth, programme and level, attendance, diary notes written by teachers (meals, sleep, toileting, things to send), fee invoices and receipts, messages, and the contact details you gave us.',
    'Health: allergies, medical alerts and health notes, entered by the school or by you. They are visible to the principal, the child’s teachers and the child’s own parents only - never to drivers or fee staff - so that staff can keep your child safe at meals and in class.',
    'Care: absences you report in advance (the reason you give is seen by the school staff; for a bus child the driver sees only the dates), the people you allow to collect your child (name, relation and phone; seen by the principal, the child’s teachers and, for a bus child, the driver), and who collected your child or received them from the bus.',
    'Progress reports: the annual progress report rates your child’s work against the school’s form, with attendance and the teacher’s remarks; it is shown to you once the principal publishes it, with the signatures of the class teachers, the principal and the director printed on it.',
    'Payments and meetings: if you pay fees by UPI from your own bank app and report it in the app, we keep the amount, the bank reference and the date until the office confirms or rejects it; meeting slots you book are kept with your child’s records.',
    'We do not collect Aadhaar numbers or home addresses. For the bus we store only the name of your child’s stop. We take photographs of children only with the photo consent described below.',
  ] },
  { h: 'Who can see it', p: [
    'Staff see only what their job needs: teachers see their own programme; the accountant sees fees, UPI payment reports and the conversations you start with the fee office; drivers see the children on their own route (without health notes), the dates of their reported absences and the people allowed to receive them. You see only your own children and your own account. Teachers do not see your conversations with the office.',
    'The school may phone you, or message you from its own phone, about a notice you have not read.',
  ] },
  { h: 'Photos and observations', p: [
    'Teachers write observations about what your child is working on. An observation is visible to staff only until the teacher shares it with you; then you, and the child’s other guardian, can see it in the app. Progress records are never shown to families directly: they appear only inside a termly report that the principal has published.',
    'If you agree to photos, a teacher may attach a photo of your child’s work to an observation. A photo shows one child only. Photos are kept in private storage, shown only to staff of your child’s programme and, once shared, to you; they are not public and not sent to anyone else. The app removes camera and location details from a photo before it is saved.',
    'If you turn photos off (Settings > My privacy choices), the school deletes your child’s photos. Where a child has two guardians using the app, both must agree to photos for photos to be taken.',
  ] },
  { h: 'Online payments', p: [
    'If you pay fees online, the payment is handled by a payment provider (Razorpay). The school receives the amount, the payment reference and the result - never your card, UPI or bank details. A UPI payment from your own bank app goes straight to the school’s bank account; the app only keeps what you report about it.',
  ] },
  { h: 'Service providers', p: [
    'The app runs on Supabase (database, file storage and sign-in; servers in Mumbai, India). Sign-in codes are emailed through Google (Gmail), so your email address passes through Google. Online payments go through Razorpay. If you turn notifications on, your phone’s push service (Google, Apple or Mozilla) carries them. The app’s own files are served by GitHub Pages, and the bus map loads map pictures from OpenStreetMap; both see your device’s internet address, but no school data. Each receives only what it needs to provide its service.',
  ] },
  { h: 'Where it is kept, and for how long (draft retention schedule)', p: [
    'Data is stored on cloud servers in India (Mumbai); sign-in emails pass through Google’s mail servers, which may be outside India.',
    'DRAFT: the retention periods below are a proposed schedule, pending the school’s decision and a legal review. A period the school has not set yet is not enforced: nothing in that category is deleted automatically (only bus positions are deleted automatically today). Do not rely on a period until the school confirms it.',
    'Photos are the exception: once the school sets the photo period, the app deletes a child’s photos that many months after the child leaves, and always deletes them if photo consent is turned off.',
    'Proposed: fee records, including UPI payments you reported, are kept for 8 years because the law requires it. Observations, messages, diary notes, progress reports, attendance, reported absences, pick-up records and meeting bookings are kept for 1 year after your child leaves the school. Photos are proposed to be kept for a shorter period than the other records; the school sets that number. Bus positions are deleted after 30 days. The times of each sign-in to the app are kept for 90 days for security and are seen by the principal only. An audit log of who changed what is kept for the life of the system.',
  ] },
  { h: 'Your rights', p: [
    'You may see and download your information (Settings > Download my data), ask the school to correct it, and withdraw any optional consent at any time. Withdrawing the account consent closes your access; fee records the law requires the school to keep are retained, with your personal details erased on request.',
    'Consent for a child is given by the parent or guardian. To complain, write to the school office; you may also approach the Data Protection Board of India.',
  ] },
];

/** The sections as this school renders them: the contact line added to "Who is responsible". */
export const sectionsFor = (school = null) => SECTIONS.map((sec, i) => (i === 0 ? { h: sec.h, p: [...sec.p, contactLine(school)] } : sec));

/** The exact text a parent reads (school: the school document, for the privacy contact; null before sign-in). */
export const noticeText = (school = null) => sectionsFor(school).map((s) => `${s.h}\n${s.p.join('\n')}`).join('\n\n') + '\n\n' + PURPOSES.map((p) => `${p.key}${p.required ? ' (required)' : ''}: ${p.title}. ${p.detail}`).join('\n');

/** SHA-256 hex of the exact notice text (+ version), or null where the browser has no crypto.subtle. */
export async function noticeHash(school = null) {
  try {
    const bytes = new TextEncoder().encode(`${PRIVACY_VERSION}\n${noticeText(school)}`);
    const d = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
}

export const noticeHtml = (school = null) => sectionsFor(school).map((s) => `<h3>${esc(s.h)}</h3>${s.p.map((t) => `<p>${esc(t)}</p>`).join('')}`).join('');

// Routed page: #/privacy
export async function render(ctx) {
  ctx.el.innerHTML = `${pageHead('Privacy notice', `Version ${PRIVACY_VERSION}`)}
    <div class="card prose">${noticeHtml(ctx.api.getDb()?.school || null)}</div>
    <h2 style="margin-top:18px">What you can choose</h2>
    <div class="stack">${PURPOSES.map((p) => `<div class="card tight"><div class="item-title">${esc(p.title)}${p.required ? ' <small>(required)</small>' : ' <small>(optional)</small>'}</div><small>${esc(p.detail)}</small></div>`).join('')}</div>
    <p style="margin-top:14px"><a class="btn" href="#/settings">Manage my choices</a></p>`;
}
