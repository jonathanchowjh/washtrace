import Link from 'next/link';
import type { Drawing } from '@/lib/layout';
import { short } from '@/lib/format';
import { cn } from '@/lib/utils';

// Literal class names: Tailwind generates only the classes it can read in the source.
const STROKE = { cycle: 'stroke-cycle', money: 'stroke-money', clean: 'stroke-clean' } as const;
const FILL = { cycle: 'fill-cycle', money: 'fill-money', clean: 'fill-clean', flow: 'fill-flow' } as const;

/**
 * The token's asset transfer graph and the money among its wallets, in one
 * picture: paper Figure 8, drawn from data. Solid arrows are transfers, by
 * verdict; dashed arrows are money. Numbers on arrows are the rows of the
 * table below, which is where the reading is; the picture is for seeing the
 * shape.
 */
export function TokenGraph({ drawing, chainId }: { drawing: Drawing; chainId: number }) {
  const { size, nodes, edges } = drawing;
  const labels = nodes.length <= 24;
  return (
    <figure className="rounded-lg border bg-card p-3">
      <svg viewBox={`0 0 ${size} ${size}`} className="mx-auto block h-auto w-full max-w-[560px]" role="img" aria-label="Transfer graph of this token">
        <defs>
          {(['cycle', 'money', 'clean', 'flow'] as const).map((k) => (
            <marker key={k} id={`arrow-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" className={FILL[k]} />
            </marker>
          ))}
        </defs>
        {edges.map((e) => (
          <g key={e.key}>
            <title>{e.title}</title>
            <path
              d={e.d} fill="none"
              strokeWidth={e.kind === 'money' ? 1.4 : e.verdict === 'clean' ? 1.2 : 2}
              strokeDasharray={e.kind === 'money' ? '5 4' : undefined}
              className={e.kind === 'money' ? 'stroke-flow' : STROKE[e.verdict]}
              markerEnd={`url(#arrow-${e.kind === 'money' ? 'flow' : e.verdict})`}
            />
            {labels && e.label ? (
              <text x={e.lx} y={e.ly} dy="0.35em" textAnchor="middle" className={cn('font-mono text-[10px]', e.kind === 'money' ? 'fill-flow' : 'fill-muted-foreground')}>
                {e.ref !== null ? <a href={`#t${e.ref + 1}`}>{e.label}</a> : e.label}
              </text>
            ) : null}
          </g>
        ))}
        {nodes.map((n) => (
          <Link key={n.id} href={`/w/${chainId}/${n.id}`}>
            <title>{n.id}</title>
            <circle cx={n.x} cy={n.y} r={n.middle ? 6 : 9} className={cn(n.middle ? 'fill-card stroke-flow' : 'fill-card stroke-foreground', n.first && 'stroke-[2.5]')} strokeWidth={1.5} />
            {labels ? (
              <text x={n.lx} y={n.ly} dy="0.35em" textAnchor={n.lx < n.x - 4 ? 'end' : n.lx > n.x + 4 ? 'start' : 'middle'} className="fill-body font-mono text-[10px]">{short(n.id)}</text>
            ) : null}
          </Link>
        ))}
      </svg>
      <figcaption className="mt-2 flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5"><i aria-hidden className="h-0.5 w-4 bg-cycle" />round trip</span>
        <span className="flex items-center gap-1.5"><i aria-hidden className="h-0.5 w-4 bg-money" />linked by money</span>
        <span className="flex items-center gap-1.5"><i aria-hidden className="h-0.5 w-4 bg-clean" />not flagged</span>
        <span className="flex items-center gap-1.5"><i aria-hidden className="h-0 w-4 border-t-[1.5px] border-dashed border-flow" />money</span>
        <span className="flex items-center gap-1.5"><i aria-hidden className="size-2 rounded-full border-2 border-foreground" />first holder</span>
        {labels ? null : <span>{nodes.length} wallets: hover a node for its address</span>}
      </figcaption>
    </figure>
  );
}
