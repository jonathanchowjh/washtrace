'use client';

import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { num } from '@/lib/format';
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
 * within it. `pad` is room left beyond the tab, so an edge's fade does not
 * sit over it, never past either end of the bar.
 */
export function revealTab(bar: HTMLElement, tab: HTMLElement, pad = 0) {
  const left = tab.offsetLeft - pad;
  const right = tab.offsetLeft + tab.offsetWidth + pad;
  if (left < bar.scrollLeft) bar.scrollLeft = Math.max(0, left);
  else if (right > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = Math.min(right, bar.scrollWidth) - bar.clientWidth;
}

/** How wide each edge's fade is, in px (w-8): the lit tab is scrolled clear of it. */
const FADE = 32;

/**
 * Whether the bar has tabs past its left or right edge, so that edge fades
 * while it does: on a phone the bar is wider than the screen, and a tab cut
 * in half at the edge gave no sign the rest is there. Checked on scroll, and
 * whenever the bar or a tab changes size (a count streaming in, a rotation).
 */
function useOffEdges(bar: RefObject<HTMLElement | null>): { left: boolean; right: boolean } {
  const [off, setOff] = useState({ left: false, right: false });
  useEffect(() => {
    const el = bar.current;
    if (el === null) return;
    // A pixel of slack: a zoomed page can leave a fraction unscrolled at either end.
    const check = () => {
      const left = el.scrollLeft > 1;
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setOff((o) => (o.left === left && o.right === right ? o : { left, right }));
    };
    check();
    el.addEventListener('scroll', check, { passive: true });
    const watch = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(check);
    watch?.observe(el);
    for (const a of el.querySelectorAll('a')) watch?.observe(a);
    return () => { el.removeEventListener('scroll', check); watch?.disconnect(); };
  }, [bar]);
  return off;
}

/** A tab's count, as a small grey pill. */
export function Badge({ n }: { n: number }) {
  return <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">{num(n)}</span>;
}

type Counted = 'tokens' | 'wallets' | 'trades';
type Counts = Partial<Record<Counted, number | null>>;
// One answer a page for all three badges, asked again only for another lens, or when a new analysis or run lands (`src` names them).
// Kept by collection and lens, so a newer analysis's read replaces the older one rather than piling up for the session;
// a failed read is forgotten, as a hover card's is, so the next page asks again.
const asked = new Map<string, { src: string; counts: Promise<Counts | null> }>();
function countsOf(src: string): Promise<Counts | null> {
  const u = new URL(src, 'http://x');
  const key = `${u.pathname}?${u.searchParams.get('method')}`;
  const kept = asked.get(key);
  if (kept?.src === src) return kept.counts;
  const counts = fetch(src).then((r) => (r.ok ? (r.json() as Promise<Counts>) : null)).catch(() => null);
  asked.set(key, { src, counts });
  void counts.then((c) => { if (c === null && asked.get(key)?.counts === counts) asked.delete(key); });
  return counts;
}

/**
 * A tab's count, read from the browser once the page is up: in the layout it
 * was read again for every prefetch of a tab and every 15 s refresh. A lens
 * that has not run here (null) says so in the pill, as its list does, so the
 * tab keeps its shape; a count that cannot be read shows nothing.
 */
export function TabCount({ src, kind }: { src: string; kind: Counted }) {
  const [n, setN] = useState<number | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void countsOf(src).then((c) => { if (live) setN(typeof c?.[kind] === 'number' || c?.[kind] === null ? c[kind] : undefined); });
    return () => { live = false; };
  }, [src, kind]);
  if (n === undefined) return null;
  return n === null
    ? <span title="This lens has not run here, so its list is empty for now" className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground">not run</span>
    : <Badge n={n} />;
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
 * The collection's parent line and its tabs, on every page under it. Tokens
 * and Wallets count the lists they open, so the lens the address bar picks
 * (lensOf) picks their counts too, and the bar keeps its shape as the lens
 * changes. Trades counts every sale, the collection's own figure: a filter's
 * matches are said by the list's own line. A chosen lens is carried to the
 * Tokens and Wallets tabs.
 */
export function CollectionNav({ base, name, analyzedAt, lenses, opensOn, counts, rings }: {
  base: string;
  name: string;
  analyzedAt: number | null;
  /** Every lens key that exists here, the built-ins first in METHODS' order. */
  lenses: readonly string[];
  /** The lens a list opens on with no lens named: the one whose counts show then. */
  opensOn: string;
  /** By lens key, where its tab counts are read from (the counts route); each is read once a page, from the browser. */
  counts: Readonly<Record<string, string>>;
  /** How many rings the latest analysis found, or null before rings are worked out. */
  rings: number | null;
}) {
  const path = usePathname();
  const current = tabOf(base, path);
  const bar = useRef<HTMLElement>(null);
  const off = useOffEdges(bar);
  useEffect(() => {
    const nav = bar.current;
    const reveal = () => {
      const lit = nav?.querySelector<HTMLElement>('[aria-current="page"]');
      if (nav && lit) revealTab(nav, lit, FADE);
    };
    reveal();
    // The counts stream in after this runs and widen the tabs, moving the lit one: reveal it again whenever a tab changes size.
    if (nav === null || typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(reveal);
    for (const a of nav.querySelectorAll('a')) watch.observe(a);
    return () => watch.disconnect();
  }, [current]);
  const method = lensOf(useSearchParams(), current, lenses);
  const src = counts[method ?? opensOn];
  const countOf = (tab: CollectionTab): ReactNode =>
    tab === 'rings' ? (rings === null ? null : <Badge n={rings} />)
      // Overview and Methods count nothing.
      : (tab === 'tokens' || tab === 'wallets' || tab === 'trades') && src !== undefined ? <TabCount src={src} kind={tab} /> : null;
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
        {analyzedAt === null ? null : <span>· analyzed <Time ms={analyzedAt} /></span>}
      </p>
      {/* The fades sit over the bar, outside what scrolls, so they stay at its edges; the bar's bottom rule shows under them. */}
      <div className="relative mt-2">
        <nav ref={bar} aria-label={`${name}: overview, methods, rings, tokens, wallets and trades`} className="relative flex max-w-full gap-1 overflow-x-auto border-b">
          {TABS.map(({ tab, label, kind }) => (
            <Link key={tab} href={hrefOf(tab)} aria-current={tab === current ? 'page' : undefined}
              className={cn('-mb-px inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium',
                tab === current ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
              <KindIcon kind={kind} />{label}
              {countOf(tab)}
            </Link>
          ))}
        </nav>
        <div aria-hidden data-more="left" hidden={!off.left} className="pointer-events-none absolute top-0 bottom-px left-0 w-8 bg-linear-to-r from-background to-transparent" />
        <div aria-hidden data-more="right" hidden={!off.right} className="pointer-events-none absolute top-0 right-0 bottom-px w-8 bg-linear-to-l from-background to-transparent" />
      </div>
    </div>
  );
}
