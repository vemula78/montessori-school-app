// Notice attachment objects (bucket `notice-files`), server side: after a file is discarded, dropped by a correction or
// left staged for 24 hours, its object is deleted and the row marked (notices.finishFileDelete); cron-daily's
// filesCleanup retries a failure and expires staged files.

import { restAll, inList } from './db.ts';
import { runCommand } from './persist.ts';
import { system } from './authz.ts';
import { removeObjects } from './files.ts';
import { NOTICE_FILE_BUCKET } from './domain/notice-files.js';

/** Removed files whose object is not deleted yet (these ids, or all): delete the objects, then mark the rows. */
export async function cleanupNoticeFiles(ids: string[] | null = null) {
  const filter = ids ? `&id=in.${inList(ids)}` : '';
  const rows = await restAll(`notice_files?status=eq.removed&doc->>objectDeletedAt=is.null${filter}&select=id,path:doc->>path&order=id`);
  const out = { removed: rows.length, objectsDeleted: 0, finished: 0, errors: [] as string[] };
  if (!rows.length) return out;
  const withPath = rows.filter((r: any) => r.path && !String(r.path).startsWith('demo/'));
  try { out.objectsDeleted = withPath.length ? await removeObjects(NOTICE_FILE_BUCKET, withPath.map((r: any) => r.path)) : 0; } catch (e: any) { out.errors.push(String(e?.message || e)); return out; }
  out.finished = (await runCommand('notices.finishFileDelete', [{ fileIds: rows.map((r: any) => r.id) }], system('notice-files'))).result.finished;
  return out;
}
