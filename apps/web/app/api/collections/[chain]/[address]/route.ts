import { ACTOR_HEADER } from '@/lib/auth';
import { addressOf, bad, chainOf, handle, json, methodOf, readJson } from '@/lib/api';
import { store } from '@/lib/store';

const NOT_PAUSED = 'Pause this collection before deleting its data.';

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

/** DELETE: stop watching, and drop its transfers and analyses, but only once it is paused, so the worker is not serving what is being deleted. The pre-read gives 404 or 409; the store's own paused condition makes the delete safe against a concurrent resume, and a false from it is re-read once to answer 404 (gone) or 409 (resumed). Funding read for its wallets is kept: it is per chain. */
export async function DELETE(req: Request, { params }: Ctx): Promise<Response> {
  return handle(async () => {
    // JSON is required here too, though there is no body worth sending: it is the CSRF defence.
    const body = await readJson(req);
    if (body instanceof Response) return body;
    const p = await params;
    const chainId = chainOf(p.chain);
    const address = addressOf(p.address);
    if (chainId === null || address === null) return bad('Not a chain id and collection address.', 404);
    const s = store();
    const collection = await s.collection(chainId, address);
    if (!collection) return bad('This collection is not watched.', 404);
    if (collection.pausedAt === null) return bad(NOT_PAUSED, 409);
    if (!(await s.removeCollection(chainId, address))) {
      // The store deletes only paused rows, so a resume between our read and its delete lands here: say which it was.
      return (await s.collection(chainId, address)) ? bad(NOT_PAUSED, 409) : bad('This collection is not watched.', 404);
    }
    console.info('[washtrace] %s stopped watching %d/%s', decodeURIComponent(req.headers.get(ACTOR_HEADER) ?? 'anonymous'), chainId, address);
    return json({ removed: true });
  });
}
