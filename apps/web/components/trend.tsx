'use client';

import { useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent } from 'react';
// Types only: the package's values (the store, the chain client) must stay out of the browser bundle.
import type { Bucket, Method } from '@washtrace/detect';
import { LENSES as LENS_INFO, localTime, pct } from '@/lib/format';
import { dateIn, midnight, offsetAt } from '@/lib/zone';
import { cn } from '@/lib/utils';

type Lens = Method;
type Frac = { part: number; whole: number };

/** One x position, reduced to what the chart draws. Plain data: it crosses from the server. */
export interface TimePoint {
  at: number;
  /** Per lens: flagged sales of all sales. Null when the lens did not run or there was no sale. */
  lens: Record<Lens, Frac | null>;
  sales: number;
  transfers: number;
  /** Analyses only: wallets checked for money at that analysis, and the block read through. */
  funded?: number;
  wallets?: number;
  through?: number | null;
}

/**
 * `history`: the collection's own life, one point per bucket of time its
 * trades happened in, from its first trade to `now`; past `readThrough` the
 * chain is not read yet, and the chart says so rather than drawing a quiet
 * market. `analyses`: the answer at each run of the worker.
 */
export type TimeChartProps =
  | { kind: 'history'; points: TimePoint[]; bucket: Bucket; readThrough: number | null; now: number; floor: Lens[]; zone: string }
  | { kind: 'analyses'; points: TimePoint[]; zone: string };

const LENSES = Object.keys(LENS_INFO) as Lens[];
const NAME = (m: Lens) => LENS_INFO[m].name;
// Literal class names for Tailwind. Red and amber are close for deutan
// readers, so Money loops back is also dashed and every series has its own
// marker shape: identity never rests on hue alone.
const STROKE: Record<Lens, string> = { A: 'stroke-cycle', AU: 'stroke-money', AC: 'stroke-foreground' };
const FILL: Record<Lens, string> = { A: 'fill-cycle', AU: 'fill-money', AC: 'fill-foreground' };
const DASH: Record<Lens, string | undefined> = { A: undefined, AU: '5 3', AC: undefined };

const W = 720, H = 230, L = 48, R = 16, T = 12, B = 30;
const SH = 64, ST = 8, SB = 22;
const HOUR = 3_600_000, DAY = 24 * HOUR;
const SPAN: Record<Bucket, number> = { hour: HOUR, day: DAY, week: 7 * DAY, month: 30.44 * DAY };

const share = (v: Frac | null) => (v === null || v.whole === 0 ? null : v.part / v.whole);
const never = () => () => {};

const pctText = (s: number) => pct(s, 1);

/** Round steps for a 0-based percentage axis: four to six gridlines at a share a person would say aloud. */
function yTicks(max: number): number[] {
  const steps = [0.005, 0.01, 0.02, 0.025, 0.05, 0.1, 0.2, 0.25, 0.5];
  const step = steps.find((s) => max / s <= 5) ?? 0.5;
  const top = Math.min(1, Math.max(step, Math.ceil(max / step) * step));
  return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
}

/**
 * Up to seven ticks, on boundaries of the reader's own calendar, the same
 * one the store bucketed by: the first of a month, midnight, or a round
 * minute. Each says only as much as it needs to.
 */
function xTicks(from: number, to: number, zone: string): { at: number; label: string }[] {
  const span = to - from;
  const out: { at: number; label: string }[] = [];
  if (span > 120 * DAY) {
    const months = span / (30.44 * DAY);
    const step = [1, 2, 3, 6, 12, 24].find((m) => months / m <= 7) ?? 24;
    const start = dateIn(from, zone);
    let y = start.y, m = start.m + 1;
    if (step >= 12) { y += 1; m = 0; } else m = Math.ceil(m / step) * step;
    for (let t = midnight(y, m, 1, zone); t <= to; m += step, t = midnight(y, m, 1, zone)) {
      out.push({ at: t, label: step >= 12 ? String(dateIn(t, zone).y) : localTime(t, 'month', zone) });
    }
    return out;
  }
  if (span > 3 * DAY) {
    const step = [1, 2, 7, 14, 28].find((s) => span / (s * DAY) <= 7) ?? 28;
    const start = dateIn(from, zone);
    for (let k = 1, t = midnight(start.y, start.m, start.d + 1, zone); t <= to; k += step, t = midnight(start.y, start.m, start.d + k, zone)) {
      out.push({ at: t, label: localTime(t, 'date', zone) });
    }
    return out;
  }
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720].map((m) => m * 60_000);
  const step = steps.find((s) => span / s <= 6) ?? 720 * 60_000;
  // Round on the reader's clock, not UTC's: a zone at +5:30 still ticks on its own round hours.
  const offset = offsetAt(from, zone);
  for (let t = Math.ceil((from + offset) / step) * step - offset; t <= to; t += step) out.push({ at: t, label: localTime(t, 'time', zone) });
  return out;
}

