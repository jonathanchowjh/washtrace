'use client';

import { useId, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { Method } from '@washtrace/detect';
import type { Drawing } from '@/lib/layout';
import { LENSES, short } from '@/lib/format';
import { cn } from '@/lib/utils';

// Literal class names: Tailwind generates only the classes it can read in the source.
const STROKE = { cycle: 'stroke-cycle', money: 'stroke-money', apart: 'stroke-muted-foreground', clean: 'stroke-clean' } as const;
const FILL = { cycle: 'fill-cycle', money: 'fill-money', apart: 'fill-muted-foreground', clean: 'fill-clean', flow: 'fill-flow' } as const;

/**
 * The token's asset transfer graph and the money among its wallets, in one
 * picture (paper Figure 8, drawn from data), beside the reasons it was
 * flagged. They share one piece of state, what is lit, so they live in one
 * component: a reason's toggle lights its loop, a wallet lights its own
 * arrows, and everything else dims.
 *
 * Solid arrows are transfers, by verdict; dashed arrows are money. Numbers on
 * arrows are the rows of the table below, which is where the reading is; the
 * picture is for seeing the shape.
 *
 * `items` are the reasons, rendered on the server because their bodies hold
 * links. `rowHrefs` is the server's link to each row, since only it knows
 * which page of the table's filter holds a row.
 */
export function TokenLoops({ drawing, chainId, items, initial, rowHrefs, graphHead, whyHead, empty }: {
  drawing: Drawing; chainId: number;
  items: { key: string; body: ReactNode; meta: ReactNode }[];
  initial: { loop: string } | { method: Method } | null;
  /** The link to each row, by its 1-based number. */
  rowHrefs: Record<number, string>;
  graphHead?: ReactNode; whyHead?: ReactNode;
  /** Said in place of the list when there are no reasons. */
  empty?: ReactNode;
}) {
  const router = useRouter();
  const uid = useId();
  const { size, nodes, edges, loops } = drawing;
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
  const any = lit.length > 0 || wallet !== null;

  const toggle = (key: string) => {
    setWallet(null);
    setLit((cur) => (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]));
  };
  /** The first click lights a wallet's arrows; clicking the lit wallet again opens its page. */
  const pick = (id: string) => {
    if (wallet === id) { router.push(`/w/${chainId}/${id}`); return; }
    setLit([]);
    setWallet(id);
  };

  const labels = nodes.length <= 24;
  // The legend names only the arrows drawn, so a swatch never stands for something absent. The first holder is always shown: every token has one.
  const drawn = new Set(edges.filter((e) => e.kind === 'asset').map((e) => e.tone));
  const money = edges.some((e) => e.kind === 'money');
  return (
    <div className="grid gap-x-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <section className="mt-10 scroll-mt-6">
        {graphHead}
        <figure className="rounded-lg border bg-card p-3">
          <svg viewBox={`0 0 ${size} ${size}`} className="mx-auto block h-auto w-full max-w-[560px]" role="group" aria-label="Transfer graph of this token">
            <defs>
              {(['cycle', 'money', 'apart', 'clean', 'flow'] as const).map((k) => (
                <marker key={k} id={`arrow-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" className={FILL[k]} />
                </marker>
              ))}
            </defs>
            {edges.map((e) => {
              const on = litEdges.has(e.key);
              return (
                <g key={e.key} data-edge={e.key} data-lit={on ? '' : undefined} className={cn(any && !on && 'opacity-25')}>
                  <title>{e.title}</title>
                  <path
                    d={e.d} fill="none"
                    strokeWidth={e.kind === 'money' ? 1.4 : e.tone === 'clean' ? 1.2 : 2}
                    strokeDasharray={e.kind === 'money' ? '5 4' : undefined}
                    className={e.kind === 'money' ? 'stroke-flow' : STROKE[e.tone]}
                    markerEnd={`url(#arrow-${e.kind === 'money' ? 'flow' : e.tone})`}
                  />
                  {/* A 2px line is a poor target, so a wider invisible copy of it takes the click. */}
                  {e.tx === null ? null : (
                    <path d={e.d} fill="none" stroke="transparent" strokeWidth={12} pointerEvents="stroke" className="cursor-pointer" onClick={() => router.push(`/tx/${chainId}/${e.tx}`)} />
                  )}
                  {labels && e.label ? (
                    <text x={e.lx} y={e.ly} dy="0.35em" textAnchor="middle" className={cn('font-mono text-[10px]', e.kind === 'money' ? 'fill-flow' : 'fill-muted-foreground')}>
                      {e.row !== null && rowHrefs[e.row] !== undefined ? <a href={rowHrefs[e.row]}>{e.label}</a> : e.label}
                    </text>
                  ) : null}
                </g>
              );
            })}
            {nodes.map((n) => (
              <g
                key={n.id} role="button" tabIndex={0} aria-label={`Wallet ${n.id}`}
                className={cn('cursor-pointer outline-focus focus-visible:outline-2', any && !litNodes.has(n.id) && 'opacity-25')}
                onClick={() => pick(n.id)}
                onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(n.id); } }}
              >
                <title>{n.id}</title>
                <circle cx={n.x} cy={n.y} r={n.middle ? 6 : 9} className={cn(n.middle ? 'fill-card stroke-flow' : 'fill-card stroke-foreground', n.first && 'stroke-[2.5]')} strokeWidth={1.5} />
                {labels ? (
                  <text x={n.lx} y={n.ly} dy="0.35em" textAnchor={n.lx < n.x - 4 ? 'end' : n.lx > n.x + 4 ? 'start' : 'middle'} className="fill-body font-mono text-[10px]">{short(n.id)}</text>
                ) : null}
              </g>
            ))}
          </svg>
          <figcaption className="mt-2 flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {drawn.has('cycle') ? <span className="flex items-center gap-1.5"><i aria-hidden className="h-0.5 w-4 bg-cycle" />{LENSES.A.name}</span> : null}
            {drawn.has('money') ? <span className="flex items-center gap-1.5"><i aria-hidden className="h-0.5 w-4 bg-money" />{LENSES.AC.name}</span> : null}
            {drawn.has('apart') ? <span className="flex items-center gap-1.5"><i aria-hidden className="h-0.5 w-4 bg-muted-foreground" />{LENSES.AU.name} only, not counted</span> : null}
            {drawn.has('clean') ? <span className="flex items-center gap-1.5"><i aria-hidden className="h-0.5 w-4 bg-clean" />not flagged</span> : null}
            {money ? <span className="flex items-center gap-1.5"><i aria-hidden className="h-0 w-4 border-t-[1.5px] border-dashed border-flow" />money</span> : null}
            <span className="flex items-center gap-1.5"><i aria-hidden className="size-2 rounded-full border-2 border-foreground" />first holder</span>
            {labels ? null : <span>{nodes.length} wallets: hover a node for its address</span>}
          </figcaption>
        </figure>
      </section>
      <section className="mt-10 scroll-mt-6">
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
