// Which entry point is running. The demo (root index.html) and the real app (app/index.html) are separate
// pages; the api object reports which one it is. Screens only ever ask this question here.
import { api } from '../api/index.js';

/** true for the real app, false for the public demo (also false while an older api build has no `mode`). */
export const isRealMode = () => api.mode !== undefined && api.mode !== 'demo';

/** Shown where the real app offers something the demo cannot. */
export function realOnlyNotice(what) {
  return `<div class="empty"><div class="big">${what} is available in the real app</div><div>This public demo uses fake data in your browser only, so there is nothing to connect to. The real school app has this feature switched on.</div></div>`;
}
