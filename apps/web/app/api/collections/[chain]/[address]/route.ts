import { ACTOR_HEADER } from '@/lib/auth';
import { addressOf, bad, chainOf, handle, json, methodOf, readJson } from '@/lib/api';
import { store } from '@/lib/store';

type Ctx = { params: Promise<{ chain: string; address: string }> };

/**
 * GET: one collection's latest analysis, its history, and the tokens and
 * wallets most flagged under `?method=` (A, AU or AC; AC by default).
 */
export async function GET(req: Request, { params }: Ctx): Promise<Response> {
  return handle(async () => {
    const p = await params;
    const chainId = chainOf(p.chain);
    const address = addressOf(p.address);
    if (chainId === null || address === null) return bad('Not a chain id and collection address.', 404);
    const s = store();
    const collection = await s.collection(chainId, address);
    if (!collection) return bad('This collection is not watched.', 404);
    const method = methodOf(new URL(req.url).searchParams.get('method'));
    const [history, tokens, wallets] = await Promise.all([
      s.history(collection.id), s.topTokens(collection.id, method), s.topWallets(collection.id, method),
    ]);
    return json({ collection, method, history, tokens, wallets });
  });
}

/** DELETE: stop watching, and drop its transfers and analyses. Funding read for its wallets is kept: it is per chain. */
export async function DELETE(req: Request, { params }: Ctx): Promise<Response> {
  return handle(async () => {
    // JSON is required here too, though there is no body worth sending: it is the CSRF defence.
    const body = await readJson(req);
    if (body instanceof Response) return body;
    const p = await params;
    const chainId = chainOf(p.chain);
    const address = addressOf(p.address);
    if (chainId === null || address === null) return bad('Not a chain id and collection address.', 404);
    if (!(await store().removeCollection(chainId, address))) return bad('This collection is not watched.', 404);
    console.info('[washtrace] %s stopped watching %d/%s', decodeURIComponent(req.headers.get(ACTOR_HEADER) ?? 'anonymous'), chainId, address);
    return json({ removed: true });
  });
}
