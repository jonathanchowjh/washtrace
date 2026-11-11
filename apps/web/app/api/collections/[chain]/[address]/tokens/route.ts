import { collectionFrom, handle, json, notWatched, writeBody } from '@/lib/api';

type Ctx = { params: Promise<{ chain: string; address: string }> };

/**
 * POST `{}`: read the listed other tokens of this collection's wallets, out to
 * its hop limit, for this collection only (Start reading them). The worker
 * walks and reads in its own time, so the answer is 202 `{ started: true }`.
 * Pressed again it changes nothing and answers 200 `{ started: false }`.
 * There is no Stop.
 */
export async function POST(req: Request, { params }: Ctx): Promise<Response> {
  return handle(async () => {
    const written = await writeBody(req);
    if (written instanceof Response) return written;
    const found = await collectionFrom(params);
    if (found instanceof Response) return found;
    const { s, chainId, address, collection: c } = found;
    const set = await s.startTokens(c.id);
    if (set === 'gone') return notWatched();
    if (set === 'set') console.info('[washtrace] %s started reading other tokens of %d/%s', written.actor, chainId, address);
    return json({ started: set === 'set' }, set === 'set' ? 202 : 200);
  });
}
