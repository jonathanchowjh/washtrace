import { connection } from 'next/server';
import { messageOf, METHODS, type Method } from '@washtrace/detect';
import { ConfigError } from './config';

/**
 * What every API route shares: JSON in and out, parsing of the chain and
 * address in a path, and one place that turns a misconfiguration into a 503
 * that says what to set rather than a bare 500.
 */

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

export function bad(message: string, status = 400): Response {
  return json({ error: message }, status);
}

/**
 * The body of a request that changes state. JSON only: a browser cannot send
 * `application/json` cross-origin without a preflight, which is the CSRF
 * defence basic auth's ambient credentials otherwise lack.
 */
export async function readJson(req: Request): Promise<Record<string, unknown> | Response> {
  if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    return bad('Send Content-Type: application/json.', 415);
  }
  try {
    const body: unknown = await req.json();
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return bad('The body must be a JSON object.');
    return body as Record<string, unknown>;
  } catch {
    return bad('The body is not valid JSON.');
  }
}

/** Run a route's reads, mapping a missing setting to 503 and anything else to 500 with its message. */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  await connection();
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ConfigError) return bad(err.message, 503);
    console.error('[washtrace] %s', messageOf(err));
    return bad(messageOf(err), 500);
  }
}

export function chainOf(raw: string): number | null {
  return /^\d{1,10}$/.test(raw) ? Number(raw) : null;
}

/** Lowercased, because every address in the store is. */
export function addressOf(raw: string): string | null {
  const a = raw.toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(a) ? a : null;
}

export function txOf(raw: string): string | null {
  const t = raw.toLowerCase();
  return /^0x[0-9a-f]{64}$/.test(t) ? t : null;
}

export function tokenIdOf(raw: string): string | null {
  return /^\d{1,78}$/.test(raw) ? BigInt(raw).toString() : null;
}

/** AC by default: the paper's widest method, and a superset of A. */
export function methodOf(raw: string | null | undefined): Method {
  return METHODS.includes(raw as Method) ? (raw as Method) : 'AC';
}
