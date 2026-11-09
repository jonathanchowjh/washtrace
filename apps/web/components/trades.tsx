import type { ReactNode } from 'react';
import Link from 'next/link';
import { METHODS, type TradeRow } from '@washtrace/detect';
import { VENUES, isOwnKey, venueOf, type LensKey, type TradeContext, type TradeGroupBy, type TradeQuery, type TradeSort } from '@washtrace/detect/trades';
import { SortHead } from '@/components/ui';
import { DOT, NotCounted } from '@/components/methods';
import { Wallet } from '@/components/transfers';
import { NOT_JUDGED_YET, NOT_RUN, eth, lensInfo, localTime, num, pct, tokenLabel, weiToEth, type Lenses } from '@/lib/format';
import { judgedBy } from '@/lib/metrics';
import { dateIn, midnight } from '@/lib/zone';
import { bandLabel, chips, duration, groupFilter, tradesHref, type View } from '@/lib/trades-url';
import { cn } from '@/lib/utils';

/**
 * The Trades view's three parts: the Find box, chips and filter form; the
 * Group by table; and the table of trades. Server components all: every
 * control is a link or a plain GET form, so the address bar holds the view.
 */

/** `own` is your lenses by key, for their names and hues; the built-ins need no entry. */
interface Where { base: string; q: TradeQuery; view: View; zone: string; own?: Lenses }

const lensTitle = (m: LensKey, own: Lenses = {}) => { const i = lensInfo(m, own); return i === null ? '' : <>{i.name}{i.tone === 'apart' ? <NotCounted /> : null}</>; };

/** Your lenses' keys, built-ins first: the lenses a table can draw, in the order it draws them. */
const withOwn = (ran: readonly LensKey[]) => [...METHODS.filter((m) => ran.includes(m)), ...ran.filter(isOwnKey)];

/** The current view's parameters as hidden inputs, less the ones a form shows itself or must not keep. */
function carried({ base, q, view }: Where, keep: (key: string) => boolean) {
  const params = new URL(tradesHref(base, q, { by: view.by }), 'http://x.invalid').searchParams;
  return [...params].filter(([k]) => keep(k)).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />);
}

function Duration({ name, label, seconds }: { name: string; label: string; seconds: number | null }) {
  const d = seconds === null ? null : /^(\d+)([mhd])$/.exec(duration(seconds));
  return (
    <div className="flex flex-col gap-1 text-sm">
      <label htmlFor={`${name}_n`} className="text-muted-foreground">{label}</label>
      <span className="flex gap-1.5">
        <input id={`${name}_n`} type="number" name={`${name}_n`} min={0} step={1} defaultValue={d?.[1] ?? ''} className="field w-24 tabular-nums" />
        <select name={`${name}_u`} defaultValue={d?.[2] ?? 'h'} aria-label={`${label}, unit`} className="field">
          <option value="m">min</option>
          <option value="h">h</option>
          <option value="d">d</option>
        </select>
      </span>
    </div>
  );
}

/** Whether a bound falls inside a day in the reader's zone, as an hour period's does: a day field cannot hold it. */
function offMidnight(ms: number | null, zone: string): boolean {
  if (ms === null) return false;
  const d = dateIn(ms, zone);
  return midnight(d.y, d.m, d.d, zone) !== ms;
}

/**
 * A day bound. One inside a day goes back as the view's own hidden `from` or
 * `to` (FilterBar carries it), which parseView reads over the day field, so a
 * new filter does not widen an hour to its day; the field is left empty and
 * disabled, as a day typed there would be read under the kept bound, and says
 * what is kept.
 */
