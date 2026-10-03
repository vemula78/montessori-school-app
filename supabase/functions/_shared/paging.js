// Paged reads (pure; node-testable). PostgREST caps every response at max_rows (1000), silently: a caller that
// needs ALL rows reads page after page until a page comes back short.

/**
 * @param {(offset:number, limit:number) => Promise<any[]>} fetchPage  must use a stable order
 * @param {number} pageSize  at most the server's max_rows
 */
export async function fetchAllPages(fetchPage, pageSize = 1000) {
  const out = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await fetchPage(offset, pageSize);
    out.push(...page);
    if (page.length < pageSize) return out;
  }
}
