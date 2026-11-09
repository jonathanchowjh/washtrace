import { addressOf, bad, chainOf, handle, json, writeBody } from '@/lib/api';
import { store } from '@/lib/store';

type Ctx = { params: Promise<{ chain: string; address: string }> };

/**
 * POST `{}`: read the listed other tokens of this collection's wallets, out to
 * its hop limit, for this collection only (Start reading them). The worker
 * walks and reads in its own time, so the answer is 202 `{ started: true }`.
 * Pressed again it changes nothing and answers 200 `{ started: false }`.
 * There is no Stop in this slice.
 */
export async function POST(req: Request, { params }: Ctx): Promise<Response> {
  return handle(async () => {
    const written = await writeBody(req);
    if (written instanceof Response) return written;
    const p = await params;
    const chainId = chainOf(p.chain);
    const address = addressOf(p.address);
    if (chainId === null || address === null) return bad('Not a chain id and collection address.', 404);
    const s = store();
    const c = await s.collection(chainId, address);
    if (!c) return bad('This collection is not watched.', 404);
    const set = await s.startTokens(c.id);
    if (set === 'gone') return bad('This collection is not watched.', 404);
    if (set === 'set') console.info('[washtrace] %s started reading other tokens of %d/%s', written.actor, chainId, address);
    return json({ started: set === 'set' }, set === 'set' ? 202 : 200);
  });
}