function Day({ name, label, ms, zone }: { name: string; label: string; ms: number | null; zone: string }) {
  const kept = offMidnight(ms, zone);
  const d = ms === null || kept ? null : dateIn(ms, zone);
  const value = d === null ? '' : `${d.y}-${String(d.m + 1).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <input type="date" name={`${name}_day`} defaultValue={value} disabled={kept} className="field disabled:opacity-50" />
      {kept ? <span className="text-xs text-muted-foreground">Kept at {localTime(ms!, 'datetime', zone, 'en-US')}; remove the date chip to change it.</span> : null}
    </label>
  );
}

function Text({ name, label, value, type = 'text', placeholder }: { name: string; label: string; value: string | null; type?: string; placeholder?: string }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <input type={type} name={name} defaultValue={value ?? ''} placeholder={placeholder} step="any" min={type === 'number' ? 0 : undefined} className="field w-28 tabular-nums" />
    </label>
  );
}

function Checks({ title, name, options, on }: { title: string; name: string; options: [string, string][]; on: readonly string[] }) {
  return (
    <fieldset className="flex flex-col gap-1 text-sm">
      <legend className="mb-1 text-muted-foreground">{title}</legend>
      {options.map(([value, label]) => (
        <label key={value} className="flex items-center gap-1.5">
          <input type="checkbox" name={name} value={value} defaultChecked={on.includes(value)} />
          {label}
        </label>
      ))}
    </fieldset>
  );
}

/** Find, the filters in play as chips that each remove one, and the form that adds more. */
export function FilterBar(w: Where) {
  const { base, q, view, zone, own = {} } = w;
  const lenses = [...METHODS, ...Object.keys(own)].flatMap((k): [string, string][] => { const i = lensInfo(k, own); return i === null ? [] : [[k, i.name]]; });
  const names = Object.fromEntries(Object.entries(own).map(([k, i]) => [k, i.name]));
  const venues = Object.entries(VENUES).map(([k, v]): [string, string] => [k, v.name]);
  return (
    <section aria-label="Filters" className="mt-4 space-y-3">
      <form action={`${base}/trades`} method="get" role="search" className="flex flex-wrap items-center gap-2">
        {carried(w, (k) => k !== 'q')}
        <input type="search" name="q" defaultValue={q.find ?? ''} placeholder="Token number, wallet or tx" aria-label="Find a trade by token number, wallet or transaction" className="field w-72 max-w-full" />
        <button type="submit" className="btn-secondary text-sm">Find</button>
      </form>

      <div className="flex flex-wrap items-start gap-2">
        {chips(base, q, view, zone, names).map((c) => (
          <Link key={c.key} href={c.href} title="Remove this filter" className="rounded-full border bg-muted/50 px-2.5 py-1 text-sm hover:bg-card">
            {c.label} <span aria-hidden className="text-muted-foreground">×</span>
          </Link>
        ))}
        <details className="rounded-md border bg-card">
          <summary className="cursor-pointer px-2.5 py-1 text-sm font-medium">+ Filter</summary>
          <form action={`${base}/trades`} method="get" aria-label="Filter trades" className="space-y-4 border-t p-3">
            {carried(w, (k) => ['wallet', 'token', 'group', 'q', 'all', 'sort', 'dir', 'by'].includes(k)
              || (k === 'from' && offMidnight(q.fromMs, zone)) || (k === 'to' && offMidnight(q.toMs, zone)))}
            <div className="flex flex-wrap gap-x-8 gap-y-4">
              <Checks title="Flagged by" name="caught" options={lenses} on={q.caught} />
              <Checks title="Not flagged by" name="not" options={lenses} on={q.notCaught} />
              <Checks title="Marketplace" name="market" options={venues} on={q.venues} />
            </div>
            <div className="flex flex-wrap gap-4">
              <Text name="pmin" label="Price at least (ETH)" type="number" value={q.priceMinWei === null ? null : weiToEth(q.priceMinWei)} />
              <Text name="pmax" label="Price at most (ETH)" type="number" value={q.priceMaxWei === null ? null : weiToEth(q.priceMaxWei)} />
              <Duration name="heldover" label="Held over" seconds={q.heldOverS} />
              <Duration name="heldunder" label="Held under" seconds={q.heldUnderS} />
              <Duration name="ageover" label="Buyer wallet older than" seconds={q.buyerAgeOverS} />
              <Duration name="ageunder" label="Buyer wallet younger than" seconds={q.buyerAgeUnderS} />
              <Text name="fmin" label="Price vs floor at least (×)" type="number" value={q.floorMin === null ? null : String(q.floorMin)} />
              <Text name="fmax" label="Price vs floor under (×)" type="number" value={q.floorMax === null ? null : String(q.floorMax)} />
              <Day name="from" label={`From (${zone})`} ms={q.fromMs} zone={zone} />
              <Day name="to" label={`Before (${zone})`} ms={q.toMs} zone={zone} />
            </div>
            <button type="submit" className="rounded-md bg-foreground px-3 py-1 text-sm font-medium text-background">Show these trades</button>
          </form>
        </details>
      </div>
    </section>
  );
}

const BYS: [TradeGroupBy, string][] = [['marketplace', 'Marketplace'], ['month', 'Month'], ['held', 'Held time'], ['floor', 'Price vs floor'], ['buyerAge', 'Buyer age']];
const BY_NAME = Object.fromEntries(BYS);

/**
 * Why a trade has no value to group by, as groupKey reads it: no marketplace;
 * no block time; or no trade facts (not judged yet), or a fact the analysis
 * could not give: a token's first transfer has no hold, and a price needs
 * money and a priced sale in the days before for its floor.
 */
const UNKNOWN: Readonly<Record<TradeGroupBy, string>> = {
  marketplace: 'Not a marketplace sale',
  month: 'No block time',
  held: "Not judged yet, its token's first transfer, or no block time",
  buyerAge: 'Not judged yet, or no block time',
  floor: 'Unpriced, not in ETH, WETH or Blur Pool, no priced sale in the 7 days before, no block time, or not judged yet',
};

function groupLabel(by: TradeGroupBy, key: string): string {
  if (key === '-') return UNKNOWN[by];
  if (by === 'marketplace') return VENUES[key]?.name ?? key;
  if (by === 'month') {
    const m = /^(\d{4})-(\d{2})$/.exec(key);
    return m ? localTime(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1), 'month', 'UTC', 'en-US') : key;
  }
  return bandLabel(by, key);
}

/**
 * How the matching trades split up, each row a link to its own trades. A lens
 * of yours's share is of the trades it judged in the group (`judged`), not of
 * every one: those past the block its run read are not judged yet.
 */
export function GroupBy({ base, q, view, zone, own = {}, groups, ran }: Where & {
  groups: { key: string; trades: number; caught: Partial<Record<LensKey, number>>; judged?: Partial<Record<LensKey, number>> }[] | null; ran: readonly LensKey[];
}) {
  const by = view.by;
  // The built-ins always, with NOT_RUN where one did not run; yours only once they have run.
  const cols = [...METHODS, ...ran.filter(isOwnKey)];
  return (
    <section aria-label="Group by" className="mt-6">
      <nav className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
        <span className="text-muted-foreground">Group by</span>
        {BYS.map(([b, label]) => (
          <Link key={b} href={tradesHref(base, q, { by: b })} aria-current={b === by ? 'page' : undefined}
            className={cn('rounded-md px-2 py-0.5', b === by ? 'bg-foreground text-background' : 'border bg-card hover:bg-muted')}>
            {label}
          </Link>
        ))}
        {by === null ? null : <Link href={tradesHref(base, q)} className="px-1 text-muted-foreground hover:underline">No grouping</Link>}
      </nav>
      {by === null || groups === null ? null : (
        <div className="mt-3 overflow-x-auto rounded-lg border bg-card">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">{BY_NAME[by]}</th>
                <th className="px-3 py-2 text-right font-medium">Trades</th>
                {cols.map((m) => <th key={m} className="px-3 py-2 text-right font-medium">{lensTitle(m, own)}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y">
              {groups.map((g) => {
                const f = groupFilter(by, g.key, zone);
                const to = (extra: Partial<TradeQuery> = {}) => (f === null ? null : tradesHref(base, { ...q, ...f, ...extra }, { by }));
                return (
                  // A row no filter can hold (the unknown group, a marketplace with no name here) is not a list to open.
                  <tr key={g.key} data-unlisted={f === null ? '' : undefined}>
                    <td className="px-3 py-2">{groupLabel(by, g.key)}</td>
                    <td className="px-3 py-2 text-right tabular-nums"><Cell href={to()}>{num(g.trades)}</Cell></td>
                    {cols.map((m) => (
                      <td key={m} className="px-3 py-2 text-right tabular-nums">
                        {ran.includes(m) ? <Cell href={to({ caught: [m] })}>{pct(g.caught[m] ?? 0, g.judged?.[m] ?? g.trades)}</Cell> : <span className="text-muted-foreground">{NOT_RUN}</span>}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Cell({ href, children }: { href: string | null; children: React.ReactNode }) {
  return href === null ? <>{children}</> : <Link href={href} className="hover:underline">{children}</Link>;
}

// ---- trades -----------------------------------------------------------------

/** The sort a header starts with: names read A to Z, the rest biggest or newest first. */
const FIRST_ASC: readonly TradeSort[] = ['token', 'seller', 'marketplace'];

const COLUMNS: [TradeSort, string][] = [['date', 'Date'], ['token', 'Token'], ['seller', 'Seller → buyer'], ['price', 'Price'], ['marketplace', 'Marketplace'], ['held', 'Held'], ['buyerAge', 'Buyer age'], ['floor', 'vs floor']];

/** "<1 min", "45 min", "3 h", "12 d": a length of time to one unit, rounded down. */
function span(s: number | null): string {
  if (s === null) return '—';
  return s < 60 ? '<1 min' : s < 3_600 ? `${Math.floor(s / 60)} min` : s < 86_400 ? `${Math.floor(s / 3_600)} h` : `${Math.floor(s / 86_400)} d`;
}


function Th({ sort, label, where, tone }: { sort: TradeSort; label: ReactNode; where: Where; tone?: LensKey }) {
  const { base, q, view } = where;
  const here = q.sort === sort;
  const dir = here ? (q.dir === 'asc' ? 'desc' : 'asc') : FIRST_ASC.includes(sort) ? 'asc' : 'desc';
  return (
    <SortHead href={tradesHref(base, { ...q, sort, dir }, { by: view.by })} dir={here ? (q.dir === 'asc' ? 'asc' : 'desc') : null}>
      {tone ? <i aria-hidden className={cn('size-2 shrink-0 rounded-full', DOT[lensInfo(tone, where.own ?? {})?.tone ?? 'apart'])} /> : null}
      {label}
    </SortHead>
  );
}

/**
 * One page of trades: a dot per lens that ran, and links from every name and
 * number to what it opens. `through` is, for each lens of yours, the block its
 * run read (lensContext): a trade past it reads not judged yet in that lens's
 * column, as a trade no analysis covered reads across them all.
 */
export function TradesTable({ chainId, rows, ran, through, money, ...where }: Where & {
  chainId: number; rows: readonly TradeRow[]; ran: readonly LensKey[]; through: TradeContext['through']; money: ReadonlySet<string>;
}) {
  const { base, q, view, zone, own = {} } = where;
  const lenses = withOwn(ran);
  const only = (extra: Partial<TradeQuery>, title: string) => (
    <Link href={tradesHref(base, { ...q, ...extra }, { by: view.by })} title={title} className="ml-1 text-muted-foreground hover:text-foreground">⊕</Link>
  );
  const wallet = (a: string) => (
    <span className="whitespace-nowrap"><Wallet chainId={chainId} address={a} />{/^0x0+$/.test(a) ? null : only({ wallet: a }, 'Only trades with this wallet')}</span>
  );
  return (
    <div className="mt-4 overflow-x-auto rounded-lg border bg-card">
      <table className="w-full text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr>
            {COLUMNS.map(([sort, label]) => <Th key={sort} sort={sort} label={label} where={where} />)}
            {lenses.map((m) => <Th key={m} sort={`lens-${m}`} label={lensTitle(m, own)} where={where} tone={m} />)}
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((r) => {
            const venue = r.marketplace === null ? null : venueOf(r.marketplace);
            const priced = r.priceWei !== null && r.currency !== null && money.has(r.currency);
            // The price opens the trade, as a price does in the transfer tables.
            const trade = (v: string) => (v === '—' ? v : <Link href={`/tx/${chainId}/${r.txHash}`} title="Open this trade" className="hover:underline">{v}</Link>);
            return (
              <tr key={`${r.txHash}-${r.logIndex}`}>
                <td className="whitespace-nowrap px-3 py-2">
                  <Link href={`/tx/${chainId}/${r.txHash}`} className="hover:underline">{r.blockTime === null ? 'Unknown time' : localTime(r.blockTime * 1000, 'datetime', zone, 'en-US')}</Link>
                </td>
                <td className="whitespace-nowrap px-3 py-2 font-mono">
                  <Link href={`${base}/t/${r.tokenId}`} className="hover:underline">#{tokenLabel(r.tokenId)}</Link>
                  {only({ token: r.tokenId }, 'Only trades with this token')}
                </td>
                <td className="px-3 py-2">{wallet(r.from)} → {wallet(r.to)}</td>
                <td className="whitespace-nowrap px-3 py-2 tabular-nums">{trade(priced ? eth(r.priceWei) : '—')}</td>
                <td className="whitespace-nowrap px-3 py-2">{venue === null ? '—' : VENUES[venue]?.name ?? venue}</td>
                {/* The trade's own measures count no list, and the row's date opens the trade. */}
                <td data-measure className="whitespace-nowrap px-3 py-2 tabular-nums">{span(r.heldS)}</td>
                <td data-measure className="whitespace-nowrap px-3 py-2 tabular-nums">{span(r.buyerAgeS)}</td>
                <td data-measure className="whitespace-nowrap px-3 py-2 tabular-nums">{r.floorRatio === null ? '—' : `${r.floorRatio.toFixed(2)}×`}</td>
                {r.judged
                  ? lenses.map((m) => (
                    <td key={m} className="px-3 py-2">
                      {!judgedBy(r, m, through)
                        ? <span title={`Newer than the block ${lensInfo(m, own)?.name}'s run read through`} className="whitespace-nowrap text-xs text-muted-foreground">{NOT_JUDGED_YET}</span>
                        : r.lenses.includes(m)
                        ? <i role="img" aria-label={`Flagged by ${lensInfo(m, own)?.name}`} className={cn('inline-block size-2.5 rounded-full', DOT[lensInfo(m, own)?.tone ?? 'apart'])} />
                        : <span aria-label="Not flagged" className="text-muted-foreground">–</span>}
                    </td>
                  ))
                  // With no lens run there is no lens column to say it in.
                  : lenses.length > 0 ? <td colSpan={lenses.length} className="px-3 py-2 text-muted-foreground">{NOT_JUDGED_YET}</td> : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
