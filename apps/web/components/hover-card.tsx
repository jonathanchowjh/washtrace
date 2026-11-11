'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { RingLine, Tier } from '@washtrace/detect';
import { eth, num, plural, short, tokenLabel } from '@/lib/format';
import { KindIcon, TierMark, ringTone } from './kit';

/** What the card route answers (app/api/collections/[chain]/[address]/card). */
export type Card =
  | { kind: 'wallet'; judged: boolean; address: string; trades: number; flagged: number; rings: number; ring: RingLine | null; tier: Tier | null }
  | { kind: 'token'; judged: boolean; tokenId: string; transfers: number; flagged: number; ring: RingLine | null; tier: Tier | null }
  | { kind: 'ring'; judged: boolean; ring: RingLine };

/** Long enough that a pointer passing over a table opens nothing; short enough to feel like a reply. */
export const OPEN_MS = 300;

/** How long a card is kept: hovering a table reads each thing once, and a new analysis shows within a minute. */
export const KEEP_MS = 60_000;

// One read per thing a page shows while it is fresh. A failed read is forgotten, so the next hover asks again.
const cache = new Map<string, { at: number; card: Promise<Card | null> }>();
function cardOf(src: string): Promise<Card | null> {
  const kept = cache.get(src);
  if (kept !== undefined && Date.now() - kept.at < KEEP_MS) return kept.card;
  const card = fetch(src).then((r) => (r.ok ? (r.json() as Promise<Card>) : null)).catch(() => null);
  cache.set(src, { at: Date.now(), card });
  void card.then((c) => { if (c === null && cache.get(src)?.card === card) cache.delete(src); });
  return card;
}

/** Forget every card read, so a test starts from none. */
export function forgetCards() { cache.clear(); }

/** A card's lines, in the console's words. */
export function cardLines(c: Card): { title: string; kind: 'wallet' | 'token' | 'ring'; tier: Tier | null; lines: string[] } {
  const judged = (s: string) => (c.judged ? s : 'not judged yet');
  if (c.kind === 'wallet') {
    return { kind: 'wallet', title: short(c.address), tier: c.tier, lines: [
      // The route's `trades` is every transfer it sent or received here, a mint among them (walletTradeCount), as its page counts: so, transfers.
      `${plural(c.trades, 'transfer')} here · ${judged(`${num(c.flagged)} flagged`)}`,
      c.ring === null ? 'In no ring' : `In Ring ${c.ring.rank}${c.rings > 1 ? ` and ${plural(c.rings - 1, 'more ring')}` : ''}`,
    ] };
  }
  if (c.kind === 'token') {
    return { kind: 'token', title: `#${tokenLabel(c.tokenId)}`, tier: c.tier, lines: [
      `${plural(c.transfers, 'transfer')} · ${judged(`${num(c.flagged)} flagged`)}`,
      ...(c.ring === null ? [] : [`In Ring ${c.ring.rank}`]),
    ] };
  }
  const r = c.ring;
  return { kind: 'ring', title: `Ring ${r.rank}`, tier: ringTone(r), lines: [`${plural(r.wallets, 'wallet')} · ${plural(r.tokens, 'token')}`, `${plural(r.sales, 'flagged sale')} · ${eth(r.volumeWei)}`] };
}

/**
 * A small card about the wallet, token or ring a link opens, shown on hover
 * or focus after OPEN_MS, so a reader can tell what it is before going there.
 * The link inside still navigates on click; the card adds nothing to it.
 * Escape or leaving closes it; a read that fails shows nothing.
 */
export function HoverCard({ src, children, className = 'inline-flex' }: { src: string; children: ReactNode; className?: string }) {
  const [card, setCard] = useState<Card | null>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const box = useRef<HTMLSpanElement>(null);
  const id = useId();

  const close = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    setAt(null);
  };
  const open = () => {
    if (timer.current !== null) return;
    timer.current = setTimeout(async () => {
      const c = await cardOf(src);
      if (timer.current === null || c === null) return;
      const r = box.current?.getBoundingClientRect();
      setCard(c);
      // Fixed to the window, so a table's scroll box cannot clip it.
      setAt({ left: r?.left ?? 0, top: (r?.bottom ?? 0) + 4 });
    }, OPEN_MS);
  };
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);

  const shown = at !== null && card !== null ? cardLines(card) : null;
  return (
    <span ref={box} className={className} onMouseEnter={open} onMouseLeave={close} onFocus={open} onBlur={close}
      onKeyDown={(e) => { if (e.key === 'Escape') close(); }} aria-describedby={shown ? id : undefined}>
      {children}
      {shown ? (
        <span id={id} role="tooltip" style={{ left: at!.left, top: at!.top }}
          className="pointer-events-none fixed z-40 w-56 rounded-md border bg-card p-2.5 text-xs text-foreground shadow-md">
          <span className="flex items-center gap-1.5 font-medium">{shown.tier === null ? null : <TierMark tone={shown.tier} label />}<KindIcon kind={shown.kind} className="size-3.5" />{shown.title}</span>
          {shown.lines.map((l) => <span key={l} className="mt-0.5 block text-muted-foreground">{l}</span>)}
        </span>
      ) : null}
    </span>
  );
}
