import { connection } from 'next/server';
import { messageOf, METHODS, type Method } from '@washtrace/detect';
import type { LensKey } from '@washtrace/detect/trades';
import { ACTOR_HEADER, LOCAL_ONLY, mayWrite } from './auth';
import { ConfigError } from './config';

export { addressOf, chainIdOf, chainOf, idOf, tokenIdOf, txOf } from './params';

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

/** The refusal of a request that changes state when this console may not be written to, else null. */
export function refuseWrite(req: Request): Response | null {
  return mayWrite(process.env, req.headers) ? null : bad(LOCAL_ONLY, 403);
}

/** Who made the request, for the log line of a change; whoever the proxy named, else 'anonymous'. */
export function actorOf(req: Request): string {
  return decodeURIComponent(req.headers.get(ACTOR_HEADER) ?? 'anonymous');
}

/**
 * The start of every write route: refused unless this console may be written
 * to, then its JSON body, with the actor for the log. A route with no body
 * worth sending (pause, delete) still takes this: requiring JSON is the CSRF
 * defence.
 */
export async function writeBody(req: Request): Promise<{ body: Record<string, unknown>; actor: string } | Response> {
  const refused = refuseWrite(req);
  if (refused) return refused;
  const body = await readJson(req);
  return body instanceof Response ? body : { body, actor: actorOf(req) };
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

/** AC by default: the lens that counts the most, and a superset of Round trips. */
export function methodOf(raw: string | null | undefined): Method {
  return METHODS.includes(raw as Method) ? (raw as Method) : 'AC';
}

/** A built-in's key, or the key of one of your lenses that exists (`own`'s keys); anything else is AC, as methodOf reads it. */
export function lensKeyOf(raw: string | null | undefined, own: Record<string, unknown>): LensKey {
  if (raw != null && Object.hasOwn(own, raw)) return raw as LensKey;
  return methodOf(raw);
}
