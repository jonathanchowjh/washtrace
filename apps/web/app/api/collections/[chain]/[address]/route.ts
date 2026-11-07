import { moneyFor } from '@washtrace/detect';
import { addressOf, bad, chainOf, handle, json, methodOf, writeBody } from '@/lib/api';
import { lensesRan } from '@/lib/metrics';
import { store } from '@/lib/store';

const NOT_PAUSED = 'Pause this collection before deleting its data.';

type Ctx = { params: Promise<{ chain: string; address: string }> };

/**
 * GET: one collection's latest analysis, its history, and the 50 tokens and
 * wallets with the most trades caught under `?method=` (A, AU or AC; AC by
 * default), each `{ rows, total }`, as the console's lists read them. A lens
 * that did not run lists none.
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
    // UTC, not the reader's cookie zone as the trades route reads: the lens lists do not bucket by month.
    const ctx = { money: moneyFor(chainId), ran: lensesRan(collection.latest), zone: 'UTC' };
    const top = { sort: 'caught', find: null, limit: 50, offset: 0 } as const;
    const [history, tokens, wallets] = await Promise.all([
      s.history(collection.id), s.lensTokens(collection.id, method, top, ctx), s.lensWallets(collection.id, method, top, ctx),
    ]);
    return json({ collection, method, history, tokens, wallets });
  });
}

/** DELETE: stop watching, and drop its transfers and analyses, but only once it is paused, so the worker is not serving what is being deleted. The pre-read gives 404 or 409; the store's own paused condition makes the delete safe against a concurrent resume, and a false from it is re-read once to answer 404 (gone) or 409 (resumed). Funding read for its wallets is kept: it is per chain. */
export async function DELETE(req: Request, { params }: Ctx): Promise<Response> {
  return handle(async () => {
    const written = await writeBody(req);
    if (written instanceof Response) return written;
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
    console.info('[washtrace] %s stopped watching %d/%s', written.actor, chainId, address);
    return json({ removed: true });
  });
}
