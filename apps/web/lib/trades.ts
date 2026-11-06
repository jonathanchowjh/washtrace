/**
 * A Trades list's filters and grouping, written to and read from the URL, so
 * every figure that opens a list is a link and a list can be shared. Client-
 * safe: it takes detect only through the trades subpath, and the lens names
 * from format.ts.
 *
 * An invalid value is dropped, never an error: a hand-edited or stale link
 * still opens a list.
 */

import type { Method } from '@washtrace/detect';
import { AGE_BANDS, FLOOR_BANDS, HELD_BANDS, NO_FILTER, VENUES, type GroupRef, type TradeGroupBy, type TradeQuery, type TradeSort } from '@washtrace/detect/trades';
import { LENSES, localTime, short } from './format';
import { dateIn, midnight } from './zone';

export type Params = Record<string, string | string[] | undefined>;
export interface View { by: TradeGroupBy | null; page: number }

const BYS: readonly TradeGroupBy[] = ['marketplace', 'month', 'held', 'floor', 'buyerAge'];
const SORTS: readonly string[] = ['date', 'price', 'held', 'buyerAge', 'floor', 'token', 'marketplace', 'seller', ...Object.keys(LENSES).map((m) => `lens-${m}`)];
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const DAY = 86_400;

const isMethod = (m: string): m is Method => Object.hasOwn(LENSES, m);

// ---- values -----------------------------------------------------------------

/** ETH as a decimal to wei, exactly, by splitting the string; null for anything else (no sign, no exponent, at most 18 decimals). */
export function ethToWei(s: string): string | null {
  const m = /^(\d*)(?:\.(\d{0,18}))?$/.exec(s.trim());
  if (!m || (m[1] === '' && !m[2])) return null;
  return BigInt((m[1] || '0') + (m[2] ?? '').padEnd(18, '0')).toString();
}

export function weiToEth(wei: string): string {
  const s = wei.padStart(19, '0');
  const frac = s.slice(-18).replace(/0+$/, '');
  return `${s.slice(0, -18)}${frac ? `.${frac}` : ''}`;
}

/** "90m", "1h", "30d": the coarsest unit that divides the seconds exactly. */
export function duration(s: number): string {
  if (s % DAY === 0) return `${s / DAY}d`;
  if (s % 3_600 === 0) return `${s / 3_600}h`;
  return `${Math.floor(s / 60)}m`;
}

function parseDuration(v: string | undefined): number | null {
  const m = /^(\d{1,6})([mhd])$/.exec(v ?? '');
  return m ? Number(m[1]) * { m: 60, h: 3_600, d: DAY }[m[2] as 'm' | 'h' | 'd'] : null;
}

/** An instant as a bare date when it is UTC midnight, else as `2023-03-01T05:00Z`. */
function instant(ms: number): string {
  const iso = new Date(ms).toISOString();
  if (iso.endsWith('T00:00:00.000Z')) return iso.slice(0, 10);
  return iso.endsWith(':00.000Z') ? `${iso.slice(0, 16)}Z` : iso;
}

function parseInstant(v: string | undefined): number | null {
  const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2})(?::(\d{2})(?:\.\d{1,3})?)?Z)?$/.exec(v ?? '');
  if (!m) return null;
  const ms = Date.parse(m[2] === undefined ? `${v}T00:00:00Z` : v!);
  if (Number.isNaN(ms)) return null;
  // Date.parse rolls 30 February to 2 March and 24:00 to the next day; an impossible date is dropped, so the date and time must read back as written.
  const back = new Date(ms).toISOString();
  return back.startsWith(m[1]!) && (m[2] === undefined || back.slice(11, 16) === m[2]) && (m[3] === undefined || back.slice(17, 19) === m[3]) ? ms : null;
}

function parseRatio(v: string | undefined): number | null {
  return v !== undefined && /^\d{1,6}(\.\d{1,6})?$/.test(v) ? Number(v) : null;
}

function parseGroup(v: string | undefined): GroupRef | null {
  const m = /^(\w+)\.([tw])\.(\w+)$/.exec(v ?? '');
  if (!m || !isMethod(m[1]!)) return null;
  const method = m[1];
  if (m[2] === 't') return /^\d{1,78}$/.test(m[3]!) ? { method, token: BigInt(m[3]!).toString() } : null;
  return ADDRESS.test(m[3]!) ? { method, wallet: m[3]!.toLowerCase() } : null;
}

