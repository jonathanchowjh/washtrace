import { moneyFor } from '@washtrace/detect';
import { NO_FILTER, type TradeQuery } from '@washtrace/detect/trades';
import { readerZone } from '@/lib/api';
import { collectionOf, runsOf } from '@/lib/collection-reads';
import { lensContext } from '@/lib/metrics';
import { store } from '@/lib/store';
import { tradesHref } from '@/lib/trades-url';
import { SQUARES, SalesStrip } from './overview';

/** The most of one item's sales read to outline: a wallet past it is outlined by its first, and its count says so. */
export const MINE = 2000;

/**
 * The collection's strip of every sale on a token, wallet, ring or trade page,
 * that item's sales outlined, so where it sits among the rest stays on screen.
 * `of` picks its sales as the Trades tab's filter does. Nothing before the
 * first analysis, or for an item with no sale. Rendered in a Suspense of its
 * own by the page: it reads the collection's timeline.
 */
export async function WhereItSits({ chainId, address, of, label }: {
  chainId: number; address: string; of: Partial<Pick<TradeQuery, 'wallet' | 'token' | 'ring' | 'find'>>; label: string;
}) {
  const c = await collectionOf(chainId, address);
  if (!c?.latest) return null;
  const [runs, zone] = await Promise.all([runsOf(c.id), readerZone()]);
  const ctx = { money: moneyFor(chainId), zone, ...lensContext(c.latest, runs) };
  const s = store();
  const asc = { ...NO_FILTER, sort: 'date', dir: 'asc' } as const;
  // As on the overview: a small collection's strip is a square per sale, every sale read.
  const few = c.latest.totals.A.sales <= SQUARES;
  const [timeline, sold, own] = await Promise.all([
    s.timeline(c.id, zone),
    few ? s.trades(c.id, asc, ctx, SQUARES + 1, 0) : null,
    s.trades(c.id, { ...asc, ...of }, ctx, MINE, 0),
  ]);
  if (own.length === 0) return null;
  const base = `/c/${chainId}/${address}`;
  const mine = {
    keys: new Set(own.map((r) => `${r.txHash}:${r.logIndex}`)),
    times: own.flatMap((r) => (r.blockTime === null ? [] : [r.blockTime * 1000])),
    label, href: tradesHref(base, of),
  };
  return <SalesStrip timeline={timeline} base={base} zone={zone} chainId={chainId} sales={sold} mine={mine} />;
}
