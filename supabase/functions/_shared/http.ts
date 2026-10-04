// JSON-over-POST plumbing shared by every function: CORS, coded errors {error:{code, message}}, status mapping.
// Error text never carries personal data: domain messages carry ids and amounts; unexpected errors are logged
// server-side and answered with a generic message.

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export class Coded extends Error {
  code: string;
  details?: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
export const coded = (code: string, message: string, details?: unknown) => new Coded(code, message, details);

const STATUS: Record<string, number> = {
  BAD_REQUEST: 400, UNAUTHENTICATED: 401, NOT_ALLOWED: 403, TWO_STEP_REQUIRED: 403, NOT_FOUND: 404, CONFLICT: 409, VALIDATION: 422, INVALID_AMOUNT: 422,
  OVERPAYMENT_NOT_ALLOWED: 422, INVOICE_LOCKED: 422, NOT_WORKING_DAY: 422, RATE_LIMITED: 429, GATEWAY: 502,
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

export function errorResponse(e: any): Response {
  const code = e && typeof e.code === 'string' && STATUS[e.code] ? e.code : null;
  if (!code) {
    console.error('unexpected error:', e && e.stack ? e.stack : e);
    return json({ error: { code: 'INTERNAL', message: 'Something went wrong on the server; nothing was saved.' } }, 500);
  }
  return json({ error: { code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}) } }, STATUS[code]);
}

/** POST-only JSON handler with CORS preflight. */
export function serve(handler: (req: Request) => Promise<unknown>) {
  Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method !== 'POST') return json({ error: { code: 'NOT_FOUND', message: 'POST only' } }, 405);
    try {
      return json(await handler(req));
    } catch (e) {
      return errorResponse(e);
    }
  });
}

export async function body(req: Request): Promise<any> {
  try { return await req.json(); } catch { throw coded('VALIDATION', 'Request body must be JSON'); }
}