function parseMethods(v: string | undefined): Method[] {
  return [...new Set((v ?? '').split(',').filter(isMethod))];
}

// ---- URL --------------------------------------------------------------------

/** A parameter's value; a repeated parameter is its values joined by commas. */
function param(p: Params, k: string): string | undefined {
  const v = p[k];
  return Array.isArray(v) ? v.join(',') : v;
}

/** The form's number-and-unit pair (`heldunder_n`, `heldunder_u`) as one duration; an empty number is not set. */
function pairDuration(p: Params, k: string): number | null {
  const n = (param(p, `${k}_n`) ?? '').trim();
  return n === '' ? null : parseDuration(`${n}${param(p, `${k}_u`) ?? ''}`);
}

/** The form's day (`from_day`) as the instant that day starts in the reader's zone; an impossible date is dropped. */
function dayStart(p: Params, k: string, zone: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(param(p, `${k}_day`) ?? '');
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const ms = midnight(y, mo, d, zone);
  // midnight() overflows 30 February into March; the date must read back as written.
  const back = dateIn(ms, zone);
  return back.y === y && back.m === mo && back.d === d ? ms : null;
}

/**
 * `zone` reads the form's plain `from_day`/`to_day` fields, which tradesHref
 * never writes: a combined parameter (`from`) wins when both are present, so
 * parseView then tradesHref turns a form submit into its one canonical URL.
 */
export function parseView(p: Params, zone = 'UTC'): { q: TradeQuery; view: View } {
  const s = (k: string) => param(p, k);
  const dur = (k: string) => parseDuration(s(k)) ?? (s(k) === undefined ? pairDuration(p, k) : null);
  const day = (k: string) => parseInstant(s(k)) ?? (s(k) === undefined ? dayStart(p, k, zone) : null);
  const sort = s('sort');
  const by = s('by');
  const page = Number(s('page'));
  const q: TradeQuery = {
    ...NO_FILTER,
    kind: s('all') === '1' ? 'all' : 'sales',
    caught: parseMethods(s('caught')), notCaught: parseMethods(s('not')),
    venues: [...new Set((s('market') ?? '').split(',').filter((v) => Object.hasOwn(VENUES, v)))],
    priceMinWei: ethToWei(s('pmin') ?? 'x'), priceMaxWei: ethToWei(s('pmax') ?? 'x'),
    heldOverS: dur('heldover'), heldUnderS: dur('heldunder'),
    buyerAgeOverS: dur('ageover'), buyerAgeUnderS: dur('ageunder'),
    floorMin: parseRatio(s('fmin')), floorMax: parseRatio(s('fmax')),
    fromMs: day('from'), toMs: day('to'),
    wallet: ADDRESS.test(s('wallet') ?? '') ? s('wallet')!.toLowerCase() : null,
    token: /^\d{1,78}$/.test(s('token') ?? '') ? BigInt(s('token')!).toString() : null,
    group: parseGroup(s('group')),
    find: s('q')?.trim().slice(0, 100) || null,
    sort: sort !== undefined && SORTS.includes(sort) ? (sort as TradeSort) : NO_FILTER.sort,
    dir: s('dir') === 'asc' ? 'asc' : 'desc',
  };
  return { q, view: { by: BYS.find((b) => b === by) ?? null, page: Number.isSafeInteger(page) && page >= 1 ? page : 1 } };
}

/** The listed values that are in `have`, in the list's order and comma-joined (null when none), so one set of filters has one URL whatever order it was typed in. */
const inOrder = (order: string[], have: readonly string[]) => order.filter((x) => have.includes(x)).join(',') || null;

const enc = (v: string) => encodeURIComponent(v).replace(/%2C/g, ',').replace(/%3A/g, ':');

