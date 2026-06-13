import { ACTOR_HEADER, authConfigured } from '@/lib/auth';
import { bad, handle, json, readJson } from '@/lib/api';
import { FIELDS, READ_ONLY, pinned } from '@/lib/settings';
import { store } from '@/lib/store';
import { settingsView } from '@/lib/views';

/**
 * GET: every setting the console offers, where its value came from, and
 * whether this console may change them. A secret answers as '••••' and at
 * most its last 4: the browser can replace or clear a secret, never read it.
 */
export async function GET(): Promise<Response> {
  return handle(async () => json(await settingsView()));
}

/**
 * POST `{key, value}`: save a setting, or with `value: null` clear it so the
 * default applies. The worker picks it up on its next pass. Refused while
 * basic auth is off (anyone could change it), then for a value the
 * environment pins (it set the value, or the Etherscan key the URL follows),
 * then for a value the worker could not use.
 */
export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    if (!authConfigured(process.env)) return bad(READ_ONLY, 403);
    const body = await readJson(req);
    if (body instanceof Response) return body;
    const field = FIELDS.find((f) => f.key === body.key);
    if (!field) return bad(`Unknown setting. Settings: ${FIELDS.map((f) => f.key).join(', ')}.`);
    if (body.value !== null && typeof body.value !== 'string') return bad('value must be a string, or null to clear it.');
    const s = store();
    const why = pinned(field.key, await s.sources());
    if (why !== null) return bad(why, 409);
    const value = body.value === null ? null : body.value.trim();
    const invalid = value === null ? null : field.validate(value);
    if (invalid) return bad(invalid);
    const actor = decodeURIComponent(req.headers.get(ACTOR_HEADER) ?? 'console');
    await s.setSetting(field.key, value, actor);
    // The key alone: never the value logged, nor answered, since it may be a secret.
    console.info('[washtrace] %s %s %s', actor, value === null ? 'cleared' : 'set', field.key);
    return json({ key: field.key, set: value !== null });
  });
}
