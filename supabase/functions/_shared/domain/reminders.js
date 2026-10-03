// Fee reminders and the "late fees due" list. Pure; the daily cron job sends and records them.
// Reminders go at T−3, on the due day, +7 and +14 days of the EFFECTIVE due date (holiday-shifted).
// A day the job did not run is caught up: the latest stage reached is sent once (deduped by invoice+kind).
// Late fees are never applied here: the accountant applies them from the list (Phase 1 rule).

import { addDays, compareISO, formatDate } from './dates.js';
import { formatPaise } from './money.js';
import { byId } from './people.js';
import { invoiceBalance, lateFeeDue } from './fees.js';
import { effectiveDueDate } from './late-fee.js';

export const REMINDER_STAGES = [
  { kind: 'T-3', offset: -3 },
  { kind: 'due', offset: 0 },
  { kind: '+7', offset: 7 },
  { kind: '+14', offset: 14 },
];
const CATCH_UP_DAYS = 6; // a stage older than this (and superseded by nothing) is not sent late

export function reminderText(db, inv, kind, eff, balancePaise) {
  const s = byId(db.students, inv.studentId);
  const who = s ? s.firstName : 'your child';
  const amount = formatPaise(balancePaise);
  if (kind === 'T-3') return `Fee reminder: ${amount} for ${who} (${inv.installmentName}, ${inv.number}) is due on ${formatDate(eff)}.`;
  if (kind === 'due') return `Fee due today: ${amount} for ${who} (${inv.installmentName}, ${inv.number}).`;
  return `Fee overdue since ${formatDate(eff)}: ${amount} for ${who} (${inv.installmentName}, ${inv.number}). Please pay or contact the school office.`;
}

/**
 * Reminders to send today. sent = Set of `${invoiceId}|${kind}` already sent.
 * @returns {{invoiceId, studentId, kind, effectiveDueDate, balancePaise, text}[]}
 */
export function remindersDue(db, today, sent = new Set()) {
  const out = [];
  for (const inv of db.invoices) {
    if (inv.status === 'cancelled') continue;
    const bal = invoiceBalance(db, inv);
    if (bal <= 0) continue;
    const eff = effectiveDueDate(db, inv);
    let stage = null;
    for (const st of REMINDER_STAGES) if (compareISO(addDays(eff, st.offset), today) <= 0) stage = st;
    if (!stage) continue;
    const stageDate = addDays(eff, stage.offset);
    if (compareISO(addDays(stageDate, CATCH_UP_DAYS), today) < 0) continue;
    if (sent.has(`${inv.id}|${stage.kind}`)) continue;
    out.push({ invoiceId: inv.id, studentId: inv.studentId, kind: stage.kind, effectiveDueDate: eff, balancePaise: bal, text: reminderText(db, inv, stage.kind, eff, bal) });
  }
  return out;
}

/** Invoices with a late fee due as of `today` (computed, never applied). */
export function lateFeesDueList(db, today) {
  const out = [];
  for (const inv of db.invoices) {
    if (inv.status === 'cancelled') continue;
    const lf = lateFeeDue(db, inv, today);
    if (!lf.amountPaise) continue; // null = no rule configured, 0 = nothing due
    const s = byId(db.students, inv.studentId);
    out.push({ invoiceId: inv.id, number: inv.number, studentId: inv.studentId, studentName: s ? `${s.firstName} ${s.lastName}` : '—', days: lf.days, effectiveDueDate: lf.effectiveDueDate, lateFeePaise: lf.amountPaise });
  }
  return out.sort((a, b) => b.days - a.days || (a.number < b.number ? -1 : 1));
}
