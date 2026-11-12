'use client';

import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { LensKey } from '@washtrace/detect/trades';
import type { Drawing, DrawnEdge, DrawnLoop } from '@/lib/layout';
import { LABELLED_MAX, LABEL_SEP, LENSES, andList, short } from '@/lib/format';
import { carry, txHref, walletHref, type Context } from '@/lib/links';
import { cn } from '@/lib/utils';
import { MIN_DRAWN, VERDICT, WalletMark } from './kit';

// Literal class names: Tailwind generates only the classes it can read in the source. A lens of yours is drawn in the flow hue, as its tab is.
const STROKE = { cycle: 'stroke-cycle', ceiling: 'stroke-ceiling', apart: 'stroke-muted-foreground', clean: 'stroke-clean', own: 'stroke-flow' } as const;
const FILL = { cycle: 'fill-cycle', ceiling: 'fill-ceiling', apart: 'fill-muted-foreground', clean: 'fill-clean', flow: 'fill-flow' } as const;

/** The least a phone draws the graph at, of its own size: its 10 px labels stay 8 px or more. */
const MIN_SCALE = 0.8;
/** The most a graph is drawn at, of its own size, given a `min`: its 10 px labels stay 16 px or less. */
const MAX_SCALE = 1.6;
// A label's own outline in the card's colour, drawn under its fill, so a number on an arrow reads clear of the line.
const HALO = 'stroke-card stroke-[3px] [paint-order:stroke] [stroke-linejoin:round]';

/**
 * The token's graph as one picture (paper Figure 8, drawn from data), with
 * `lit`'s arrows and wallets lit and the rest dimmed. It holds no state and
 * takes no handlers, so a server page can draw it from plain props: a wallet
 * links to its page, an arrow that carries a trade links to it, and another
 * token's number (on an arrow only a lens of yours drew) links to that token
 * under `base`, the collection's page ('' links none).
 *
 * Solid arrows are transfers, by verdict; dashed arrows are the payments a
 * lens used, each labelled with its amount where that fits beside it (else
 * in its title). GraphLegend keys what is drawn. `rowHrefs` links an arrow's
 * number to its row of a table on the same page. `pick` is
 * for TokenLoops: its wallets are then buttons, lit on a first press and
 * opened on a second, which it handles on the element around this one.
 * `label` names the picture, as a page with several says which loop each lights.
 * `mark` is the transfer the page is about (`txHash:logIndex`), whose arrow is
 * drawn haloed and never dimmed, so a trade page shows which arrow is its own.
 *
 * Wider than its box, as a big graph is on a phone, it opens scrolled to the
 * part that matters: the marked arrow, else what is lit, else its middle.
 * `min` is the width it is drawn at least where its box has room (MIN_DRAWN),
 * never past MAX_SCALE of its own size; without it, never past its own size.
 */
