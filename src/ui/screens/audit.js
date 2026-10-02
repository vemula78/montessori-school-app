// Audit log viewer (newest first).
import { esc, fdatetime, empty, pageHead, options } from '../components.js';

export async function render(ctx) {
  const { api, query } = ctx;
  const limit = [50, 100, 250, 500].includes(Number(query.limit)) ? Number(query.limit) : 100;
  const entity = query.entity || '';
  const all = await api.audit.list({ limit: 500 }); // only used to build the entity list
  const entities = [...new Set(all.map((r) => r.entity).concat(entity ? [entity] : []))].sort();
  const rows = entity ? await api.audit.list({ entity, limit }) : all.slice(0, limit); // filter BEFORE limiting
  ctx.el.innerHTML = `${pageHead('Audit log', 'Every fee, notice, calendar and attendance change - newest first')}
    <div class="row" style="margin-bottom:12px">
      <select id="au-ent" style="width:auto" aria-label="Entity">${options(entities.map((e) => ({ value: e, label: e })), entity, { blank: 'All entities' })}</select>
      <select id="au-lim" style="width:auto" aria-label="Rows">${options([50, 100, 250, 500].map((n) => ({ value: n, label: `${n} rows` })), limit)}</select>
      <span class="muted">${rows.length} shown</span></div>
    ${rows.length ? `<div class="tablewrap"><table><thead><tr><th>When</th><th>Who</th><th>Entity</th><th>Action</th><th>Summary</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td class="nowrap">${fdatetime(r.ts)}</td><td>${esc(r.actorRole)}</td><td>${esc(r.entity)}</td><td>${esc(r.action)}</td><td>${esc(r.summary)}</td></tr>`).join('')}
    </tbody></table></div>` : empty('No audit entries')}`;
  ctx.el.querySelector('#au-ent').addEventListener('change', (e) => ctx.setQuery({ entity: e.target.value }));
  ctx.el.querySelector('#au-lim').addEventListener('change', (e) => ctx.setQuery({ limit: e.target.value }));
}
