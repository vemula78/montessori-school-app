// Audit log viewer (newest first): filter by entity, record, dates, person and text in the summary; export what is shown.
import { esc, fdatetime, empty, pageHead, options, downloadText, fullName } from '../components.js';
import { isISODate, todayISO } from '../../domain/dates.js';

// every entity the app writes (so the list does not depend on which rows happen to be the newest)
const ENTITIES = ['academicYear', 'attendance', 'calendarEvent', 'calendarImport', 'consent', 'curriculum', 'curriculumImport', 'dataRequest', 'feeStructure',
  'guardian', 'import', 'invite', 'invoice', 'notice', 'observation', 'payment', 'photo', 'pickup', 'pickupContact', 'presentation', 'progress', 'refund',
  'report', 'retention', 'school', 'settlement', 'staff', 'student', 'thread', 'trip'];
const LIMITS = [50, 100, 250, 500, 1000];
const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const csvText = (v) => csvCell(/^[=+\-@\t\r]/.test(String(v ?? '')) ? `'${v}` : v); // spreadsheet formula injection guard

/** The rows shown, as CSV lines (header first). */
export function auditCsv(rows) {
  const head = ['When (UTC)', 'Who', 'Role', 'Entity', 'Record', 'Action', 'Summary'];
  return [head.map(csvCell).join(','), ...rows.map((r) => [csvCell(r.ts), csvText(r.actorName || ''), csvText(r.actorRole), csvText(r.entity), csvText(r.entityId), csvText(r.action), csvText(r.summary)].join(','))];
}

export async function render(ctx) {
  const { api, db, query } = ctx;
  const limit = LIMITS.includes(Number(query.limit)) ? Number(query.limit) : 100;
  const f = {
    entity: query.entity || undefined, entityId: query.entityId || undefined, from: isISODate(query.from) ? query.from : undefined,
    to: isISODate(query.to) ? query.to : undefined, actor: query.actor || undefined, q: query.q || undefined,
  };
  const extra = Object.fromEntries(['from', 'to', 'actor', 'q'].filter((k) => f[k]).map((k) => [k, f[k]]));
  const rows = await api.oversight.history({ entity: f.entity, entityId: f.entityId, ...extra, limit }); // filtered before the limit (on the server in the real app)
  const entities = [...new Set([...ENTITIES, ...rows.map((r) => r.entity), ...(f.entity ? [f.entity] : [])])].sort();
  const actors = [{ value: 'system', label: 'System (automatic)' }, ...[...db.staff].sort((a, b) => fullName(a).localeCompare(fullName(b))).map((s) => ({ value: s.id, label: fullName(s) }))];
  ctx.el.innerHTML = `${pageHead('Audit log', 'Every fee, notice, calendar and attendance change - newest first')}
    <div class="row" style="margin-bottom:12px">
      <select id="au-ent" style="width:auto" aria-label="Entity">${options(entities.map((e) => ({ value: e, label: e })), f.entity, { blank: 'All entities' })}</select>
      <input id="au-eid" type="search" placeholder="Record id" value="${esc(f.entityId || '')}" style="width:auto;min-width:140px" aria-label="Record id">
      <input id="au-q" type="search" placeholder="Search (e.g. a receipt or invoice no.)" value="${esc(f.q || '')}" style="width:auto;min-width:200px" aria-label="Search the summaries">
      <select id="au-who" style="width:auto" aria-label="Person">${options(actors, f.actor, { blank: 'Everyone' })}</select>
      <label class="row" style="gap:6px"><span style="font-weight:800;font-size:.82rem">From</span><input type="date" id="au-from" value="${esc(f.from || '')}" style="width:auto"></label>
      <label class="row" style="gap:6px"><span style="font-weight:800;font-size:.82rem">To</span><input type="date" id="au-to" value="${esc(f.to || '')}" style="width:auto"></label>
      <select id="au-lim" style="width:auto" aria-label="Rows">${options(LIMITS.map((n) => ({ value: n, label: `${n} rows` })), limit)}</select>
      <button class="btn sm" id="au-csv"${rows.length ? '' : ' disabled'}>Export CSV</button>
      <span class="muted">${esc(rows.length)} shown${rows.length === limit ? ' (the limit: narrow the filters or show more rows)' : ''}</span></div>
    ${rows.length ? `<div class="tablewrap"><table><thead><tr><th>When</th><th>Who</th><th>Entity</th><th>Action</th><th>Summary</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td class="nowrap">${fdatetime(r.ts)}</td><td>${esc(r.actorName || r.actorRole)}</td><td>${esc(r.entity)}</td><td>${esc(r.action)}</td><td>${esc(r.summary)}</td></tr>`).join('')}
    </tbody></table></div>` : empty('No audit entries match')}`;
  const set = (k) => (e) => ctx.setQuery({ [k]: e.target.value.trim() });
  ctx.el.querySelector('#au-ent').addEventListener('change', set('entity'));
  ctx.el.querySelector('#au-eid').addEventListener('change', set('entityId'));
  ctx.el.querySelector('#au-q').addEventListener('change', set('q'));
  ctx.el.querySelector('#au-who').addEventListener('change', set('actor'));
  ctx.el.querySelector('#au-from').addEventListener('change', set('from'));
  ctx.el.querySelector('#au-to').addEventListener('change', set('to'));
  ctx.el.querySelector('#au-lim').addEventListener('change', set('limit'));
  ctx.el.querySelector('#au-csv').addEventListener('click', () => downloadText(`audit-log_${todayISO()}.csv`, auditCsv(rows).join('\r\n'), 'text/csv'));
}
