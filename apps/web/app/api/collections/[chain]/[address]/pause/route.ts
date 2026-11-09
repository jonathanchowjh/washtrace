import { collectionFrom, handle, json, writeBody } from '@/lib/api';

type Ctx = { params: Promise<{ chain: string; address: string }> };

/** POST: stop the worker serving the collection, keeping its data. Idempotent: answers `{ paused }` as it now stands, and 404 only when the collection is not watched. */
export async function POST(req: Request, { params }: Ctx): Promise<Response> {
  return handle(async () => {
    const written = await writeBody(req);
    if (written instanceof Response) return written;
    const found = await collectionFrom(params);
    if (found instanceof Response) return found;
    const { s, chainId, address } = found;
    await s.pause(chainId, address);
    console.info('[washtrace] %s paused %d/%s', written.actor, chainId, address);
    return json({ paused: true });
  });
}
