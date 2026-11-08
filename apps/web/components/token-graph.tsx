'use client';

import { useId, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { LensKey } from '@washtrace/detect/trades';
import type { Drawing, DrawnEdge } from '@/lib/layout';
import { LENSES, andList, short } from '@/lib/format';
import { cn } from '@/lib/utils';

// Literal class names: Tailwind generates only the classes it can read in the source. A lens of yours is drawn in the flow hue, as its tab is.
const STROKE = { cycle: 'stroke-cycle', money: 'stroke-money', apart: 'stroke-muted-foreground', clean: 'stroke-clean', own: 'stroke-flow' } as const;
const FILL = { cycle: 'fill-cycle', money: 'fill-money', apart: 'fill-muted-foreground', clean: 'fill-clean', flow: 'fill-flow' } as const;

/**
 * The token's graph as one picture (paper Figure 8, drawn from data), with
 * `lit`'s arrows and wallets lit and the rest dimmed. It holds no state and
 * takes no handlers, so a server page can draw it from plain props: a wallet
 * links to its page, an arrow that carries a trade links to it, and another
 * token's number (on an arrow only a lens of yours drew) links to that token
 * under `base`, the collection's page ('' links none).
 *
 * Solid arrows are transfers, by verdict; dashed arrows are money. `rowHrefs`
 * links an arrow's number to its row of a table on the same page. `pick` is
 * for TokenLoops: its wallets are then buttons, lit on a first press and
 * opened on a second, which it handles on the element around this one.
 * `label` names the picture, as a page with several says which loop each lights.
 */
export function LoopFigure({ drawing, chainId, lit, base, rowHrefs = {}, pick = false, label = 'Transfer graph of this token' }: {
  drawing: Drawing; chainId: number; lit: { edges: string[]; nodes: string[] }; base: string;
  /** The link to each row, by its 1-based number. */
  rowHrefs?: Record<number, string>;
  pick?: boolean;
  label?: string;
}) {
  // Its own arrowheads: the trade page draws a figure per card, and ids must not repeat on a page. Only an id's letters and digits, so it reads the same inside url(#…).
  const marker = `${useId().replace(/[^a-zA-Z0-9]/g, '')}-arrow`;
  const { size, nodes, edges } = drawing;
  const litEdges = new Set(lit.edges), litNodes = new Set(lit.nodes);
  const any = litEdges.size > 0 || litNodes.size > 0;
  const labels = nodes.length <= 24;
  // The legend names only the arrows drawn, so a swatch never stands for something absent. The first holder is always shown: every token has one.
  const drawn = new Set(edges.filter((e) => e.kind === 'asset').map((e) => e.tone));
  // Your lenses' hue stands for two arrows: a trade the built-ins left clean on a loop of yours (`yours`), and another token's on one.
  const yours = [...new Set(edges.flatMap((e) => e.yours ?? []))];
  const others = edges.some((e) => e.kind === 'asset' && e.tone === 'own' && e.yours === undefined);
  const money = edges.some((e) => e.kind === 'money');
  const labelHref = (e: DrawnEdge) => (e.row !== null ? rowHrefs[e.row] : e.token === undefined || base === '' ? undefined : `${base}/t/${e.token}`);
  return (
    <figure className="rounded-lg border bg-card p-3">
      <svg viewBox={`0 0 ${size} ${size}`} className="mx-auto block h-auto w-full max-w-[560px]" role="group" aria-label={label}>
        <defs>
          {(['cycle', 'money', 'apart', 'clean', 'flow'] as const).map((k) => (
            <marker key={k} id={`${marker}-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" className={FILL[k]} />
            </marker>
          ))}
        </defs>
        {edges.map((e) => {
          const on = litEdges.has(e.key);
          const href = labelHref(e);
          return (
            <g key={e.key} data-edge={e.key} data-lit={on ? '' : undefined} className={cn(any && !on && 'opacity-25')}>
              <title>{e.title}</title>
              <path
                d={e.d} fill="none"
                strokeWidth={e.kind === 'money' ? 1.4 : e.tone === 'clean' ? 1.2 : 2}
                strokeDasharray={e.kind === 'money' ? '5 4' : undefined}
                className={e.kind === 'money' ? 'stroke-flow' : STROKE[e.tone]}
                markerEnd={`url(#${marker}-${e.kind === 'money' || e.tone === 'own' ? 'flow' : e.tone})`}
              />
              {/* A 2px line is a poor target, so a wider invisible copy of it takes the click. Out of the tab order, as the clickable path before it was: the table's rows are the keyboard's way to a trade. A bundle opens its first. */}
              {e.tx === null ? null : (
                <a href={`/tx/${chainId}/${e.tx}`} data-tx={e.tx} tabIndex={-1} aria-label={`${e.key.startsWith('b') ? 'Open the first trade' : 'Open the trade'}: ${e.title}`}>
                  <path d={e.d} fill="none" stroke="transparent" strokeWidth={12} pointerEvents="stroke" className="cursor-pointer" />
                </a>
              )}
              {labels && e.label ? (
                <text x={e.lx} y={e.ly} dy="0.35em" textAnchor="middle" className={cn('font-mono text-[10px]', e.kind === 'money' ? 'fill-flow' : 'fill-muted-foreground')}>
                  {href === undefined ? e.label : <a href={href}>{e.label}</a>}
                </text>
              ) : null}
            </g>
          );
        })}
        {nodes.map((n) => {
          const cls = cn('cursor-pointer outline-focus focus-visible:outline-2', any && !litNodes.has(n.id) && 'opacity-25');
          const body = (
            <>
              <title>{n.id}</title>
              <circle cx={n.x} cy={n.y} r={n.middle ? 6 : 9} className={cn(n.middle ? 'fill-card stroke-flow' : 'fill-card stroke-foreground', n.first && 'stroke-[2.5]')} strokeWidth={1.5} />
              {labels ? (
                <text x={n.lx} y={n.ly} dy="0.35em" textAnchor={n.lx < n.x - 4 ? 'end' : n.lx > n.x + 4 ? 'start' : 'middle'} className="fill-body font-mono text-[10px]">{short(n.id)}</text>
              ) : null}
            </>
          );
          return pick
            ? <g key={n.id} role="button" tabIndex={0} aria-label={`Wallet ${n.id}`} data-wallet={n.id} className={cls}>{body}</g>
            : <a key={n.id} href={`/w/${chainId}/${n.id}`} aria-label={`Wallet ${n.id}`} className={cls}>{body}</a>;
        })}
      </svg>
      <figcaption className="mt-2 flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {drawn.has('cycle') ? <span className="flex items-center gap-1.5"><i aria-hidden className="h-0.5 w-4 bg-cycle" />{LENSES.A.name}</span> : null}
        {drawn.has('money') ? <span className="flex items-center gap-1.5"><i aria-hidden className="h-0.5 w-4 bg-money" />{LENSES.AC.name}</span> : null}
        {drawn.has('apart') ? <span className="flex items-center gap-1.5"><i aria-hidden className="h-0.5 w-4 bg-muted-foreground" />{LENSES.AU.name} only, not counted</span> : null}
        {drawn.has('clean') ? <span className="flex items-center gap-1.5"><i aria-hidden className="h-0.5 w-4 bg-clean" />not flagged</span> : null}
        {yours.length > 0 ? <span className="flex items-center gap-1.5"><i aria-hidden className="h-0.5 w-4 bg-flow" />not flagged by a built-in lens, on a loop of {andList(yours)}</span> : null}
        {others ? <span className="flex items-center gap-1.5"><i aria-hidden className="h-0.5 w-4 bg-flow" />another token, on a loop of a lens of yours</span> : null}
        {money ? <span className="flex items-center gap-1.5"><i aria-hidden className="h-0 w-4 border-t-[1.5px] border-dashed border-flow" />money</span> : null}
        <span className="flex items-center gap-1.5"><i aria-hidden className="size-2 rounded-full border-2 border-foreground" />first holder</span>
        {labels ? null : <span>{nodes.length} wallets: hover a node for its address</span>}
      </figcaption>
    </figure>
  );
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
export function TokenLoops({ drawing, chainId, base = '', items, initial, rowHrefs, graphHead, whyHead, empty }: {
  drawing: Drawing; chainId: number;
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
    if (wallet === id) { router.push(`/w/${chainId}/${id}`); return; }
    setLit([]);
    setWallet(id);
  };
  // Caught on the way down, before the figure's own link acts, so an arrow opens its trade in the app rather than by a full load.
  const onClick = (ev: MouseEvent) => {
    const target = ev.target as Element;
    const w = target.closest('[data-wallet]'), tx = target.closest('[data-tx]');
    if (w !== null) { ev.preventDefault(); pick(w.getAttribute('data-wallet')!); }
    else if (tx !== null) { ev.preventDefault(); router.push(`/tx/${chainId}/${tx.getAttribute('data-tx')}`); }
  };
  const onKeyDown = (ev: KeyboardEvent) => {
    const w = (ev.target as Element).closest('[data-wallet]');
    if (w !== null && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); pick(w.getAttribute('data-wallet')!); }
  };

  return (
    <div className="grid gap-x-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <section className="mt-10 scroll-mt-6">
        {graphHead}
        {/* The figure's presses, delegated here: its wallets and arrows carry what was pressed as data. */}
        <div onClickCapture={onClick} onKeyDown={onKeyDown}>
          <LoopFigure drawing={drawing} chainId={chainId} base={base} rowHrefs={rowHrefs} lit={{ edges: [...litEdges], nodes: [...litNodes] }} pick />
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
