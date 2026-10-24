// Signature objects (bucket `signatures`), server side: after a signature is replaced or removed its object is deleted
// at once and the row marked (signatures.finishDelete); a failure is logged and cron-daily's filesCleanup retries it.

import { restAll, inList } from './db.ts';
import { runCommand } from './persist.ts';
import { system } from './authz.ts';
import { removeObjects } from './files.ts';
import { SIGNATURE_BUCKET } from './domain/signatures.js';

/** Removed signatures whose object is not deleted yet (these ids, or all): delete the objects, then mark the rows. */
export async function cleanupSignatures(ids: string[] | null = null) {
  const filter = ids ? `&id=in.${inList(ids)}` : '';
  const rows = await restAll(`signatures?status=eq.removed&doc->>objectDeletedAt=is.null${filter}&select=id,path:doc->>path&order=id`);
  const out = { removed: rows.length, objectsDeleted: 0, finished: 0, errors: [] as string[] };
  if (!rows.length) return out;
  const withPath = rows.filter((r: any) => r.path && !String(r.path).startsWith('demo/'));
  try { out.objectsDeleted = withPath.length ? await removeObjects(SIGNATURE_BUCKET, withPath.map((r: any) => r.path)) : 0; } catch (e: any) { out.errors.push(String(e?.message || e)); return out; }
  out.finished = (await runCommand('signatures.finishDelete', [{ signatureIds: rows.map((r: any) => r.id) }], system('signatures'))).result.finished;
  return out;
}
