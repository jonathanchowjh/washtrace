import { moneyFor } from '@washtrace/detect';
import { NO_FILTER } from '@washtrace/detect/trades';
import { collectionFrom, handle, json } from '@/lib/api';
import { lensContext } from '@/lib/metrics';

type Ctx = { params: Promise<{ chain: string; address: string }> };

/**
 * GET: the counts on a collection's tabs, as each list counts itself: every
 * sale for Trades, and Linked wallets' tokens and wallets, the default lens,
 * once it has run (null before). The tab bar asks for them from the browser,
 * once a page: in the layout they ran again for every prefetch of a tab and
 * every 15 s refresh.
 */
export async function GET(_req: Request, { params }: Ctx): Promise<Response> {
  return handle(async () => {
    const found = await collectionFrom(params);
    if (found instanceof Response) return found;
    const { s, chainId, collection: c } = found;
    // No date is read, so no zone is needed.
    const ctx = { money: moneyFor(chainId), zone: 'UTC', ...lensContext(c.latest, await s.lensRuns(c.id)) };
    const none = { sort: 'caught', find: null, limit: 0, offset: 0 } as const;
    const listed = ctx.ran.includes('AC');
    const [trades, tokens, wallets] = await Promise.all([
      s.tradeCount(c.id, NO_FILTER, ctx),
      listed ? s.lensTokens(c.id, 'AC', none, ctx) : null,
      listed ? s.lensWallets(c.id, 'AC', none, ctx) : null,
    ]);
    return json({ trades: trades.total, tokens: tokens?.total ?? null, wallets: wallets?.total ?? null });
  });
}
