import { bad, handle, json, writeBody } from '@/lib/api';
import { FIELDS, pinned } from '@/lib/settings';
import { store } from '@/lib/store';
import { settingsView } from '@/lib/views';

/**
 * GET: every setting the console offers, where its value came from, and
 * whether this console may change them. A secret answers as '••••' and at
 * most its last 4: the browser can replace or clear a secret, never read it.
 */
export async function GET(req: Request): Promise<Response> {
  return handle(async () => json(await settingsView(req.headers)));
}

/**
 * POST `{key, value}`: save a setting, or with `value: null` clear it so the
 * default applies. The worker picks it up on its next pass. Refused from
 * anyone but this machine while basic auth is off, then for the Etherscan
 * URL while its key comes from the environment (a value only: clearing it
 * is always allowed), then for a value the worker
 * could not use. A console value beats the environment's, so that is no
 * reason to refuse.
 */
export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const written = await writeBody(req);
    if (written instanceof Response) return written;
    const { body, actor } = written;
    const field = FIELDS.find((f) => f.key === body.key);
    if (!field) return bad(`Unknown setting. Settings: ${FIELDS.map((f) => f.key).join(', ')}.`);
    if (body.value !== null && typeof body.value !== 'string') return bad('value must be a string, or null to clear it.');
    const s = store();
    const why = pinned(field.key, await s.sources(), await s.settings());
    // Only a value is refused: clearing a pinned field sends nothing anywhere.
    if (why !== null && body.value !== null) return bad(why, 409);
    const value = body.value === null ? null : body.value.trim();
    const invalid = value === null ? null : field.validate(value);
    if (invalid) return bad(invalid);
    await s.setSetting(field.key, value, actor);
    // The key alone: never the value logged, nor answered, since it may be a secret.
    console.info('[washtrace] %s %s %s', actor, value === null ? 'cleared' : 'set', field.key);
    return json({ key: field.key, set: value !== null });
  });
}