export function LoopFigure({ drawing, chainId, lit, base, ctx = {}, rowHrefs = {}, edgeHrefs = {}, pick = false, label = 'Transfer graph of this token', mark, min }: {
  drawing: Drawing; chainId: number; lit: { edges: string[]; nodes: string[] }; base: string;
  /** What its links to wallets and trades carry on: the lens the page was opened under. */
  ctx?: Context;
  /** The link to each row, by its 1-based number. */
  rowHrefs?: Record<number, string>;
  /** What an arrow opens, by its key, where a page links each to its own lens; else its trade or payment under `ctx`. */
  edgeHrefs?: Record<string, string>;
  pick?: boolean;
  label?: string;
  mark?: string;
  min?: number;
}) {
  // Its own arrowheads: a page can draw several (the trade page one a transfer), and ids must not repeat on a page. Only an id's letters and digits, so it reads the same inside url(#…).
  const marker = `${useId().replace(/[^a-zA-Z0-9]/g, '')}-arrow`;
  const { view, nodes, edges } = drawing;
  const litEdges = new Set(lit.edges), litNodes = new Set(lit.nodes);
  const any = litEdges.size > 0 || litNodes.size > 0;
  const labels = nodes.length <= LABELLED_MAX;
  const marked = new Set(mark === undefined ? [] : edges.filter((e) => e.ids.includes(mark)).map((e) => e.key));
  // Drawn larger than its own size only up to MAX_SCALE, and only when a page asks.
  const widest = min === undefined ? view.w : Math.min(Math.max(view.w, min), view.w * MAX_SCALE);
  const box = useRef<HTMLDivElement>(null);
  const focus = Math.round(focusOf(drawing, marked, litNodes));
  useEffect(() => {
    const el = box.current, svg = el?.querySelector('svg');
    if (!el || !svg || el.scrollWidth <= el.clientWidth) return;
    const scale = svg.getBoundingClientRect().width / view.w;
    el.scrollLeft = Math.max(0, (focus - view.x) * scale - el.clientWidth / 2);
  }, [focus, view.x, view.w]);
  const labelHref = (e: DrawnEdge) => (e.row !== null ? rowHrefs[e.row] : e.token === undefined || base === '' ? undefined : `${base}/t/${e.token}`);
  const opens = (e: DrawnEdge, tx: string) => edgeHrefs[e.key] ?? carry(txHref(chainId, tx, base), ctx);
  return (
    <figure className="rounded-lg border bg-card p-3">
      {/* The box round what is drawn, never wider on screen than `widest`: a two-wallet loop is a strip, not a square of empty card. */}
      {/* On a phone it is never drawn below MIN_SCALE, so its labels stay readable, and scrolls sideways in its own box instead; from sm it fits the column as before. */}
      <div ref={box} className="overflow-x-auto">
        <svg viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`} style={{ maxWidth: `${Math.round(widest)}px`, '--figure-min': `${Math.round(view.w * MIN_SCALE)}px` } as CSSProperties}
          className="mx-auto block h-auto w-full max-sm:min-w-(--figure-min)" role="group" aria-label={label}>
          <defs>
            {(['cycle', 'ceiling', 'apart', 'clean', 'flow'] as const).map((k) => (
              <marker key={k} id={`${marker}-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" className={FILL[k]} />
              </marker>
            ))}
          </defs>
          {edges.map((e) => {
            const on = litEdges.has(e.key), mine = marked.has(e.key);
            const name = mine ? `${e.title} · this trade` : e.title;
            return (
              <g key={e.key} data-edge={e.key} data-lit={on ? '' : undefined} data-mark={mine ? '' : undefined} className={cn(any && !on && !mine && 'opacity-25')}>
                <title>{name}</title>
                {/* This trade's arrow wears a wide soft band under it: told apart by more than hue, and whatever its verdict's colour. */}
                {mine ? <path d={e.d} fill="none" strokeWidth={9} strokeLinecap="round" className="stroke-foreground/20" /> : null}
                <path
                  d={e.d} fill="none"
                  strokeWidth={e.kind === 'money' ? 1.4 : e.tone === 'clean' ? 1.2 : 2}
                  strokeDasharray={e.kind === 'money' ? '5 4' : undefined}
                  className={e.kind === 'money' ? 'stroke-flow' : STROKE[e.tone]}
                  markerEnd={`url(#${marker}-${e.kind === 'money' || e.tone === 'own' ? 'flow' : e.tone})`}
                />
                {/* A 2px line is a poor target, so a wider invisible copy of it takes the click. Out of the tab order, as the clickable path before it was: the table's rows are the keyboard's way to a trade. A bundle opens its first. */}
                {e.tx === null ? null : (
                  <a href={opens(e, e.tx)} data-tx={e.tx} tabIndex={-1} aria-label={`${e.kind === 'money' ? (e.key.startsWith('m') ? 'Open the first payment' : 'Open the payment') : e.key.startsWith('b') ? 'Open the first trade' : 'Open the trade'}: ${name}`}>
                    <path d={e.d} fill="none" stroke="transparent" strokeWidth={12} pointerEvents="stroke" className="cursor-pointer" />
                  </a>
                )}
              </g>
            );
          })}
          {/* Every label after every line, so its halo sits over any arc near it; layout sets each nearest its own arc (clearLabels). */}
          {/* Its number in bold, then what it paid, as "2 · 9 ETH" (LABEL_SEP, which layout also counts to set it clear). */}
          {labels ? edges.map((e) => {
            // An amount no spot beside its own arc fits is left to the title (layout's amountHidden): a label read by another line would name its amount.
            const paid = e.amountHidden ? '' : e.amount;
            if (!e.label && !paid) return null;
            const on = litEdges.has(e.key), mine = marked.has(e.key);
            // A number whose amount is hidden, on a page with no table to link it to (a trade's), opens its trade, which says the amount.
            const href = labelHref(e) ?? (e.amountHidden && e.tx !== null ? opens(e, e.tx) : undefined);
            const number = <tspan className={cn('font-semibold', e.kind === 'asset' && 'fill-foreground')}>{e.label}</tspan>;
            return (
              <g key={e.key} data-label={e.key} className={cn(any && !on && !mine && 'opacity-25')}>
                {/* Named as its arrow is, so hovering a label still says whose it is. */}
                <title>{mine ? `${e.title} · this trade` : e.title}</title>
                <text x={e.lx} y={e.ly} dy="0.35em" textAnchor="middle" className={cn(HALO, 'font-mono text-[10px]', e.kind === 'money' ? 'fill-flow' : mine ? 'fill-foreground' : 'fill-muted-foreground')}>
                  {e.label === '' ? null : href === undefined ? number : <a href={href} aria-label={e.amount === '' ? `Arrow ${e.label}` : `Arrow ${e.label}: ${e.amount}`}>{number}</a>}
                  {e.label && paid ? LABEL_SEP : null}
                  {paid === '' ? null : <tspan className={cn(mine && 'font-semibold')}>{paid}</tspan>}
                </text>
              </g>
            );
          }) : null}
          {nodes.map((n) => {
            const cls = cn('cursor-pointer outline-focus focus-visible:outline-2', any && !litNodes.has(n.id) && 'opacity-25');
            const body = (
              <>
                <title>{n.id}</title>
                {/* A custody wallet is a dashed square, named for what it is: it holds a token without owning it. A middle is the dashed wallet of money alone. */}
                {n.custody === null
                  ? <WalletMark x={n.x} y={n.y} r={n.middle ? 7 : 9} traded={!n.middle} className={n.first ? 'stroke-[2.5]' : undefined} />
                  : <rect x={n.x - 8} y={n.y - 8} width={16} height={16} rx={2} strokeDasharray="3 2" strokeWidth={1.5} className="fill-card stroke-muted-foreground" />}
                {labels ? (
                  <text x={n.lx} y={n.ly} dy="0.35em" textAnchor={n.anchor} className={cn(HALO, 'fill-body font-mono text-[10px]')}>{n.custody ?? short(n.id)}</text>
                ) : null}
              </>
            );
            return pick
              ? <g key={n.id} role="button" tabIndex={0} aria-label={`Wallet ${n.id}`} data-wallet={n.id} className={cls}>{body}</g>
              : <a key={n.id} href={carry(walletHref(chainId, n.id, base), ctx)} aria-label={`Wallet ${n.id}`} className={cls}>{body}</a>;
          })}
        </svg>
      </div>
      <GraphLegend drawing={drawing} marked={marked.size > 0} />
    </figure>
  );
}

