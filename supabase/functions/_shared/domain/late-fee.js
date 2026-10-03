// Late-fee calculation. Never mutates an invoice: the accountant applies the result explicitly.

import { byId } from './people.js';
import { diffDays } from './dates.js';
import { nextWorkingDay } from './calendar.js';

/** Due date shifted to the next working day for the student's program when the rule asks for it. */
export function effectiveDueDate(db, invoice) {
  const rule = db.school.lateFeeRule;
  if (!rule || !rule.shiftDueToWorkingDay) return invoice.dueDate;
  const student = byId(db.students, invoice.studentId);
  return nextWorkingDay(db, invoice.dueDate, student ? student.programId : undefined);
}

/**
 * @param {import('../store/schema.js').LateFeeRule|null} rule
 * @param {{effectiveDueDate:string, principalBalancePaise:number, alreadyAppliedPaise:number, waivedPaise?:number}} inv
 * @param {string} asOf  ISO date
 * @returns {{days:number, amountPaise:number|null, computedPaise:number|null, alreadyAppliedPaise:number, waivedPaise:number, effectiveDueDate:string, reason?:string}}
 *   days = days late beyond the grace period. amountPaise = still to apply (computed − applied − waived);
 *   null when no rule is configured (missing, not zero). capPaise limits both flat and per-day fees.
 */
export function computeLateFee(rule, { effectiveDueDate, principalBalancePaise, alreadyAppliedPaise, waivedPaise = 0 }, asOf) {
  const grace = rule ? rule.graceDays : 0;
  const late = diffDays(effectiveDueDate, asOf) - grace;
  const days = late > 0 ? late : 0;
  if (!rule) return { days, amountPaise: null, computedPaise: null, alreadyAppliedPaise, waivedPaise, effectiveDueDate, reason: 'No late-fee rule configured' };
  let computed = 0;
  if (days > 0 && principalBalancePaise > 0) {
    if (rule.mode === 'flat') computed = rule.amountPaise;
    else if (rule.mode === 'perDay') computed = days * rule.amountPaise;
    else throw new TypeError(`Unknown late-fee mode: ${rule.mode}`);
    if (rule.capPaise !== null && rule.capPaise !== undefined && computed > rule.capPaise) computed = rule.capPaise;
  }
  const due = computed - alreadyAppliedPaise - waivedPaise;
  return { days, amountPaise: due > 0 ? due : 0, computedPaise: computed, alreadyAppliedPaise, waivedPaise, effectiveDueDate };
}
