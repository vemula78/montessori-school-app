// Fee structures per programme + invoice generation per instalment (idempotent).
import { rupeesToPaise, formatPaise } from '../../domain/money.js';
import { esc, money, fdate, empty, pageHead, options, formModal, confirmDialog, attempt, toast, indexBy, DASH } from '../components.js';

export async function render(ctx) {
  const { api, db, query } = ctx;
  const years = await api.calendar.academicYears();
  const ay = years.find((y) => y.id === query.ay) || years.find((y) => y.id === db.school.currentAcademicYearId) || years[0];
  if (!ay) { ctx.el.innerHTML = `${pageHead('Fee structures')}${empty('No academic year set up')}`; return; }
  const [structures, heads, invoices] = await Promise.all([
    api.fees.structures({ academicYearId: ay.id }),
    api.fees.heads(),
    api.fees.invoices({ academicYearId: ay.id }),
  ]);
  const hmap = indexBy(heads);
  const pmap = indexBy(db.programs);
  const eligible = (pid) => db.students.filter((s) => s.status === 'active' && s.programId === pid).length;
  const existing = (pid, inst) => invoices.filter((i) => i.programId === pid && i.installmentName === inst && i.status !== 'cancelled').length;

  const cards = db.programs.map((p) => {
    const st = structures.find((s) => s.programId === p.id);
    if (!st) return `<div class="card"><h3>${esc(p.name)}</h3>${empty('No fee structure for this year')}</div>`;
    return `<div class="card stack">
      <div class="row between"><h3 style="margin:0">${esc(p.name)}</h3><button class="btn sm" data-edit="${esc(st.id)}">Edit structure</button></div>
      <small>Sibling discount ${esc(st.siblingDiscountBp / 100)}% of tuition (younger siblings) &middot; staff-ward discount ${st.staffWardDiscountBp == null ? DASH : esc(st.staffWardDiscountBp / 100) + '%'} &middot; ${eligible(p.id)} active children. Bus fare is added from the child's route.</small>
      <div class="tablewrap"><table><thead><tr><th>Instalment</th><th>Due</th><th>Fee lines</th><th class="r">Per child</th><th class="r">Invoices</th><th></th></tr></thead><tbody>
      ${st.installments.map((ins) => {
        const total = ins.lines.reduce((s, l) => s + l.amountPaise, 0);
        const n = existing(p.id, ins.name);
        return `<tr><td><strong>${esc(ins.name)}</strong></td><td class="nowrap">${fdate(ins.dueDate)}</td>
          <td>${ins.lines.map((l) => `${esc(hmap.get(l.headId)?.name || l.headId)} ${money(l.amountPaise)}`).join('<br>')}</td>
          <td class="r num">${money(total)}</td><td class="r num">${n} / ${eligible(p.id)}</td>
          <td><button class="btn sm primary" data-gen="${esc(p.id)}" data-inst="${esc(ins.name)}">Generate invoices</button></td></tr>`;
      }).join('')}
      </tbody></table></div></div>`;
  });

  ctx.el.innerHTML = `${pageHead('Fee structures', ay.label || ay.id)}
    ${years.length > 1 ? `<div class="row" style="margin-bottom:12px"><select id="fs-ay" style="width:auto" aria-label="Academic year">${options(years.map((y) => ({ value: y.id, label: y.label || y.id })), ay.id)}</select></div>` : ''}
    <div id="fs-result"></div>
    <div class="stack">${cards.join('')}</div>`;

  ctx.el.querySelector('#fs-ay')?.addEventListener('change', (e) => ctx.setQuery({ ay: e.target.value }));
  ctx.el.addEventListener('click', async (e) => {
    const g = e.target.closest('[data-gen]');
    const ed = e.target.closest('[data-edit]');
    if (g) {
      const prog = pmap.get(g.dataset.gen);
      const ok = await confirmDialog('Generate invoices', `Generate "${g.dataset.inst}" invoices for ${prog.name}? Children who already have one are skipped, so this is safe to repeat.`, { okLabel: 'Generate' });
      if (!ok) return;
      const res = await attempt(() => api.fees.generateInvoices({ academicYearId: ay.id, programId: g.dataset.gen, installmentName: g.dataset.inst }));
      if (res.ok) {
        const r = res.value;
        toast(`Created ${r.created}, skipped ${r.skippedExisting}`);
        await ctx.rerender();
        const host = document.getElementById('fs-result'); // ctx.el was replaced by the re-render
        if (host) host.innerHTML = `<div class="banner ok"><strong>${esc(prog.name)} - ${esc(g.dataset.inst)}:</strong> ${esc(r.created)} invoice${r.created === 1 ? '' : 's'} created, ${esc(r.skippedExisting)} already existed (${esc(r.eligibleStudents ?? r.created + r.skippedExisting)} eligible children). <a href="#/fees">View invoices</a></div>`;
      }
    } else if (ed) {
      const st = structures.find((s) => s.id === ed.dataset.edit);
      if (st && await editStructure(ctx, st, hmap)) ctx.rerender();
    }
  });
}

async function editStructure(ctx, st, hmap) {
  const pct = (bp) => (bp == null ? '' : String(bp / 100));
  const fields = `
    <div class="grid cols-2"><label class="field"><span class="lbl">Sibling discount % (tuition)</span><input name="sib" inputmode="decimal" value="${esc(pct(st.siblingDiscountBp))}" required></label>
    <label class="field"><span class="lbl">Staff-ward discount % (optional)</span><input name="sw" inputmode="decimal" value="${esc(pct(st.staffWardDiscountBp))}"></label></div>
    <p class="help">Changes apply to invoices generated from now on. Existing invoices are never re-priced.</p>
    ${st.installments.map((ins, i) => `<fieldset class="card flat" style="margin-bottom:10px"><legend style="font-weight:800">${esc(ins.name)}</legend>
      <label class="field"><span class="lbl">Due date</span><input type="date" name="due_${i}" value="${esc(ins.dueDate)}" required></label>
      ${ins.lines.map((l, j) => `<label class="field"><span class="lbl">${esc(hmap.get(l.headId)?.name || l.headId)} (&#8377;)</span><input name="amt_${i}_${j}" inputmode="decimal" value="${esc(formatPaise(l.amountPaise, { symbol: false }).replace(/,/g, ''))}" required></label>`).join('')}</fieldset>`).join('')}`;
  return formModal({
    title: 'Edit fee structure', fieldsHtml: fields,
    onSubmit: async (v) => {
      const bp = (s, label, optional) => {
        if (optional && String(s).trim() === '') return null;
        const n = Number(s);
        if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error(`${label} must be between 0 and 100`);
        return Math.round(n * 100);
      };
      const next = {
        ...st, siblingDiscountBp: bp(v.sib, 'Sibling discount'), staffWardDiscountBp: bp(v.sw, 'Staff-ward discount', true),
        installments: st.installments.map((ins, i) => ({
          name: ins.name, dueDate: v[`due_${i}`],
          lines: ins.lines.map((l, j) => {
            const p = rupeesToPaise(v[`amt_${i}_${j}`]);
            if (p === null || p < 0) throw new Error(`Invalid amount for ${ins.name}`);
            return { headId: l.headId, amountPaise: p };
          }),
        })),
      };
      await ctx.api.fees.saveStructure(next);
    },
  });
}