/** A bucket by the calendar period it is, in the zone it was bucketed in. */
function periodText(at: number, bucket: Bucket, zone: string): string {
  if (bucket === 'month') return localTime(at, 'month', zone);
  if (bucket === 'week') return `Week of ${localTime(at, 'date', zone)}`;
  if (bucket === 'day') return localTime(at, 'date', zone);
  return localTime(at, 'datetime', zone);
}

function Marker({ m, x, y, r = 4 }: { m: Lens; x: number; y: number; r?: number }) {
  const cls = cn(FILL[m], 'stroke-card');
  if (m === 'A') return <circle cx={x} cy={y} r={r} className={cls} strokeWidth={2} />;
  if (m === 'AU') return <rect x={x - r} y={y - r} width={r * 2} height={r * 2} className={cls} strokeWidth={2} />;
  return <path d={`M ${x} ${y - r - 1} L ${x + r + 1} ${y} L ${x} ${y + r + 1} L ${x - r - 1} ${y} Z`} className={cls} strokeWidth={2} />;
}

function Key({ m }: { m: Lens }) {
  return (
    <svg width="22" height="10" aria-hidden className="shrink-0">
      <line x1="1" x2="21" y1="5" y2="5" strokeWidth={2} strokeLinecap="round" strokeDasharray={DASH[m]} className={STROKE[m]} />
      <Marker m={m} x={11} y={5} r={2.5} />
    </svg>
  );
}

/** A series as runs of polyline: a bucket with no sale has no share, and breaks the line rather than dropping it to zero. */
function runs(pts: ({ x: number; y: number } | null)[]): string[] {
  const out: string[][] = [[]];
  for (const p of pts) {
    if (p === null) { if (out[out.length - 1]!.length > 0) out.push([]); continue; }
    out[out.length - 1]!.push(`${p.x},${p.y}`);
  }
  return out.filter((r) => r.length > 0).map((r) => r.join(' '));
}

/**
 * Each lens's share of sales over time, with a strip under it on the same
 * axis that says how much there was to judge: sales per bucket for history,
 * wallets checked for analyses. Hover, or focus and use the arrow keys, for
 * every value at one point. Times are the viewer's own.
 */
