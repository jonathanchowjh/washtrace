import { addressOf, bad, chainOf, handle, json, writeBody } from '@/lib/api';
import { store } from '@/lib/store';

type Ctx = { params: Promise<{ chain: string; address: string }> };

/** POST: let the worker serve the collection again. Idempotent: answers `{ paused }` as it now stands, and 404 only when the collection is not watched. */
export async function POST(req: Request, { params }: Ctx): Promise<Response> {
  return handle(async () => {
    const written = await writeBody(req);
    if (written instanceof Response) return written;
    const p = await params;
    const chainId = chainOf(p.chain);
    const address = addressOf(p.address);
    if (chainId === null || address === null) return bad('Not a chain id and collection address.', 404);
    const s = store();
    if (!(await s.collection(chainId, address))) return bad('This collection is not watched.', 404);
    await s.resume(chainId, address);
    console.info('[washtrace] %s resumed %d/%s', written.actor, chainId, address);
    return json({ paused: false });
  });
}
