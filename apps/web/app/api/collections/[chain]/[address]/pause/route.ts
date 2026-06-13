import { ACTOR_HEADER } from '@/lib/auth';
import { addressOf, bad, chainOf, handle, json, readJson } from '@/lib/api';
import { store } from '@/lib/store';

type Ctx = { params: Promise<{ chain: string; address: string }> };

/** POST: stop the worker serving the collection, keeping its data. Idempotent: answers `{ paused }` as it now stands, and 404 only when the collection is not watched. */
export async function POST(req: Request, { params }: Ctx): Promise<Response> {
  return handle(async () => {
    // JSON is required here too, though there is no body worth sending: it is the CSRF defence.
    const body = await readJson(req);
    if (body instanceof Response) return body;
    const p = await params;
    const chainId = chainOf(p.chain);
    const address = addressOf(p.address);
    if (chainId === null || address === null) return bad('Not a chain id and collection address.', 404);
    const s = store();
    if (!(await s.collection(chainId, address))) return bad('This collection is not watched.', 404);
    await s.pause(chainId, address);
    console.info('[washtrace] %s paused %d/%s', decodeURIComponent(req.headers.get(ACTOR_HEADER) ?? 'anonymous'), chainId, address);
    return json({ paused: true });
  });
}