export function TimeChart(props: TimeChartProps) {
  const { points } = props;
  const svg = useRef<SVGSVGElement>(null);
  const [at, setAt] = useState<number | null>(null);
  // Tick labels are local times, which the server cannot know: draw in the browser only.
  const browser = useSyncExternalStore(never, () => true, () => false);
  const { zone } = props;
  if (!browser) return <figure className="aspect-[720/330] rounded-lg border bg-card" />;

  const history = props.kind === 'history';
  const half = history ? SPAN[props.bucket] / 2 : 0;
  const from = points[0]!.at;
  const lastAt = points[points.length - 1]!.at + 2 * half;
  const to = history ? Math.max(lastAt, props.now) : lastAt;
  const span = Math.max(1, to - from);
  const unread = history && props.readThrough !== null && props.now - props.readThrough > 2 * SPAN[props.bucket] ? props.readThrough : null;
  const max = Math.max(0.01, ...points.flatMap((p) => LENSES.map((m) => share(p.lens[m]) ?? 0)));
  const ys = yTicks(max);
  const top = ys[ys.length - 1]!;
  const x = (t: number) => L + ((t - from) / span) * (W - L - R);
  const px = (p: TimePoint) => x(p.at + half);
  const y = (v: number) => T + (1 - v / top) * (H - T - B);
  const strip = (p: TimePoint) => (history ? p.sales : p.wallets ? (p.funded ?? 0) / p.wallets : 0);
  const stripMax = history ? Math.max(1, ...points.map((p) => p.sales)) : 1;
  const sy = (v: number) => ST + (1 - v / stripMax) * (SH - ST - SB);
  const ticks = xTicks(from, to, zone);
  const floor = history ? props.floor : [];

  function nearest(clientX: number): number {
    const box = svg.current!.getBoundingClientRect();
    const pointer = ((clientX - box.left) / box.width) * W;
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(px(points[i]!) - pointer) < Math.abs(px(points[best]!) - pointer)) best = i;
    return best;
  }
  const onMove = (e: PointerEvent<SVGRectElement>) => setAt(nearest(e.clientX));
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowRight') { setAt((i) => Math.min(points.length - 1, (i ?? -1) + 1)); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { setAt((i) => Math.max(0, (i ?? points.length) - 1)); e.preventDefault(); }
    if (e.key === 'Escape') setAt(null);
  };

  const p = at === null ? null : points[at]!;
  const left = p === null ? 0 : (px(p) / W) * 100;
  const title = (q: TimePoint) => (history ? periodText(q.at, props.bucket, zone) : `Analysis at ${localTime(q.at, 'datetime', zone)}`);
  const bar = Math.max(1, Math.min(14, ((W - L - R) / Math.max(1, span / (2 * half || 1))) * 0.7));

  return (
    <figure className="rounded-lg border bg-card p-4">
      <div
        className="relative rounded outline-none focus-visible:ring-2 focus-visible:ring-focus"
        tabIndex={0} role="group"
        aria-label={`${history ? 'Share of each period’s sales' : 'Share of sales at each analysis'} flagged by each lens. Use the arrow keys to step through.`}
        onKeyDown={onKey} onFocus={() => setAt((i) => i ?? points.length - 1)} onBlur={() => setAt(null)}
      >
        <svg ref={svg} viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" aria-hidden>
          {unread !== null ? (
            <g>
              <rect x={x(unread)} y={T} width={Math.max(0, x(to) - x(unread))} height={H - T - B} className="fill-muted" />
              <text x={(x(unread) + x(to)) / 2} y={T + 16} textAnchor="middle" className="fill-muted-foreground text-[11px]">not read yet</text>
            </g>
          ) : null}
          {ys.map((v) => (
            <g key={v}>
              <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="stroke-border" strokeWidth={1} />
              <text x={L - 8} y={y(v)} dy="0.35em" textAnchor="end" className="fill-muted-foreground text-[11px] tabular-nums">{pctText(v)}</text>
            </g>
          ))}
          {ticks.map((t) => (
            <g key={t.at}>
              <line x1={x(t.at)} x2={x(t.at)} y1={H - B} y2={H - B + 4} className="stroke-border" strokeWidth={1} />
              <text x={x(t.at)} y={H - B + 17} textAnchor="middle" className="fill-muted-foreground text-[11px] tabular-nums">{t.label}</text>
            </g>
          ))}
          {LENSES.map((m) => runs(points.map((q) => { const s = share(q.lens[m]); return s === null ? null : { x: px(q), y: y(s) }; })).map((pts, i) => (
            pts.includes(' ')
              ? <polyline key={`${m}${i}`} fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" strokeDasharray={DASH[m]} className={STROKE[m]} points={pts} />
              : <Marker key={`${m}${i}`} m={m} x={Number(pts.split(',')[0])} y={Number(pts.split(',')[1])} r={2} />
          )))}
          {p ? (
            <g>
              <line x1={px(p)} x2={px(p)} y1={T} y2={H - B} className="stroke-muted-foreground" strokeWidth={1} />
              {LENSES.map((m) => { const s = share(p.lens[m]); return s === null ? null : <Marker key={m} m={m} x={px(p)} y={y(s)} />; })}
            </g>
          ) : null}
          <rect x={L} y={0} width={W - L - R} height={H} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setAt(null)} />
        </svg>

        <p className="mt-3 mb-1 text-xs text-muted-foreground">{history ? `Sales per ${props.bucket}: how much there was to judge` : 'Wallets checked for money, at each analysis'}</p>
        <svg viewBox={`0 0 ${W} ${SH}`} className="block h-auto w-full" aria-hidden>
          {unread !== null ? <rect x={x(unread)} y={ST} width={Math.max(0, x(to) - x(unread))} height={SH - ST - SB} className="fill-muted" /> : null}
          {[0, stripMax].map((v) => (
            <g key={v}>
              <line x1={L} x2={W - R} y1={sy(v)} y2={sy(v)} className="stroke-border" strokeWidth={1} />
              <text x={L - 8} y={sy(v)} dy="0.35em" textAnchor="end" className="fill-muted-foreground text-[11px] tabular-nums">{history ? v.toLocaleString() : v === 0 ? '0%' : '100%'}</text>
            </g>
          ))}
          {history ? points.map((q, i) => (
            <rect key={q.at} x={px(q) - bar / 2} y={sy(q.sales)} width={bar} height={Math.max(0, sy(0) - sy(q.sales))} rx={Math.min(2, bar / 2)}
              className={cn(at === i ? 'fill-foreground' : 'fill-muted-foreground/60')} />
          )) : (
            <>
              <polygon className="fill-ok/15 stroke-none" points={[`${x(from)},${sy(0)}`, ...points.map((q) => `${px(q)},${sy(strip(q))}`), `${x(to)},${sy(0)}`].join(' ')} />
              <polyline fill="none" strokeWidth={2} strokeLinejoin="round" className="stroke-ok" points={points.map((q) => `${px(q)},${sy(strip(q))}`).join(' ')} />
            </>
          )}
          {p ? <line x1={px(p)} x2={px(p)} y1={ST} y2={SH - SB} className="stroke-muted-foreground" strokeWidth={1} /> : null}
          <rect x={L} y={0} width={W - L - R} height={SH} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setAt(null)} />
        </svg>

        {p ? (
          <div
            role="status"
            className={cn('pointer-events-none absolute top-2 z-10 w-64 rounded-md border bg-card p-3 text-xs shadow-lg', left > 55 ? '-translate-x-[calc(100%+12px)]' : 'translate-x-3')}
            style={{ left: `${left}%` }}
          >
            <p className="mb-2 font-medium text-foreground tabular-nums">{title(p)}</p>
            <ul className="space-y-1.5">
              {LENSES.map((m) => {
                const v = p.lens[m];
                const s = share(v);
                return (
                  <li key={m} className="flex items-start gap-2">
                    <span className="pt-1"><Key m={m} /></span>
                    <span className="min-w-0">
                      {s !== null && floor.includes(m) ? <span className="text-muted-foreground">at least </span> : null}
                      <span className="font-semibold text-foreground tabular-nums">{v === null ? 'not run' : s === null ? 'no sale' : pctText(s)}</span>{' '}
                      <span className="text-muted-foreground">{NAME(m)}</span>
                      {v && v.whole > 0 ? <span className="block text-muted-foreground tabular-nums">{v.part.toLocaleString()} of {v.whole.toLocaleString()} sales</span> : null}
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="mt-2 border-t pt-2 text-muted-foreground tabular-nums">
              {history ? (
                <><span className="font-semibold text-foreground">{p.sales.toLocaleString()}</span> sales among {p.transfers.toLocaleString()} transfers this {props.bucket}</>
              ) : (
                <>
                  <span className="font-semibold text-foreground">{!p.wallets ? '—' : pctText((p.funded ?? 0) / p.wallets)}</span> wallets checked ({(p.funded ?? 0).toLocaleString()} of {(p.wallets ?? 0).toLocaleString()})
                  {p.through != null ? <span className="block">read through block {p.through.toLocaleString()}</span> : null}
                </>
              )}
            </p>
          </div>
        ) : null}
      </div>

      <figcaption className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {LENSES.map((m) => <span key={m} className="flex items-center gap-1.5"><Key m={m} />{NAME(m)}</span>)}
        <span>{points.length} {history ? `${props.bucket}s with trades` : 'analyses'} · times in {zone.replaceAll('_', ' ')} · hover or use ← → for each</span>
      </figcaption>

      <details className="mt-3 text-xs">
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Show as a table</summary>
        <div className="mt-2 max-h-72 overflow-auto rounded border">
          <table className="w-full text-left tabular-nums">
            <thead className="sticky top-0 bg-card text-muted-foreground">
              <tr className="border-b">
                <th className="px-2 py-1.5 font-medium">{history ? 'Period' : 'Analysis'}</th>
                {LENSES.map((m) => <th key={m} className="px-2 py-1.5 text-right font-medium">{NAME(m)}</th>)}
                <th className="px-2 py-1.5 text-right font-medium">{history ? 'Sales' : 'Wallets checked'}</th>
              </tr>
            </thead>
            <tbody>
              {[...points].reverse().map((q) => (
                <tr key={q.at} className="border-b last:border-b-0">
                  <td className="px-2 py-1">{history ? periodText(q.at, props.bucket, zone) : localTime(q.at, 'datetime', zone)}</td>
                  {LENSES.map((m) => { const s = share(q.lens[m]); return <td key={m} className="px-2 py-1 text-right">{s === null ? '—' : pctText(s)}</td>; })}
                  <td className="px-2 py-1 text-right">{history ? q.sales.toLocaleString() : !q.wallets ? '—' : pctText((q.funded ?? 0) / q.wallets)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
