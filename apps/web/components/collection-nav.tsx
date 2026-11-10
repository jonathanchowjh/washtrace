'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { cn } from '@/lib/utils';
import { KindIcon, type Kind } from './kit';
import { Time } from './time';

export type CollectionTab = 'overview' | 'tokens' | 'wallets' | 'trades';

/**
 * The tab a path under a collection belongs to: a list lights its own tab,
 * and one thing from it (a token, a trade) lights the list it came from, so
 * a reader always sees which part of the collection they are in.
 */
export function tabOf(base: string, path: string): CollectionTab {
  const rest = path.startsWith(base) ? path.slice(base.length) : '';
  if (rest.startsWith('/tokens') || rest.startsWith('/t/')) return 'tokens';
  if (rest.startsWith('/wallets') || rest.startsWith('/w/')) return 'wallets';
  if (rest.startsWith('/trades') || rest.startsWith('/tx/')) return 'trades';
  return 'overview';
}

// The built-ins in METHODS' order, written out: the detect package's root is not for the browser.
const BUILT_INS = ['A', 'AU', 'AC'];

/**
 * The lens the Tokens and Wallets tabs open on: the one the address bar
 * names, or on Trades the first lens its "flagged by" filter holds, a
 * built-in before yours. Null leaves the default.
 */
export function lensOf(sp: URLSearchParams, tab: CollectionTab): string | null {
  const named = sp.get('method');
  if (named !== null || tab !== 'trades') return named;
  const caught = (sp.get('caught') ?? '').split(',').filter((k) => k !== '');
  return BUILT_INS.find((m) => caught.includes(m)) ?? caught[0] ?? null;
}

const TABS: readonly { tab: CollectionTab; label: string; kind: Kind }[] = [
  { tab: 'overview', label: 'Overview', kind: 'collection' },
  { tab: 'tokens', label: 'Tokens', kind: 'token' },
  { tab: 'wallets', label: 'Wallets', kind: 'wallet' },
  { tab: 'trades', label: 'Trades', kind: 'transaction' },
];

/**
 * The collection's parent line and its tabs, on every page under it. The
 * counts are Linked wallets' lists, the default lens, so they are hidden while
 * the address bar picks another: a count beside a list of a different size
 * would contradict it. A chosen lens is carried to the Tokens and Wallets tabs.
 */
export function CollectionNav({ base, name, analysedAt, counts }: {
  base: string;
  name: string;
  analysedAt: number | null;
  /** Each tab's count badge, streamed in: nothing shows until it is read, or when there is none to show. */
  counts: Partial<Record<Exclude<CollectionTab, 'overview'>, ReactNode>>;
}) {
  const current = tabOf(base, usePathname());
  const method = lensOf(useSearchParams(), current);
  const defaultLens = method === null || method === 'AC';
  const hrefOf = (tab: CollectionTab) =>
    tab === 'overview' ? base
      : tab === 'trades' ? `${base}/trades`
        : `${base}/${tab}${method === null ? '' : `?method=${encodeURIComponent(method)}`}`;
  return (
    <div className="pt-4">
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
        <Link href="/" className="hover:text-foreground hover:underline">Collections</Link>
        <span aria-hidden>/</span>
        <Link href={base} className="inline-flex items-center gap-1 font-medium text-foreground hover:underline">
          <KindIcon kind="collection" />{name}
        </Link>
        {analysedAt === null ? null : <span>· analysed <Time ms={analysedAt} /></span>}
      </p>
      <nav aria-label={`${name}: overview, tokens, wallets and trades`} className="mt-2 flex max-w-full gap-1 overflow-x-auto border-b">
        {TABS.map(({ tab, label, kind }) => {
          const count = tab === 'overview' || (tab !== 'trades' && !defaultLens) ? null : counts[tab];
          return (
            <Link key={tab} href={hrefOf(tab)} aria-current={tab === current ? 'page' : undefined}
              className={cn('-mb-px inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium',
                tab === current ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
              <KindIcon kind={kind} />{label}
              {count}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