/** A legend's swatch for a wallet: the graph's own mark, small. */
const Mark = ({ traded }: { traded: boolean }) => <svg viewBox="0 0 16 16" aria-hidden className="size-3.5 shrink-0"><WalletMark x={8} y={8} r={6} traded={traded} /></svg>;

/**
 * Every graph's key, under its picture and left-aligned, in one fixed order:
 * the arrows by verdict (floor, ceiling, not counted, not flagged), then your
 * lenses', then payments and the marked trade; then the wallets, the first
 * holder, those in between, custody; then how the arrows are numbered. It
 * names only what is drawn, so a swatch never stands for something absent.
 * `marked` says the drawing marks the trade its page is about.
 */
export function GraphLegend({ drawing, marked = false }: { drawing: Drawing; marked?: boolean }) {
  const { nodes, edges, numbering } = drawing;
  const labels = nodes.length <= LABELLED_MAX;
  const drawn = new Set(edges.filter((e) => e.kind === 'asset').map((e) => e.tone));
  // Your lenses' hue stands for two arrows: a trade the built-ins left clean on a loop of yours (`yours`), and another token's on one.
  const yours = [...new Set(edges.flatMap((e) => e.yours ?? []))];
  const others = edges.some((e) => e.kind === 'asset' && e.tone === 'own' && e.yours === undefined);
  const money = edges.some((e) => e.kind === 'money');
  // A wallet money alone joins is told apart from one that traded; with none drawn, a circle needs no key. A lens of yours also sets inside
  // the far end of another token's transfer on its loop, which money does not join: with one drawn, the key says what is true of both.
  const between = nodes.some((n) => n.middle && n.custody === null), ownDrawn = edges.some((e) => e.tone === 'own');
  const first = nodes.some((n) => n.first);
  const custody = [...new Set(nodes.flatMap((n) => n.custody ?? []))];
  // A number means the same in every graph of its Numbering; the legend says how to read it. Another token's "#9" and a bundle's "×7" are no such number.
  const numbered = labels && edges.some((e) => e.token === undefined && e.label !== '' && !e.label.startsWith('×'));
  const several = edges.some((e) => e.row !== null && e.label.startsWith('#'));
  const line = (swatch: string) => <i aria-hidden className={cn('h-0.5 w-4', swatch)} />;
  return (
    <figcaption className="mt-2 flex flex-wrap justify-start gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {drawn.has('cycle') ? <span className="flex items-center gap-1.5">{line('bg-cycle')}{VERDICT.cycle}</span> : null}
      {drawn.has('ceiling') ? <span className="flex items-center gap-1.5">{line('bg-ceiling')}{VERDICT.ceiling}</span> : null}
      {drawn.has('apart') ? <span className="flex items-center gap-1.5">{line('bg-muted-foreground')}{LENSES.AU.name} only, not counted</span> : null}
      {drawn.has('clean') ? <span className="flex items-center gap-1.5">{line('bg-clean')}not flagged</span> : null}
      {yours.length > 0 ? <span className="flex items-center gap-1.5">{line('bg-flow')}not flagged by a built-in lens, on a loop of {andList(yours)}</span> : null}
      {others ? <span className="flex items-center gap-1.5">{line('bg-flow')}another token, on a loop of a lens of yours</span> : null}
      {money ? <span className="flex items-center gap-1.5"><i aria-hidden className="h-0 w-4 border-t-[1.5px] border-dashed border-flow" />payment a lens used</span> : null}
      {marked ? <span className="flex items-center gap-1.5"><i aria-hidden className="h-2 w-4 rounded-full bg-foreground/20" />this trade</span> : null}
      {between ? <span className="flex items-center gap-1.5"><Mark traded />wallet</span> : null}
      {first ? <span className="flex items-center gap-1.5"><i aria-hidden className="size-2 rounded-full border-2 border-foreground" />first holder</span> : null}
      {between ? <span className="flex items-center gap-1.5"><Mark traded={false} />{ownDrawn ? 'never held this token: joined by money, or on a loop of a lens of yours' : 'in between, funder or payee: joined by money only'}</span> : null}
      {custody.length > 0 ? <span className="flex items-center gap-1.5"><i aria-hidden className="size-2 border border-dashed border-muted-foreground" />custody ({andList(custody)}): holds the token, does not own it</span> : null}
      {!numbered ? null : numbering === 'time'
        ? <span>numbered in block order, sales and payments together; in one block, its transfers first</span>
        : <span>{several ? '#token·n: that token’s transfer n, counted from its first' : 'numbered from the token’s first transfer'}</span>}
      {labels ? null : <span>{nodes.length} wallets: hover a node for its address</span>}
    </figcaption>
  );
}

