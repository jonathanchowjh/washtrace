import type { ReactNode } from 'react';
import Link from 'next/link';
import { type Method, type TradeRow, type Witness } from '@washtrace/detect';
import { VENUES, isOwnKey, venueName, type LensKey, type TradeContext, type TradeGroupBy, type TradeQuery, type TradeSort } from '@washtrace/detect/trades';
import { Time } from '@/components/zone';
import { SortHead } from '@/components/ui';
import { FunnelIcon, SearchIcon, TierMark } from '@/components/kit';
import { TokenLink, Wallet, because } from '@/components/transfers';
import { NOT_JUDGED_YET, NOT_RUN, SHOWN, andList, eth, lensInfo, localTime, num, pct, weiToEth, type Lenses } from '@/lib/format';
import { carry, txHref } from '@/lib/links';
import { judgedBy } from '@/lib/metrics';
import { caughtLens } from '@/lib/params';
import { dateIn, midnight } from '@/lib/zone';
import { MEDIAN, bandLabel, chips, duration, groupFilter, tradesHref, type View } from '@/lib/trades-url';
import { cn } from '@/lib/utils';
import { TierWord } from './methods';

/**
 * The Trades view's three parts: the Find box, chips and filter form; the
 * Group by table; and the table of trades. Server components all: every
 * control is a link or a plain GET form, so the address bar holds the view.
 */

/** `own` is your lenses by key, for their names and hues; the built-ins need no entry. */
interface Where { base: string; q: TradeQuery; view: View; zone: string; own?: Lenses }

// One item in a header's row, so each built-in's standing sits under its name rather than in what reads as a column of its own; yours have none.
const lensTitle = (m: LensKey, own: Lenses = {}) => { const i = lensInfo(m, own); return i === null ? '' : <span>{i.name}{isOwnKey(m) ? null : <TierWord m={m as Method} />}</span>; };

