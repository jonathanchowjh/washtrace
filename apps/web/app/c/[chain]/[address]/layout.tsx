import { Suspense, type ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { METHODS, moneyFor, type CollectionRow } from '@washtrace/detect';
import { NO_FILTER } from '@washtrace/detect/trades';
import { CollectionNav } from '@/components/collection-nav';
import { readerZone } from '@/lib/api';
import { collectionOf, runsOf } from '@/lib/collection-reads';
import { num, short } from '@/lib/format';
import { lensContext } from '@/lib/metrics';
import { addressOf, chainOf } from '@/lib/params';
import { store } from '@/lib/store';

type Props = { params: Promise<{ chain: string; address: string }>; children: ReactNode };

/**
 * Every page of one collection sits under its parent line and tab bar, so a
 * token, a list or a trade always says which collection it belongs to and
 * which part of it the reader is in. The counts stream in after the page: a
 * slow count never holds the page back.
 */
export default async function CollectionLayout({ params, children }: Props) {
  await connection();
  const p = await params;
  const chainId = chainOf(p.chain);
  const address = addressOf(p.address);
  if (chainId === null || address === null) notFound();
  const c = await collectionOf(chainId, address);
  if (!c) notFound();
  const count = (kind: Counted) => <Suspense fallback={null}><Count c={c} kind={kind} /></Suspense>;
  // The page under it reads the same runs, from the same request's cache.
  const lenses = [...METHODS, ...(await runsOf(c.id)).map((r) => r.lens.key)];
  return (
    <>
      <CollectionNav base={`/c/${chainId}/${address}`} name={c.name ?? short(address)} analysedAt={c.latest?.ranAt ?? null} lenses={lenses}
        counts={{ tokens: count('tokens'), wallets: count('wallets'), trades: count('trades') }} />
      {children}
    </>
  );
}

type Counted = 'tokens' | 'wallets' | 'trades';

/**
 * A tab's count as its list counts it: the trades are every sale, as Trades
 * opens; the tokens and wallets are Linked wallets', the default lens, and
 * only once it has run. A count that cannot be read shows nothing.
 */
async function Count({ c, kind }: { c: CollectionRow; kind: Counted }) {
  try {
    const ctx = { money: moneyFor(c.chainId), zone: await readerZone(), ...lensContext(c.latest, await runsOf(c.id)) };
    const s = store();
    const none = { sort: 'caught', find: null, limit: 0, offset: 0 } as const;
    const n = kind === 'trades' ? (await s.tradeCount(c.id, NO_FILTER, ctx)).total
      : !ctx.ran.includes('AC') ? null
        : kind === 'tokens' ? (await s.lensTokens(c.id, 'AC', none, ctx)).total
          : (await s.lensWallets(c.id, 'AC', none, ctx)).total;
    return n === null ? null : <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">{num(n)}</span>;
  } catch {
    return null;
  }
}
