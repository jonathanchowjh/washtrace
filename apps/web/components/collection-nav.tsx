'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { cn } from '@/lib/utils';
import { KindIcon, type Kind } from './kit';
import { Time } from './time';

type CollectionTab = 'overview' | 'methods' | 'rings' | 'tokens' | 'wallets' | 'trades';

/**
 * The tab a path under a collection belongs to: a list lights its own tab,
 * and one thing from it (a token, a trade) lights the list it came from, so
 * a reader always sees which part of the collection they are in.
 */
export function tabOf(base: string, path: string): CollectionTab {
  const rest = path.startsWith(base) ? path.slice(base.length) : '';
  if (rest.startsWith('/methods')) return 'methods';
  if (rest.startsWith('/rings') || rest.startsWith('/r/')) return 'rings';
  if (rest.startsWith('/tokens') || rest.startsWith('/t/')) return 'tokens';
  if (rest.startsWith('/wallets') || rest.startsWith('/w/')) return 'wallets';
  if (rest.startsWith('/trades') || rest.startsWith('/tx/')) return 'trades';
  return 'overview';
}

/**
 * The lens the Tokens and Wallets tabs open on: the one the address bar
 * names, or on Trades the first lens its "flagged by" filter holds, a
 * built-in before yours. `lenses` are the keys that exist, the built-ins
 * first in METHODS' order: anything else (the overview's Compare tab, a
 * deleted lens) is no lens, and null leaves the default.
 */
export function lensOf(sp: URLSearchParams, tab: CollectionTab, lenses: readonly string[]): string | null {
  const named = sp.get('method');
  if (named !== null) return lenses.includes(named) ? named : null;
  if (tab !== 'trades') return null;
  const caught = (sp.get('caught') ?? '').split(',');
  return lenses.find((m) => caught.includes(m)) ?? null;
}

/**
 * Scroll a tab bar sideways just far enough that its lit tab shows: on a phone
 * the bar is wider than the screen, and Trades, the last tab, would sit off it.
 * It moves the bar's own scrollLeft, as scrollIntoView could scroll the page
 * down to the bar too. The bar is the tabs' offsetParent, so their offsets are
 * within it.
 */
export function revealTab(bar: HTMLElement, tab: HTMLElement) {
  const right = tab.offsetLeft + tab.offsetWidth;
  if (tab.offsetLeft < bar.scrollLeft) bar.scrollLeft = tab.offsetLeft;
  else if (right > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = right - bar.clientWidth;
}

const TABS: readonly { tab: CollectionTab; label: string; kind: Kind }[] = [
  { tab: 'overview', label: 'Overview', kind: 'collection' },
  { tab: 'methods', label: 'Methods', kind: 'lens' },
  { tab: 'rings', label: 'Rings', kind: 'ring' },
  { tab: 'tokens', label: 'Tokens', kind: 'token' },
  { tab: 'wallets', label: 'Wallets', kind: 'wallet' },
  { tab: 'trades', label: 'Trades', kind: 'transaction' },
];

/**
 * The collection's parent line and its tabs, on every page under it. The
 * counts are Linked wallets' lists, the default lens, so they are hidden while
 * the address bar picks another: a count beside a list of a different size
 * would contradict it. Trades counts every sale, the collection's own figure:
 * a filter's matches are said by the list's own line. A chosen lens is carried
 * to the Tokens and Wallets tabs.
 */
export function CollectionNav({ base, name, analysedAt, lenses, counts }: {
  base: string;
  name: string;
  analysedAt: number | null;
  /** Every lens key that exists here, the built-ins first in METHODS' order. */
  lenses: readonly string[];
  /** Each tab's count badge, streamed in: nothing shows until it is read, or when there is none to show. */
  counts: Partial<Record<Exclude<CollectionTab, 'overview'>, ReactNode>>;
}) {
  const path = usePathname();
  const current = tabOf(base, path);
  const bar = useRef<HTMLElement>(null);
  useEffect(() => {
    const lit = bar.current?.querySelector<HTMLElement>('[aria-current="page"]');
    if (bar.current && lit) revealTab(bar.current, lit);
  }, [current]);
  const method = lensOf(useSearchParams(), current, lenses);
  const defaultLens = method === null || method === 'AC';
  const hrefOf = (tab: CollectionTab) =>
    tab === 'overview' ? base
      : tab === 'trades' || tab === 'rings' ? `${base}/${tab}`
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
      <nav ref={bar} aria-label={`${name}: overview, methods, rings, tokens, wallets and trades`} className="relative mt-2 flex max-w-full gap-1 overflow-x-auto border-b">
        {TABS.map(({ tab, label, kind }) => {
          // Rings and Trades are no lens's lists: their counts always stand. Overview and Methods count nothing.
          const count = tab === 'overview' || tab === 'methods' || ((tab === 'tokens' || tab === 'wallets') && !defaultLens) ? null : counts[tab];
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