/** `${base}/flagged?kind=trades…` with only the non-default parameters, in one fixed order so a list has one URL. */
export function tradesHref(base: string, q: Partial<TradeQuery>, view: Partial<View> = {}): string {
  const f = { ...NO_FILTER, ...q };
  const g = f.group;
  const pairs: [string, string | null][] = [
    ['caught', inOrder(Object.keys(LENSES), f.caught)], ['not', inOrder(Object.keys(LENSES), f.notCaught)],
    ['market', inOrder(Object.keys(VENUES), f.venues)],
    ['pmin', f.priceMinWei === null ? null : weiToEth(f.priceMinWei)], ['pmax', f.priceMaxWei === null ? null : weiToEth(f.priceMaxWei)],
    ['heldover', f.heldOverS === null ? null : duration(f.heldOverS)], ['heldunder', f.heldUnderS === null ? null : duration(f.heldUnderS)],
    ['ageover', f.buyerAgeOverS === null ? null : duration(f.buyerAgeOverS)], ['ageunder', f.buyerAgeUnderS === null ? null : duration(f.buyerAgeUnderS)],
    ['fmin', f.floorMin === null ? null : String(f.floorMin)], ['fmax', f.floorMax === null ? null : String(f.floorMax)],
    ['from', f.fromMs === null ? null : instant(f.fromMs)], ['to', f.toMs === null ? null : instant(f.toMs)],
    ['wallet', f.wallet], ['token', f.token],
    ['group', g === null ? null : `${g.method}.${'token' in g ? `t.${g.token}` : `w.${g.wallet}`}`],
    ['q', f.find], ['all', f.kind === 'all' ? '1' : null],
    ['sort', f.sort === NO_FILTER.sort ? null : f.sort], ['dir', f.dir === NO_FILTER.dir ? null : f.dir],
    ['by', view.by ?? null], ['page', view.page !== undefined && view.page > 1 ? String(view.page) : null],
  ];
  const rest = pairs.filter(([, v]) => v !== null).map(([k, v]) => `&${k}=${enc(v!)}`).join('');
  return `${base}/flagged?kind=trades${rest}`;
}

// ---- chips ------------------------------------------------------------------

/** "1 h", "1 d": the unit spaced, as a chip reads it. */
function spoken(s: number): string {
  const d = duration(s);
  return `${d.slice(0, -1)} ${d.slice(-1)}`;
}

/** "0.9–1.1", "over 2", "under 0.5"; null with neither end. */
function span(lo: string | null, hi: string | null, over = 'over', under = 'under'): string | null {
  if (lo !== null && hi !== null) return `${lo}–${hi}`;
  if (lo !== null) return `${over} ${lo}`;
  return hi === null ? null : `${under} ${hi}`;
}

/**
 * One chip per filter in play, in URL order, each linking to the same list
 * without it. Dropping a filter drops the page (it may no longer exist) and
 * keeps the grouping. `names` is each lens's name; custom lenses pass theirs.
 * A date range shows its end as given: `to` is exclusive, so a month reads
 * "1 Mar 2023 → 1 Apr 2023".
 */
export function chips(base: string, q: TradeQuery, view: View, zone: string, names: Partial<Record<Method, string>> = {}): { key: string; label: string; href: string }[] {
  const name = (m: Method) => names[m] ?? LENSES[m].name;
  // A bound that is not midnight in the reader's zone shows its time, so two ranges that differ by hours do not read alike.
  const day = (ms: number) => {
    const d = dateIn(ms, zone);
    const date = localTime(ms, 'date', zone, 'en-GB');
    return midnight(d.y, d.m, d.d, zone) === ms ? date : `${date} ${localTime(ms, 'time', zone, 'en-GB')}`;
  };
  const list = (ms: Method[]) => ms.map(name).join(' and ');
  const g = q.group;
  const price = span(q.priceMinWei === null ? null : weiToEth(q.priceMinWei), q.priceMaxWei === null ? null : weiToEth(q.priceMaxWei), 'at least', 'at most');
  const held = side('held', q.heldOverS, q.heldUnderS);
  const age = side('buyerAge', q.buyerAgeOverS, q.buyerAgeUnderS);
  const floor = side('floor', q.floorMin, q.floorMax, 'at least', 'under');
  const when = q.fromMs !== null && q.toMs !== null ? `${day(q.fromMs)} → ${day(q.toMs)}` : q.fromMs !== null ? `From ${day(q.fromMs)}` : q.toMs !== null ? `Before ${day(q.toMs)}` : null;

  const all: [string, string | null, Partial<TradeQuery>][] = [
    ['caught', q.caught.length ? `Caught by ${list(q.caught)}` : null, { caught: [] }],
    ['not', q.notCaught.length ? `Not caught by ${list(q.notCaught)}` : null, { notCaught: [] }],
    ['market', q.venues.length ? `Marketplace: ${q.venues.map((v) => VENUES[v]?.name ?? v).join(', ')}` : null, { venues: [] }],
    ['price', price && `Price ${price} ETH`, { priceMinWei: null, priceMaxWei: null }],
    ['held', held && `Held ${held}`, { heldOverS: null, heldUnderS: null }],
    ['age', age && `Bought by a wallet ${age} old`, { buyerAgeOverS: null, buyerAgeUnderS: null }],
    ['floor', floor && `Price vs floor ${floor}`, { floorMin: null, floorMax: null }],
    ['when', when, { fromMs: null, toMs: null }],
    ['wallet', q.wallet && `Wallet ${short(q.wallet)}`, { wallet: null }],
    ['token', q.token && `Token #${q.token}`, { token: null }],
    ['group', g && ('token' in g ? `Wallets in #${g.token}'s ${name(g.method)} loops` : `Wallets in ${name(g.method)} loops with ${short(g.wallet)}`), { group: null }],
    ['q', q.find && `Matching “${q.find}”`, { find: null }],
    ['all', q.kind === 'all' ? 'Every change of owner' : null, { kind: 'sales' }],
  ];
  return all.flatMap(([key, label, without]) => (label ? [{ key, label, href: tradesHref(base, { ...q, ...without }, { by: view.by }) }] : []));
}

