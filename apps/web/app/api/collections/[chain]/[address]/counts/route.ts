import { moneyFor } from '@washtrace/detect';
import { NO_FILTER } from '@washtrace/detect/trades';
import { collectionFrom, handle, json, lensKeyOf } from '@/lib/api';
import { lensContext, ownLenses } from '@/lib/metrics';

type Ctx = { params: Promise<{ chain: string; address: string }> };

/**
 * GET `?method=`: the counts on a collection's tabs, as each list counts
 * itself: every sale for Trades, and the tokens and wallets the lens flags,
 * once it has run (null before, which the tab says). The lens is read as the
 * lists read it: one that does not exist is the default, Linked wallets. The
 * tab bar asks for the lens in view from the browser, once a page: in the
 * layout they ran again for every prefetch of a tab and every 15 s refresh.
 */
export async function GET(req: Request, { params }: Ctx): Promise<Response> {
  return handle(async () => {
    const found = await collectionFrom(params);
    if (found instanceof Response) return found;
    const { s, chainId, collection: c } = found;
    const runs = await s.lensRuns(c.id);
    // No date is read, so no zone is needed.
    const ctx = { money: moneyFor(chainId), zone: 'UTC', ...lensContext(c.latest, runs) };
    const method = lensKeyOf(new URL(req.url).searchParams.get('method'), ownLenses(runs));
    const none = { sort: 'caught', find: null, limit: 0, offset: 0 } as const;
    const listed = ctx.ran.includes(method);
    const [trades, tokens, wallets] = await Promise.all([
      s.tradeCount(c.id, NO_FILTER, ctx),
      listed ? s.lensTokens(c.id, method, none, ctx) : null,
      listed ? s.lensWallets(c.id, method, none, ctx) : null,
    ]);
    return json({ trades: trades.total, tokens: tokens?.total ?? null, wallets: wallets?.total ?? null });
  });
}
