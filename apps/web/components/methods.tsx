import Link from 'next/link';
import { METHODS, type AnalysisRow, type Method, type MethodTotals } from '@washtrace/detect';
import { METHOD_NAMES, METHOD_SENTENCES, eth, pct } from '@/lib/format';
import { cn } from '@/lib/utils';

/** A share drawn as a bar. Grey track only: the fill's hue is the verdict, and an empty bar is a reading of zero. */
function Bar({ part, whole, tone }: { part: number; whole: number; tone: 'cycle' | 'money' }) {
  const w = whole === 0 ? 0 : Math.max(part > 0 ? 1.5 : 0, (part / whole) * 100);
  return (
    <span className="flex items-center gap-2">
      <span aria-hidden className="relative h-2 w-28 overflow-hidden rounded-full bg-muted">
        <i className={cn('absolute inset-y-0 left-0 rounded-full', tone === 'cycle' ? 'bg-cycle' : 'bg-money')} style={{ width: `${w}%` }} />
      </span>
      <span className="font-mono tabular-nums text-foreground">{pct(part, whole)}</span>
    </span>
  );
}

/**
 * The paper's Tables 3 and 4 for one collection, live: each method's wash
 * trade share of ownership changes, then of sales and of volume. A method
 * that could not run says so in grey and never shows a share.
 */
export function MethodTable({ totals, href, selected }: { totals: Record<Method, MethodTotals>; href?: (m: Method) => string; selected?: Method }) {
  return (
    <div className="overflow-x-auto rounded-md border bg-card">
      <table className="w-full min-w-[46rem] text-left">
        <thead className="text-xs text-muted-foreground">
          <tr className="border-b">
            <th className="px-3 py-2 font-medium">Method</th>
            <th className="px-3 py-2 font-medium">Wash trade share</th>
            <th className="px-3 py-2 font-medium">Of sales</th>
            <th className="px-3 py-2 font-medium">Of volume</th>
            <th className="px-3 py-2 text-right font-medium">Wallets</th>
            <th className="px-3 py-2 text-right font-medium">Tokens</th>
          </tr>
        </thead>
        <tbody>
          {METHODS.map((m) => {
            const t = totals[m];
            const name = <span className="font-mono font-semibold text-foreground">{METHOD_NAMES[m]}</span>;
            return (
              <tr key={m} className={cn('border-b last:border-b-0 align-top', selected === m && 'bg-muted/60')}>
                <td className="max-w-[22rem] px-3 py-2.5">
                  {href ? <Link href={href(m)} className="hover:underline">{name}</Link> : name}
                  <p className="mt-0.5 text-xs text-muted-foreground">{METHOD_SENTENCES[m]}</p>
                </td>
                {t.available ? (
                  <>
                    <td className="px-3 py-2.5">
                      <Bar part={t.flagged} whole={t.transfers} tone={m === 'A' ? 'cycle' : 'money'} />
                      <p className="mt-0.5 font-mono text-xs text-muted-foreground tabular-nums">{t.flagged.toLocaleString()} of {t.transfers.toLocaleString()} changes of owner</p>
                    </td>
                    <td className="px-3 py-2.5 font-mono tabular-nums">
                      {pct(t.flaggedSales, t.sales)}
                      <p className="text-xs text-muted-foreground">{t.flaggedSales.toLocaleString()} of {t.sales.toLocaleString()}</p>
                    </td>
                    <td className="px-3 py-2.5 font-mono tabular-nums">
                      {t.volumeWei === '0' ? '—' : pct(Number(BigInt(t.flaggedVolumeWei) / 10n ** 12n), Number(BigInt(t.volumeWei) / 10n ** 12n))}
                      <p className="text-xs text-muted-foreground">{eth(t.flaggedVolumeWei)} of {eth(t.volumeWei)}</p>
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums">{t.wallets.toLocaleString()}</td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums">{t.tokens.toLocaleString()}</td>
                  </>
                ) : (
                  <td colSpan={5} className="px-3 py-2.5 text-muted-foreground">
                    Not run: it reads who paid whom, and no funding source is configured. Set <code className="font-mono text-xs">WASHTRACE_ETHERSCAN_KEY</code>.
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Each method's share across the collection's analyses. It rises as funding
 * coverage grows, which is the reading of AU and AC filling in, not the wash
 * trading changing; the coverage line under it says how far along that is.
 */
export function Trend({ history: all }: { history: AnalysisRow[] }) {
  // An analysis of nothing has no share; drawn, it would be a box with no line.
  const history = all.filter((a) => a.totals.A.transfers > 0);
  if (history.length < 2) return null;
  const W = 420, H = 90, P = 4;
  const share = (a: AnalysisRow, m: Method) => (a.totals[m].transfers === 0 || !a.totals[m].available ? null : a.totals[m].flagged / a.totals[m].transfers);
  const max = Math.max(0.01, ...history.flatMap((a) => METHODS.map((m) => share(a, m) ?? 0)));
  const x = (i: number) => P + (i / (history.length - 1)) * (W - 2 * P);
  const y = (v: number) => H - P - (v / max) * (H - 2 * P);
  const tone: Record<Method, string> = { A: 'stroke-cycle', AU: 'stroke-money', AC: 'stroke-foreground' };
  return (
    <figure className="rounded-md border bg-card p-3">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-24 w-full max-w-[28rem]" role="img" aria-label="Wash trade share by method across analyses">
        {METHODS.map((m) => {
          const pts = history.map((a, i) => [i, share(a, m)] as const).filter((p) => p[1] !== null);
          if (pts.length < 2) return null;
          return <polyline key={m} fill="none" strokeWidth={m === 'AC' ? 2 : 1.5} className={tone[m]} points={pts.map(([i, v]) => `${x(i)},${y(v!)}`).join(' ')} />;
        })}
      </svg>
      <figcaption className="mt-1 flex flex-wrap gap-x-4 text-xs text-muted-foreground">
        {METHODS.map((m) => (
          <span key={m} className="flex items-center gap-1.5">
            <i aria-hidden className={cn('h-0.5 w-3', m === 'A' ? 'bg-cycle' : m === 'AU' ? 'bg-money' : 'bg-foreground')} />{METHOD_NAMES[m]}
          </span>
        ))}
        <span>peak {(max * 100).toFixed(1)}% · {history.length} analyses</span>
      </figcaption>
    </figure>
  );
}