// ---- groups -----------------------------------------------------------------

const EDGES = { held: HELD_BANDS, floor: FLOOR_BANDS, buyerAge: AGE_BANDS } as const;
const BOUNDS = { held: ['heldOverS', 'heldUnderS'], floor: ['floorMin', 'floorMax'], buyerAge: ['buyerAgeOverS', 'buyerAgeUnderS'] } as const;

/** A band index within the edges, or null. */
function bandIndex(edges: readonly number[], key: string): number | null {
  const k = Number(key);
  // Only the canonical spelling: '01' and '1e0' are not band keys.
  return String(k) === key && k >= 0 && k <= edges.length ? k : null;
}

/** The filter a Group by row stands for, so clicking it lists exactly its trades; null for the unknown group ('-'). */
export function groupFilter(by: TradeGroupBy, key: string, zone: string): Partial<TradeQuery> | null {
  if (by === 'marketplace') return Object.hasOwn(VENUES, key) ? { venues: [key] } : null;
  if (by === 'month') {
    const m = /^(\d{4})-(\d{2})$/.exec(key);
    if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]) - 1;
    return { fromMs: midnight(y, mo, 1, zone), toMs: midnight(y, mo + 1, 1, zone) };
  }
  const edges = EDGES[by];
  const k = bandIndex(edges, key);
  if (k === null) return null;
  const [over, under] = BOUNDS[by];
  // Band k is [edges[k-1], edges[k]): no lower bound for the first, no upper for the last.
  return { ...(k > 0 ? { [over]: edges[k - 1] } : {}), ...(k < edges.length ? { [under]: edges[k] } : {}) };
}

/** "<1 h", "1 h–1 d", "1–30 d", ">30 d"; floor bands in ×. A key that names no band reads "Unknown". */
export function bandLabel(by: 'held' | 'floor' | 'buyerAge', key: string): string {
  const edges = EDGES[by];
  const k = bandIndex(edges, key);
  if (k === null) return 'Unknown';
  const unit = by === 'floor' ? '×' : '';
  if (k === 0) return `<${say(by, edges[0]!)}${unit}`;
  if (k === edges.length) return `>${say(by, edges[k - 1]!)}${unit}`;
  return pair(by, edges[k - 1]!, edges[k]!);
}

type BandBy = 'held' | 'floor' | 'buyerAge';

const say = (by: BandBy, e: number) => (by === 'floor' ? String(e) : spoken(e));

/** A band's two ends as one range: "1–30 d" when they share a unit, "1 h–1 d" when not, "0.9–1.1×" for the floor. The one copy of this, for group rows and chips. */
function pair(by: BandBy, lo: number, hi: number): string {
  if (by === 'floor') return `${lo}–${hi}×`;
  const [loN, loU] = say(by, lo).split(' ');
  const [, hiU] = say(by, hi).split(' ');
  return loU === hiU ? `${loN}–${say(by, hi)}` : `${say(by, lo)}–${say(by, hi)}`;
}

/** A filter's bounds as a chip says them: the band form with both ends, "over 2×" or "under 1 h" with one, null with none. */
function side(by: BandBy, lo: number | null, hi: number | null, over = 'over', under = 'under'): string | null {
  if (lo !== null && hi !== null) return pair(by, lo, hi);
  const one = span(lo === null ? null : say(by, lo), hi === null ? null : say(by, hi), over, under);
  return one !== null && by === 'floor' ? `${one}×` : one;
}
