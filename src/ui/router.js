// Hash router: #/path/:param?query=1. GitHub Pages has no SPA rewrites, so hash only.
export function parseHash(hash = location.hash) {
  let h = hash.replace(/^#/, '');
  if (!h.startsWith('/')) h = '/' + h;
  const qi = h.indexOf('?');
  const path = qi < 0 ? h : h.slice(0, qi);
  const query = {};
  if (qi >= 0) { try { for (const [k, v] of new URLSearchParams(h.slice(qi + 1))) query[k] = v; } catch { /* ignore a malformed query */ } }
  return { path: path.replace(/\/+$/, '') || '/', query };
}

export function href(path, query) {
  const q = query ? Object.entries(query).filter(([, v]) => v != null && v !== '') : [];
  return '#' + path + (q.length ? '?' + new URLSearchParams(q).toString() : '');
}

export function go(path, query) {
  const next = href(path, query);
  if (location.hash === next) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = next;
}

// Replace the query without adding a history entry (filters, month paging).
export function setQuery(patch, { replace = true } = {}) {
  const { path, query } = parseHash();
  const merged = { ...query, ...patch };
  const next = href(path, merged);
  if (replace) location.replace(next); else location.hash = next;
}

// routes: [{pattern:'/fees/invoice/:id', roles:[...]|null, load:()=>import(), nav:'/fees'}]
export function matchRoute(routes, path) {
  for (const r of routes) {
    const names = [];
    const re = new RegExp('^' + r.pattern.replace(/:[A-Za-z]+/g, (m) => { names.push(m.slice(1)); return '([^/]+)'; }) + '$');
    const m = re.exec(path);
    if (m) {
      const params = {};
      try { names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); }); } catch { return null; } // malformed %-escape = no such page
      return { route: r, params };
    }
  }
  return null;
}

export function startRouter(onChange) {
  window.addEventListener('hashchange', onChange);
  onChange();
}
