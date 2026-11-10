import { EDGE_TYPES, ruleLine, type LensRule } from '@washtrace/detect/lens-rule';
import { cn } from '@/lib/utils';

// Past three wallets between, more circles say no more; the "…" and the words keep the number.
const DRAWN = 3;

/**
 * A lens's rule as the loop it looks for: the sale from seller to buyer on
 * top, and under it the way back, through the wallets the rule allows between
 * (a dashed circle when it allows more than it needs), drawn solid for NFT
 * edges, dashed for money, and both when it takes both. Its words are the
 * picture's name, and the edges it takes and its window are chips beside it.
 */
export function RulePicture({ rule, className }: { rule: LensRule; className?: string }) {
  const on = EDGE_TYPES.filter((e) => rule.edges[e.kind].use);
  const nft = on.some((e) => !e.money), money = on.some((e) => e.money);
  const need = Math.min(rule.hops.min, DRAWN);
  const more = rule.hops.max === null || rule.hops.max > rule.hops.min;
  const between = need + (more ? 1 : 0);
  const xs = Array.from({ length: between }, (_, i) => 40 + ((i + 1) * 140) / (between + 1));
  const back = money && !nft ? '4 3' : money && nft ? '8 3 2 3' : undefined;
  const pts = [[180, 20], ...xs.slice().reverse().map((x) => [x, 58]), [40, 20]];
  return (
    <div className={cn('flex flex-wrap items-center gap-3', className)}>
      <svg viewBox="0 0 220 76" role="img" aria-label={ruleLine(rule)} className="h-16 w-48 shrink-0">
        <path d="M48 20H170" strokeWidth={1.8} className="stroke-money" />
        <path d="M164 15l7 5-7 5" fill="none" strokeWidth={1.6} className="stroke-money" />
        <path d={`M${pts.map(([x, y]) => `${x} ${y}`).join('L')}`} fill="none" strokeWidth={1.5} className="stroke-flow" {...(back ? { strokeDasharray: back } : {})} />
        <circle cx="40" cy="20" r="7" strokeWidth={1.5} className="fill-card stroke-foreground" />
        <circle cx="180" cy="20" r="7" strokeWidth={1.5} className="fill-card stroke-foreground" />
        {xs.map((x, i) => {
          const optional = more && i === xs.length - 1;
          return <circle key={x} cx={x} cy="58" r="5.5" strokeWidth={1.4} className="fill-card stroke-flow" {...(optional ? { strokeDasharray: '2 2' } : {})} />;
        })}
        {rule.hops.min > DRAWN ? <text x="110" y="74" textAnchor="middle" className="fill-muted-foreground text-[9px]">{rule.hops.min} between</text> : null}
        {rule.closes === 'seller-or-funder' ? <text x="40" y="44" textAnchor="middle" className="fill-muted-foreground text-[9px]">or funder</text> : null}
      </svg>
      <ul className="flex flex-wrap gap-1 text-[11px] text-muted-foreground">
        {on.map((e) => <li key={e.kind} className="rounded-full border px-2 py-px">{e.label}</li>)}
        {rule.window === null ? null : <li className="rounded-full border px-2 py-px">within {rule.window.days} days {rule.window.side === 'either' ? 'either side' : rule.window.side}</li>}
        {rule.minCycles > 1 ? <li className="rounded-full border px-2 py-px">{rule.minCycles}+ times</li> : null}
      </ul>
    </div>
  );
}