/** Your lenses' keys, built-ins first: the lenses a table can draw, in the order it draws them. */
const withOwn = (ran: readonly LensKey[]) => [...SHOWN.filter((m) => ran.includes(m)), ...ran.filter(isOwnKey)];

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
      {kept ? <span className="text-xs text-muted-foreground">Kept at {localTime(ms!, 'datetime', zone, 'en-GB')}; remove the date chip to change it.</span> : null}
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
  const lenses = [...SHOWN, ...Object.keys(own)].flatMap((k): [string, string][] => { const i = lensInfo(k, own); return i === null ? [] : [[k, i.name]]; });
  const names = Object.fromEntries(Object.entries(own).map(([k, i]) => [k, i.name]));
  const venues = Object.entries(VENUES).map(([k, v]): [string, string] => [k, v.name]);
  return (
    <section aria-label="Filters" className="mt-4 space-y-3">
      {/* Find looks one trade up, so it wears the magnifier; the funnel is Filter's alone. The box gives way on a phone so Find stays beside it. */}
      <form action={`${base}/trades`} method="get" role="search" className="flex items-center gap-2">
        {carried(w, (k) => k !== 'q')}
        <SearchIcon className="text-muted-foreground" />
        <input type="search" name="q" defaultValue={q.find ?? ''} placeholder="Token number, wallet or tx" aria-label="Find a trade by token number, wallet or transaction" className="field min-w-0 flex-1 sm:w-72 sm:flex-none" />
        <button type="submit" className="btn-secondary text-sm">Find</button>
      </form>

      <div className="flex flex-wrap items-start gap-2">
        {chips(base, q, view, zone, names).map((c) => (
          <Link key={c.key} href={c.href} prefetch={false} title="Remove this filter" className="rounded-full border bg-muted/50 px-2.5 py-1 text-sm hover:bg-card">
            {c.label} <span aria-hidden className="text-muted-foreground">×</span>
          </Link>
        ))}
        {/* One control: the funnel says it narrows the list, the chevron that it opens; the browser's own triangle is hidden. A plain <details>, so it opens with no script. */}
        <details className="group rounded-md border bg-card">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md px-2.5 py-1 text-sm font-medium hover:bg-muted group-open:rounded-b-none [&::-webkit-details-marker]:hidden">
            <FunnelIcon className="size-3.5 text-muted-foreground" />Filter
            <span aria-hidden className="text-muted-foreground transition-transform group-open:rotate-90">›</span>
          </summary>
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
              <Text name="fmin" label={`Price vs ${MEDIAN}, at least (×)`} type="number" value={q.floorMin === null ? null : String(q.floorMin)} />
              <Text name="fmax" label={`Price vs ${MEDIAN}, under (×)`} type="number" value={q.floorMax === null ? null : String(q.floorMax)} />
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

const BYS: [TradeGroupBy, string][] = [['marketplace', 'Marketplace'], ['month', 'Month'], ['held', 'Held time'], ['floor', `Price vs ${MEDIAN}`], ['buyerAge', 'Buyer age']];
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
  if (by === 'marketplace') return venueName(key);
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
  const cols = [...SHOWN, ...ran.filter(isOwnKey)];
  return (
    <section aria-label="Group by" className="mt-6">
      <nav className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
        <span className="text-muted-foreground">Group by</span>
        {BYS.map(([b, label]) => (
          <Link key={b} href={tradesHref(base, q, { by: b })} prefetch={false} aria-current={b === by ? 'page' : undefined}
            className={cn('rounded-md px-2 py-0.5', b === by ? 'bg-foreground text-background' : 'border bg-card hover:bg-muted')}>
            {label}
          </Link>
        ))}
        {by === null ? null : <Link href={tradesHref(base, q)} prefetch={false} className="px-1 text-muted-foreground hover:underline">No grouping</Link>}
      </nav>
      {by === null || groups === null ? null : (
        <div className="mt-3 overflow-x-auto rounded-lg border bg-card">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">{BY_NAME[by]}</th>
                {/* What the count is of, as the match line above says it. */}
                <th className="px-3 py-2 text-right font-medium">{q.kind === 'all' ? 'Changes of owner' : 'Sales'}</th>
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
                    <td className="px-3 py-2"><Cell href={to()}>{groupLabel(by, g.key)}</Cell></td>
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
  return href === null ? <>{children}</> : <Link href={href} prefetch={false} className="hover:underline">{children}</Link>;
}

// ---- trades -----------------------------------------------------------------

/** The sort a header starts with: names read A to Z, the rest biggest or newest first. */
const FIRST_ASC: readonly TradeSort[] = ['token', 'seller', 'marketplace'];

const COLUMNS: [TradeSort, string][] = [['date', 'Date'], ['token', 'Token'], ['seller', 'Seller → buyer'], ['price', 'Price'], ['marketplace', 'Marketplace'], ['held', 'Held'], ['buyerAge', 'Buyer age'], ['floor', `vs ${MEDIAN}`]];

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
      {tone ? <TierMark tone={lensInfo(tone, where.own ?? {})?.tone ?? 'apart'} /> : null}
      {label}
    </SortHead>
  );
}

/** What one lens says of one trade: past the block its run read, flagged, or judged and passed. */
function verdictOf(r: TradeRow, m: LensKey, through: TradeContext['through']): 'later' | 'flagged' | 'clear' {
  return !judgedBy(r, m, through) ? 'later' : r.lenses.includes(m) ? 'flagged' : 'clear';
}

/**
 * A cell with no link of its own that opens the trade: an empty link laid over
 * the whole cell, so a click anywhere in it, to the cell's full height, lands.
 * It is out of the tab order (the date is the link a keyboard reaches) and out
 * of the accessibility tree (one link a trade), while the cell's own text stays
 * readable. A `tr` can't be wrapped in a link, so each cell carries its own.
 */
function Open({ href, title, className, children, ...td }: { href: string; title?: string; className?: string; children: ReactNode } & React.TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td {...td} className={cn('relative px-3 py-2', className)}>
      {children}
      <Link href={href} tabIndex={-1} aria-hidden="true" prefetch={false} title={title} className="absolute inset-0" />
    </td>
  );
}

/**
 * One page of trades: a dot per lens that ran, and links from every name and
 * number to what it opens. `through` is, for each lens of yours, the block its
 * run read (lensContext): a trade past it reads not judged yet in that lens's
 * column, as a trade no analysis covered reads across them all. Below `sm` the
 * table is too wide for the screen, so each trade is a card there instead:
 * both draw the same cells and the breakpoint shows one, so it needs no script.
 * Its links do not prefetch: each one renders the collection's layout, counts
 * and all, and a page of them queues the click that matters behind them.
 */
