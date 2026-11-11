import Link from 'next/link';
import { isOwnKey, type LensKey } from '@washtrace/detect/trades';
import { SHOWN, lensInfo, num, pct, type Lenses } from '@/lib/format';
import { tradesHref } from '@/lib/trades-url';

type Counts = Partial<Record<LensKey, Partial<Record<LensKey, number>>>>;

/** Five steps of the flow colour, written whole so Tailwind sees each class. */
const SHADES = ['bg-flow/10', 'bg-flow/20', 'bg-flow/30', 'bg-flow/40', 'bg-flow/50'] as const;

/**
 * How the lenses that ran overlap, in sales: a row is a lens's catches, a
 * column "also caught by". `both` and `not` are the store's `compare` counts,
 * and each number is exactly what its link opens (the same query), so none is
 * worked out here: "N not" is `not[r][c]`, never the row's total minus the
 * cell, which differs whenever column c's run is behind. The diagonal is the
 * row's own total. `left` names the lenses with no figures here and why (one
 * that did not run, or one of yours whose first run is unfinished or failed);
 * they are never a row of zeros.
 */
export function Compare({ base, both, not, keys: ran, own, left }: {
  base: string; both: Counts; not: Counts; keys: readonly LensKey[]; own: Lenses;
  left: { key: LensKey; why: string }[];
}) {
  // `keys` comes in the API's order (lensContext's `ran`); rows and columns read floor, ceiling, not counted, then yours.
  const keys = [...SHOWN.filter((m) => ran.includes(m)), ...ran.filter(isOwnKey)];
  const name = (k: LensKey) => lensInfo(k, own)?.name ?? '';
  const n = (m: Counts, r: LensKey, c: LensKey) => m[r]?.[c] ?? 0;
  return (
    <div>
      <p className="mb-3 text-sm text-muted-foreground">
        Sales that two lenses both flagged. Each row is a lens&rsquo;s catches and each column the lens that also caught them; the number opens those trades, and the count under it the ones the column lens judged and did not flag.
      </p>
      {keys.length < 2 ? (
        <p className="mb-3 text-sm text-muted-foreground">
          {keys.length === 0 ? 'No lens has run on this collection' : `Only ${name(keys[0]!)} has run on this collection`}, so there is nothing to compare yet.
        </p>
      ) : (
        <div className="mb-3 overflow-x-auto">
          <table className="text-sm">
            <caption className="sr-only">Sales each lens caught, by the lens that also caught them</caption>
            <thead>
              <tr>
                <th scope="col" className="p-2 text-left text-xs font-medium text-muted-foreground">Catches</th>
                {keys.map((c) => <th key={c} scope="col" className="p-2 text-left text-xs font-medium text-muted-foreground" title={`Sales also caught by ${name(c)}`}>also caught by {name(c)}</th>)}
              </tr>
            </thead>
            <tbody>
              {keys.map((r) => {
                const total = n(both, r, r);
                return (
                  <tr key={r}>
                    <th scope="row" className="p-2 text-left font-medium">{name(r)}</th>
                    {keys.map((c) => {
                      if (r === c) {
                        return (
                          <td key={c} data-cell={`${r}.${c}`} title={`${name(r)} caught ${num(total)} sales in all.`} className="border p-2 tabular-nums">
                            <Link href={tradesHref(base, { caught: [r] })} prefetch={false} className="font-semibold hover:underline">{num(total)}</Link>
                          </td>
                        );
                      }
                      const cell = n(both, r, c);
                      const share = total === 0 ? 0 : cell / total;
                      const shade = cell === 0 ? '' : SHADES[Math.min(4, Math.floor(share * 5))];
                      return (
                        <td key={c} data-cell={`${r}.${c}`} className={`border p-2 tabular-nums ${shade}`}
                          title={`Of the ${num(total)} sales ${name(r)} caught, ${name(c)} also caught ${num(cell)} (${pct(cell, total)}).`}>
                          <Link href={tradesHref(base, { caught: [r, c] })} prefetch={false} className="font-semibold hover:underline">{num(cell)}</Link>
                          <Link href={tradesHref(base, { caught: [r], notCaught: [c] })} prefetch={false} title={`Sales ${name(r)} caught that ${name(c)} judged and did not flag`} className="block text-xs text-muted-foreground hover:underline">{num(n(not, r, c))} not</Link>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {left.length === 0 ? null : (
        <div className="text-sm text-muted-foreground">
          <p>Left out, because they have no figures here to compare:</p>
          <ul className="mt-1 list-disc pl-5">
            {left.map((l) => <li key={l.key}><span className="font-medium text-foreground">{name(l.key)}</span> {l.why}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}
