// Privacy notice (version v1): the text a parent agrees to, the purposes, and a stable hash of that text.
// The hash is stored with each consent so it can later be shown exactly which wording was accepted.
// The wording below is a working draft: the school's legal adviser must review it (and the retention
// periods) before real families are onboarded - see docs/GO-LIVE.md.
import { esc, pageHead } from './components.js';

export const PRIVACY_VERSION = 'v1';

export const PURPOSES = [
  {
    key: 'app_account', required: true,
    title: 'My account and my children’s school records',
    detail: 'The school keeps your name, phone and email, your child’s name, date of birth, programme, attendance, daily diary, fees and receipts, notices sent to you, and your messages with the school. You need this to use the app at all.',
  },
  {
    key: 'push', required: false,
    title: 'Notifications on my phone',
    detail: 'The school may send alerts to this phone for fee reminders, new important notices, payment receipts and bus updates. You can turn this off at any time in Settings.',
  },
  {
    key: 'bus_live', required: false,
    title: 'Live bus location and arrival alerts',
    detail: 'You can see the school bus on a map and receive alerts when it is near your child’s stop. The location shown is the bus’s, not your child’s or yours. If you do not agree, you still receive the normal notices.',
  },
];

// Sections of the notice. Plain strings only: they are escaped when drawn and hashed exactly as written here.
export const SECTIONS = [
  { h: 'Who is responsible', p: ['The school (the “school”) decides why and how your family’s information is used. For any question about it, speak to the school office.'] },
  { h: 'What we collect, and why', p: [
    'We collect only what the school needs to run your child’s education and fees: names, dates of birth, programme, attendance, diary notes written by teachers, fee invoices and receipts, messages, and the contact details you gave us. Health notes are entered by the school and are visible to the principal, the child’s teachers and the child’s own parents only - never to drivers or fee staff.',
    'We do not collect Aadhaar numbers, photographs or home addresses. For the bus we store only the name of your child’s stop.',
  ] },
  { h: 'Who can see it', p: [
    'Staff see only what their job needs: teachers see their own programme; the accountant sees fees; drivers see the children on their own route (without health notes). You see only your own children and your own account.',
  ] },
  { h: 'Online payments', p: [
    'If you pay fees online, the payment is handled by a payment provider (Razorpay). The school receives the amount, the payment reference and the result - never your card, UPI or bank details.',
  ] },
  { h: 'Where it is kept, and for how long', p: [
    'Data is stored on cloud servers in India (Mumbai). Fee records are kept for 8 years because the law requires it. Messages, diary notes and attendance are kept for 1 year after your child leaves the school. Bus positions are deleted after 30 days. An audit log of who changed what is kept for the life of the system.',
  ] },
  { h: 'Your rights', p: [
    'You may see and download your information (Settings > Download my data), ask the school to correct it, and withdraw any optional consent at any time. Withdrawing the account consent closes your access; fee records the law requires the school to keep are retained, with your personal details erased on request.',
    'Consent for a child is given by the parent or guardian. To complain, write to the school office; you may also approach the Data Protection Board of India.',
  ] },
];

export const noticeText = () => SECTIONS.map((s) => `${s.h}\n${s.p.join('\n')}`).join('\n\n') + '\n\n' + PURPOSES.map((p) => `${p.key}${p.required ? ' (required)' : ''}: ${p.title}. ${p.detail}`).join('\n');

/** SHA-256 hex of the exact notice text (+ version), or null where the browser has no crypto.subtle. */
export async function noticeHash() {
  try {
    const bytes = new TextEncoder().encode(`${PRIVACY_VERSION}\n${noticeText()}`);
    const d = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
}

export const noticeHtml = () => SECTIONS.map((s) => `<h3>${esc(s.h)}</h3>${s.p.map((t) => `<p>${esc(t)}</p>`).join('')}`).join('');

// Routed page: #/privacy
export async function render(ctx) {
  ctx.el.innerHTML = `${pageHead('Privacy notice', `Version ${PRIVACY_VERSION}`)}
    <div class="card prose">${noticeHtml()}</div>
    <h2 style="margin-top:18px">What you can choose</h2>
    <div class="stack">${PURPOSES.map((p) => `<div class="card tight"><div class="item-title">${esc(p.title)}${p.required ? ' <small>(required)</small>' : ' <small>(optional)</small>'}</div><small>${esc(p.detail)}</small></div>`).join('')}</div>
    <p style="margin-top:14px"><a class="btn" href="#/settings">Manage my choices</a></p>`;
}