export function TradesTable({ chainId, rows, ran, through, money, from, flags, ...where }: Where & {
  chainId: number; rows: readonly TradeRow[]; ran: readonly LensKey[]; through: TradeContext['through']; money: ReadonlySet<string>;
  /** Why each trade was flagged, by `txHash:logIndex` (Store.tradeFlags): the reason says in a short plain line beside it. */
  flags: ReadonlyMap<string, Partial<Record<Method, Witness>>>;
  /** The list as a trade's `from` (lib/step.ts), so a trade opened from it can step to its neighbours. */
  from?: string;
}) {
  const { base, q, view, own = {} } = where;
  const lenses = withOwn(ran);
  // A wallet or token opened from a list filtered by a lens is read under that lens: the first it names, floor first.
  const method = caughtLens(q.caught);
  const only = (extra: Partial<TradeQuery>, title: string) => (
    // Drawn on the row's hover or focus where there is a pointer to hover with, always where there is not (a phone's cards).
    <Link href={tradesHref(base, { ...q, ...extra }, { by: view.by })} prefetch={false} title={title} aria-label={title}
      className="ml-1 inline-flex align-middle text-muted-foreground hover:text-foreground focus-visible:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100">
      <FunnelIcon className="size-3.5" />
    </Link>
  );
  const wallet = (a: string) => (
    <span className="whitespace-nowrap"><Wallet chainId={chainId} address={a} within={base} ctx={{ method }} />{/^0x0+$/.test(a) ? null : only({ wallet: a }, 'Only trades with this wallet')}</span>
  );
  // Each trade's cells, made once: the table row and the card both draw these.
  const trades = rows.map((r) => {
    const priced = r.priceWei !== null && r.currency !== null && money.has(r.currency);
    const href = carry(txHref(chainId, r.txHash, base), { from });
    const verdicts = lenses.map((m) => {
      const v = verdictOf(r, m, through);
      const name = lensInfo(m, own)?.name;
      const mark = v === 'later'
        ? <span title={`Newer than the block ${name}'s run read through`} className="whitespace-nowrap text-xs text-muted-foreground">{NOT_JUDGED_YET}</span>
        : v === 'flagged'
          ? <span role="img" aria-label={`Flagged by ${name}`} className="inline-flex"><TierMark tone={lensInfo(m, own)?.tone ?? 'apart'} /></span>
          : <span aria-label="Not flagged" className="text-muted-foreground">–</span>;
      return { m, v, name, mark };
    });
    // The reason of the lens the list is read under, else the strongest that flagged it: a counted lens's before one never counted.
    const flagged = flags.get(`${r.txHash}:${r.logIndex}`);
    const witness = [...SHOWN.filter((m) => m === method), ...SHOWN].map((m) => flagged?.[m]).find((w) => w !== undefined);
    // A lens of yours has no witness here: its row says which flagged it, as the verdict column does.
    const names = (ms: readonly LensKey[]) => andList(ms.map((m) => lensInfo(m, own)?.name).filter((n) => n !== undefined));
    const also = names(witness === undefined ? r.lenses : r.lenses.filter(isOwnKey));
    const reason = witness === undefined ? null : because(witness, chainId, undefined, true);
    const why = also === '' ? reason : reason === null ? `Flagged by ${also}` : <>{reason}. Also flagged by {also}</>;
    const when = r.blockTime === null ? 'Unknown time' : <Time ms={r.blockTime * 1000} />;
    return {
      key: `${r.txHash}-${r.logIndex}`,
      href,
      judged: r.judged,
      verdicts,
      why,
      // The table's date is the keyboard link and fills its cell; a card's reaches over the whole card.
      date: <Link href={href} prefetch={false} className="block h-full px-3 py-2 hover:underline">{when}</Link>,
      cardDate: <Link href={href} prefetch={false} className="hover:underline after:absolute after:inset-0">{when}</Link>,
      token: <><TokenLink base={base} tokenId={r.tokenId} method={method} />{only({ token: r.tokenId }, 'Only trades with this token')}</>,
      parties: <>{wallet(r.from)} → {wallet(r.to)}</>,
      price: priced ? eth(r.priceWei) : '—',
      market: r.marketplace === null ? '—' : venueName(r.marketplace),
      held: span(r.heldS),
      buyerAge: span(r.buyerAgeS),
      floor: r.floorRatio === null ? '—' : `${r.floorRatio.toFixed(2)}×`,
    };
  });
  return (
    <>
      <ul aria-label="Trades" className="mt-4 divide-y rounded-lg border bg-card text-sm sm:hidden">
        {trades.map((t) => {
          // Only the lenses with something to say: a card has no column to hold a dash.
          const said = t.verdicts.filter((x) => x.v !== 'clear');
          return (
            // The whole card opens the trade (the date's link reaches over it); the token, wallets and filters stay above it, with their own.
            <li key={t.key} className="group relative space-y-1 px-3 py-2">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="relative z-10 whitespace-nowrap font-mono">{t.token}</span>
                <span className="text-xs text-muted-foreground">{t.cardDate}</span>
              </div>
              {lenses.length === 0 ? null : (
                <div className="flex flex-wrap gap-1.5 text-xs text-muted-foreground">
                  {!t.judged ? NOT_JUDGED_YET : said.length === 0 ? 'Not flagged' : said.map((x) => (
                    // A flagged mark names its lens to a screen reader already, so there the name beside it is for the eye.
                    <span key={x.m} className="chip">{x.mark}<span aria-hidden={x.v === 'flagged' ? true : undefined}>{x.name}</span></span>
                  ))}
                </div>
              )}
              <div className="relative z-10 w-fit">{t.parties}</div>
              <div className="flex flex-wrap gap-x-3 tabular-nums">
                <span data-opens>{t.price}</span>
                <span className="text-muted-foreground">{t.market}</span>
              </div>
              <p data-measure className="text-xs text-muted-foreground tabular-nums">Held {t.held} · buyer age {t.buyerAge} · {t.floor} vs {MEDIAN}</p>
              {t.why === null ? null : <p data-why className="text-xs text-muted-foreground">{t.why}</p>}
            </li>
          );
        })}
      </ul>
      <div className="mt-4 hidden overflow-x-auto rounded-lg border bg-card sm:block">
        <table className="w-full text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr>
              {COLUMNS.map(([sort, label]) => <Th key={sort} sort={sort} label={label} where={where} />)}
              {lenses.map((m) => <Th key={m} sort={`lens-${m}`} label={lensTitle(m, own)} where={where} tone={m} />)}
              {lenses.length > 0 ? <th scope="col" className="px-3 py-2 text-left font-medium">Why</th> : null}
            </tr>
          </thead>
          <tbody className="divide-y">
            {trades.map((t) => (
              <tr key={t.key} className="group hover:bg-muted/40 focus-within:bg-muted/40">
                {/* h-px: a cell's height counts as set, so the link's h-full fills a row grown tall by another cell. */}
                <td className="h-px whitespace-nowrap p-0">{t.date}</td>
                <td className="whitespace-nowrap px-3 py-2 font-mono">{t.token}</td>
                <td className="px-3 py-2">{t.parties}</td>
                <Open href={t.href} title="Open this trade" data-opens className="whitespace-nowrap tabular-nums">{t.price}</Open>
                <Open href={t.href} className="whitespace-nowrap">{t.market}</Open>
                {/* The trade's own measures count no list; like every cell with no link of its own, they open the trade. */}
                <Open href={t.href} data-measure className="whitespace-nowrap tabular-nums">{t.held}</Open>
                <Open href={t.href} data-measure className="whitespace-nowrap tabular-nums">{t.buyerAge}</Open>
                <Open href={t.href} data-measure className="whitespace-nowrap tabular-nums">{t.floor}</Open>
                {t.judged
                  ? t.verdicts.map((x) => <Open key={x.m} href={t.href}>{x.mark}</Open>)
                  // With no lens run there is no lens column to say it in.
                  : lenses.length > 0 ? <Open href={t.href} colSpan={lenses.length} className="text-muted-foreground">{NOT_JUDGED_YET}</Open> : null}
                {lenses.length > 0 ? <Open href={t.href} data-why className="min-w-56 text-xs text-muted-foreground">{t.why ?? '—'}</Open> : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