/** Where across the drawing (in its own x) the part that matters is: the marked arrows' numbers, else the lit wallets, else the middle. */
function focusOf({ view, nodes, edges }: Drawing, marked: ReadonlySet<string>, lit: ReadonlySet<string>): number {
  const xs = marked.size > 0 ? edges.filter((e) => marked.has(e.key)).map((e) => e.lx) : nodes.filter((n) => lit.has(n.id)).map((n) => n.x);
  return xs.length === 0 ? view.x + view.w / 2 : (Math.min(...xs) + Math.max(...xs)) / 2;
}

/**
 * The token's graph beside the reasons it was flagged. They share one piece
 * of state, what is lit, so they live in one component: a reason's toggle
 * lights its loop, a wallet lights its own arrows, and everything else dims.
 * The picture is LoopFigure's; presses on it are handled on the element
 * around it, so the figure stays free of handlers.
 *
 * Numbers on arrows are the rows of the table below, which is where the
 * reading is; the picture is for seeing the shape.
 *
 * `items` are the reasons, rendered on the server because their bodies hold
 * links. `rowHrefs` is the server's link to each row, since only it knows
 * which page of the table's filter holds a row.
 */
export function TokenLoops({ drawing, chainId, base = '', ctx = {}, items, initial, rowHrefs, graphHead, whyHead, empty }: {
  drawing: Drawing; chainId: number;
  /** What the graph's links to wallets and trades carry on. */
  ctx?: Context;
  /** The collection's page, for the token numbers on a lens of yours's arrows. */
  base?: string;
  items: { key: string; body: ReactNode; meta: ReactNode }[];
  initial: { loop: string } | { method: LensKey } | null;
  /** The link to each row, by its 1-based number. */
  rowHrefs: Record<number, string>;
  graphHead?: ReactNode; whyHead?: ReactNode;
  /** Said in place of the list when there are no reasons. */
  empty?: ReactNode;
}) {
  const router = useRouter();
  const uid = useId();
  const { edges, loops } = drawing;
  // `initial` is read on mount only, on purpose: the table's ?page= and ?show= links keep this component mounted, so the lit state survives them, and arriving by ?loop= or ?method= is a fresh load.
  const [lit, setLit] = useState<string[]>(() =>
    initial === null ? [] : 'loop' in initial ? loops.filter((l) => l.key === initial.loop).map((l) => l.key) : loops.filter((l) => l.methods.includes(initial.method)).map((l) => l.key));
  const [wallet, setWallet] = useState<string | null>(null);

  const litEdges = new Set<string>(), litNodes = new Set<string>();
  for (const l of loops) {
    if (!lit.includes(l.key)) continue;
    for (const k of l.edges) litEdges.add(k);
    for (const n of l.nodes) litNodes.add(n);
  }
  if (wallet !== null) {
    litNodes.add(wallet);
    for (const e of edges) if (e.from === wallet || e.to === wallet) { litEdges.add(e.key); litNodes.add(e.from); litNodes.add(e.to); }
  }

  const toggle = (key: string) => {
    setWallet(null);
    setLit((cur) => (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]));
  };
  /** The first press lights a wallet's arrows; pressing the lit wallet again opens its page. */
  const pick = (id: string) => {
    if (wallet === id) { router.push(carry(walletHref(chainId, id, base), ctx)); return; }
    setLit([]);
    setWallet(id);
  };
  // Caught on the way down, before the figure's own link acts, so an arrow opens its trade in the app rather than by a full load.
  const onClick = (ev: MouseEvent) => {
    const target = ev.target as Element;
    const w = target.closest('[data-wallet]'), tx = target.closest('[data-tx]');
    if (w !== null) { ev.preventDefault(); pick(w.getAttribute('data-wallet')!); }
    else if (tx !== null) { ev.preventDefault(); router.push(carry(txHref(chainId, tx.getAttribute('data-tx')!, base), ctx)); }
  };
  const onKeyDown = (ev: KeyboardEvent) => {
    const w = (ev.target as Element).closest('[data-wallet]');
    if (w !== null && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); pick(w.getAttribute('data-wallet')!); }
  };

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-x-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <section className="mt-10 scroll-mt-6">
        {graphHead}
        {/* The figure's presses, delegated here: its wallets and arrows carry what was pressed as data. */}
        <div onClickCapture={onClick} onKeyDown={onKeyDown}>
          <LoopFigure drawing={drawing} chainId={chainId} base={base} ctx={ctx} rowHrefs={rowHrefs} lit={{ edges: [...litEdges], nodes: [...litNodes] }} pick min={MIN_DRAWN} />
        </div>
      </section>
      <section id="why" className="mt-10 scroll-mt-6">
        {whyHead}
        {items.length === 0 ? empty : (
          <ul className="space-y-2">
            {items.map((it) => {
              const on = lit.includes(it.key);
              const button = `${uid}-${it.key}-toggle`, text = `${uid}-${it.key}-text`;
              return (
                <li key={it.key} className={cn('flex items-start justify-between gap-3 rounded-lg border bg-card p-3.5', on && 'border-foreground')}>
                  <div className="min-w-0">
                    <p id={text} className="text-sm text-foreground">{it.body}</p>
                    <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">{it.meta}</p>
                  </div>
                  {/* Beside the body, never around it: a link inside a button is not valid. The name repeats the line so a toggle says which it lights. */}
                  <button
                    id={button} type="button" aria-pressed={on} aria-labelledby={`${button} ${text}`} onClick={() => toggle(it.key)}
                    className={cn('shrink-0 rounded border px-2 py-1 text-xs', on ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground')}
                  >
                    Show in graph
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

/** One step of a ring's story, as its trail lists it. */
export type TrailRow = {
  /** Its own key; `edge` is the arrow that draws it, which a bundle's steps share, and `nodes` that arrow's two wallets. */
  key: string; edge: string; nodes: [string, string];
  /** Rendered on the server, and plain: it is the row's button, which holds no link. */
  body: ReactNode;
  /** What "tx ›" opens, and its name: the sale or payment, under the lens of the evidence it is. */
  href: string; open: string;
};

/**
 * A ring's picture beside what happened in it, in order. They share one piece
 * of state, what is lit, so they live in one component, as TokenLoops does:
 * hovering or focusing a row lights its arrow and its two wallets, and
 * pressing it keeps that lit (a phone has no hover), which aria-pressed says.
 * The mouse and the keyboard each hold their own row: the one hovered shows
 * first, then the one focused by the keyboard, then the one pressed.
 * Each row's trailing "tx ›" opens its sale or payment; the row itself is a
 * button, never a link, so a press never leaves the page.
 *
 * The list is the authoritative record: every row says its number and its
 * amount ("3 · 9 ETH", LABEL_SEP), as the arrow's label does where that fits
 * beside it, and a crowded drawing leaves some amounts to their titles.
 */
export function RingTrail({ drawing, chainId, base, rows, rowHrefs, edgeHrefs, label, more }: {
  drawing: Drawing; chainId: number; base: string;
  rows: readonly TrailRow[];
  /** The figure's numbers' links, by row, and its arrows', by key: each its own lens's (LoopFigure). */
  rowHrefs: Record<number, string>; edgeHrefs: Record<string, string>;
  label: string;
  /** Said under the rows: the rest, on Trades. */
  more?: ReactNode;
}) {
  const [pinned, setPinned] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  // A mouse press focuses the row it presses; that focus lights nothing, or a click that un-pins it would leave it lit until blur. The hover lights it meanwhile.
  const pressing = useRef(false);
  const on = rows.find((r) => r.key === (hover ?? focused ?? pinned));
  const lit = on === undefined ? { edges: [], nodes: [] } : { edges: [on.edge], nodes: [...on.nodes] };
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <LoopFigure drawing={drawing} chainId={chainId} base={base} lit={lit} label={label} rowHrefs={rowHrefs} edgeHrefs={edgeHrefs} min={MIN_DRAWN} />
      <section aria-label="In order" className="min-w-0 rounded-lg border bg-card p-3">
        <h3 className="px-1 text-sm font-medium">In order</h3>
        <ol className="mt-1 divide-y">
          {rows.map((r) => (
            <li key={r.key} className="flex items-stretch gap-2">
              <button
                type="button" aria-pressed={pinned === r.key} onClick={() => { pressing.current = false; setPinned((cur) => (cur === r.key ? null : r.key)); }}
                onMouseEnter={() => setHover(r.key)} onMouseLeave={() => { pressing.current = false; setHover(null); }} onMouseDown={() => { pressing.current = true; }}
                onFocus={() => { if (!pressing.current) setFocused(r.key); pressing.current = false; }} onBlur={() => setFocused(null)}
                className={cn('min-h-11 min-w-0 flex-1 rounded px-1 py-1.5 text-left text-sm hover:bg-muted/60', pinned === r.key && 'bg-muted')}
              >
                {r.body}
              </button>
              <Link href={r.href} prefetch={false} aria-label={r.open} className="flex min-h-11 min-w-11 shrink-0 items-center justify-center px-1 text-xs text-muted-foreground hover:text-foreground hover:underline">tx ›</Link>
            </li>
          ))}
        </ol>
        {more}
      </section>
    </div>
  );
}

/**
 * A trade page's one picture of a token: its graph drawn once, with a switch
 * for each lens that caught the transfer, the chosen lens's loop lit, the
 * first lens chosen to start. `caught` is in the order the cards are; a lens
 * whose loop the layout did not draw lights nothing and opens no loop.
 * `tokenHref` is the token's page, which opens the chosen loop in full.
 * `transfer` is the one the page is about, whose arrow the figure marks.
 */
export function LensGraph({ drawing, chainId, base, ctx = {}, caught, tokenHref, transfer }: {
  drawing: Drawing; chainId: number; base: string;
  /** What its links carry on: the lens the page was opened under. */
  ctx?: Context;
  caught: readonly { key: LensKey; name: string; loop: DrawnLoop | null }[];
  tokenHref: string;
  transfer?: { txHash: string; logIndex: number };
}) {
  const [on, setOn] = useState(caught[0]?.key);
  const chosen = caught.find((c) => c.key === on) ?? caught[0];
  if (chosen === undefined) return null;
  return (
    <div data-lens-graph className="rounded-lg border bg-card p-3.5">
      {caught.length > 1 ? (
        <div role="group" aria-label="Light the loop of" className="mb-3 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">Light the loop of</span>
          {caught.map((c) => (
            <button key={c.key} type="button" aria-pressed={c.key === chosen.key} onClick={() => setOn(c.key)}
              className={cn('rounded border px-2 py-1', c.key === chosen.key ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground')}>
              {c.name}
            </button>
          ))}
        </div>
      ) : null}
      <LoopFigure drawing={drawing} chainId={chainId} base={base} ctx={ctx} lit={chosen.loop ?? { edges: [], nodes: [] }} label={`The loop ${chosen.name} caught, lit in this token’s graph`}
        mark={transfer === undefined ? undefined : `${transfer.txHash}:${transfer.logIndex}`} />
      {chosen.loop === null ? null : <Link href={carry(`${tokenHref}?loop=${chosen.loop.key}`, ctx)} className="mt-2 inline-block text-sm font-medium text-foreground underline-offset-4 hover:underline">Open it in the token’s graph →</Link>}
    </div>
  );
}
