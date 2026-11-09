import { describe, expect, it } from 'vitest';
import { NO_FILTER, type TradeQuery } from '@washtrace/detect/trades';
import { ethToWei } from '../lib/format';
import { bandLabel, chips, groupFilter, parseView, tradesHref } from '../lib/trades-url';

/** Your lenses that exist, as the page reads them from the store: L7, L9 and L12 here, so a link can carry them. */
const OWN: ReadonlySet<string> = new Set(['L7', 'L9', 'L12']);
const roundTrip = (href: string) => parseView(Object.fromEntries(new URL(href, 'http://x').searchParams), 'UTC', OWN);

describe('Trades in the URL', () => {
  it('round-trips every filter and the view through the URL', () => {
    const q = { ...NO_FILTER, caught: ['A'], notCaught: ['AU'], venues: ['blur'], priceMinWei: '300000000000000000', heldUnderS: 3600, fromMs: Date.UTC(2023, 0, 1), group: { method: 'A', token: '1234' }, sort: 'price', dir: 'asc' } as TradeQuery;
    const href = tradesHref('/c/1/0xabc', q, { by: 'marketplace', page: 3 });
    expect(href).toBe('/c/1/0xabc/flagged?kind=trades&caught=A&not=AU&market=blur&pmin=0.3&heldunder=1h&from=2023-01-01&group=A.t.1234&sort=price&dir=asc&by=marketplace&page=3');
    expect(roundTrip(href)).toEqual({ q, view: { by: 'marketplace', page: 3 } });
  });

  it('round-trips every remaining filter', () => {
    const wallet = `0x${'3a'.repeat(20)}`;
    const q: TradeQuery = {
      ...NO_FILTER, kind: 'all', caught: ['A', 'AC'], venues: ['opensea', 'blur'], priceMinWei: '500000000000000000', priceMaxWei: '2000000000000000000',
      heldOverS: 60, heldUnderS: 86_400, buyerAgeOverS: 7200, buyerAgeUnderS: 30 * 86_400, floorMin: 0.9, floorMax: 1.1,
      fromMs: Date.parse('2023-03-01T05:00:00Z'), toMs: Date.parse('2023-04-01T04:00:00Z'),
      wallet, token: '14022', group: { method: 'AC', wallet }, find: '0x3a1f', sort: 'lens-AC', dir: 'asc',
    };
    expect(roundTrip(tradesHref('/b', q))).toEqual({ q, view: { by: null, page: 1 } });
  });

  it('a month group in a non-UTC zone round-trips as instants', () => {
    const f = groupFilter('month', '2023-03', 'America/New_York')!;
    expect(f).toEqual({ fromMs: Date.parse('2023-03-01T05:00:00Z'), toMs: Date.parse('2023-04-01T04:00:00Z') });
    expect(roundTrip(tradesHref('/c/1/0xabc', f)).q).toMatchObject(f);
    expect(tradesHref('/c', f)).toContain('from=2023-03-01T05:00Z&to=2023-04-01T04:00Z');
  });

  it('drops what it cannot read', () => {
    expect(parseView({ caught: 'A,ZZ', pmin: 'abc', heldunder: '-3h', group: 'A.q.1', page: '-2', sort: 'nope', by: 'x' }, 'UTC', OWN)).toEqual({ q: { ...NO_FILTER, caught: ['A'] }, view: { by: null, page: 1 } });
    expect(parseView({ caught: 'constructor,toString', market: 'nowhere', from: 'yesterday', token: 'abc', wallet: '0x12', dir: 'up', page: 'many' }, 'UTC', OWN))
      .toEqual({ q: NO_FILTER, view: { by: null, page: 1 } });
  });

  it('names lenses in chips, never codes, and a chip keeps the grouping but not the page', () => {
    const c = chips('/c/1/0xabc', { ...NO_FILTER, caught: ['AC'], notCaught: ['AU'] }, { by: 'month', page: 4 }, 'UTC');
    expect(c.map((x) => x.label)).toEqual(['Flagged by Linked wallets', 'Not flagged by Money loops back']);
    expect(c[0]!.href).toBe('/c/1/0xabc/flagged?kind=trades&not=AU&by=month');
  });

  it('custom lens names replace the built-in ones', () => {
    const c = chips('/c', { ...NO_FILTER, caught: ['A'] }, { by: null, page: 1 }, 'UTC', { A: 'Fast flips' });
    expect(c[0]!.label).toBe('Flagged by Fast flips');
  });

  it('words every chip', () => {
    const wallet = `0x3a1f${'0'.repeat(32)}abcd`;
    const q: TradeQuery = {
      ...NO_FILTER, kind: 'all', venues: ['opensea', 'blur'], priceMinWei: '500000000000000000', priceMaxWei: '2000000000000000000',
      heldUnderS: 3600, buyerAgeUnderS: 86_400, floorMin: 0.9, floorMax: 1.1,
      fromMs: Date.parse('2023-03-01T00:00:00Z'), toMs: Date.parse('2023-04-01T00:00:00Z'),
      wallet, token: '14022', group: { method: 'A', token: '1234' }, find: '0x3a1f',
    };
    expect(chips('/c', q, { by: null, page: 1 }, 'UTC').map((x) => x.label)).toEqual([
      'Marketplace: OpenSea, Blur', 'Price 0.5–2 ETH', 'Held under 1 h', 'Bought by a wallet under 1 d old', 'Price vs floor 0.9–1.1×',
      '1 Mar 2023 → 1 Apr 2023', 'Wallet 0x3a1f…abcd', 'Token #14022', 'Wallets in #1234\'s Round trips loops', 'Matching “0x3a1f”', 'Every change of owner',
    ]);
    const w = { ...NO_FILTER, group: { method: 'AC', wallet } } as TradeQuery;
    expect(chips('/c', w, { by: null, page: 1 }, 'UTC')[0]!.label).toBe('Wallets in Linked wallets loops with 0x3a1f…abcd');
  });

  it('a held band adds its bounds, and the unknown group adds nothing', () => {
    expect(groupFilter('held', '1', 'UTC')).toEqual({ heldOverS: 3600, heldUnderS: 86_400 });
    expect(groupFilter('held', '0', 'UTC')).toEqual({ heldUnderS: 3600 });
    expect(groupFilter('held', '3', 'UTC')).toEqual({ heldOverS: 30 * 86_400 });
    expect(groupFilter('floor', '2', 'UTC')).toEqual({ floorMin: 0.9, floorMax: 1.1 });
    expect(groupFilter('buyerAge', '1', 'UTC')).toEqual({ buyerAgeOverS: 86_400, buyerAgeUnderS: 30 * 86_400 });
    expect(groupFilter('marketplace', 'blur', 'UTC')).toEqual({ venues: ['blur'] });
    expect(groupFilter('held', '-', 'UTC')).toBeNull();
    expect(groupFilter('month', '-', 'UTC')).toBeNull();
    expect(groupFilter('held', '9', 'UTC')).toBeNull();
  });

  it('labels a band with the units of the chips', () => {
    expect([0, 1, 2, 3].map((k) => bandLabel('held', String(k)))).toEqual(['<1 h', '1 h–1 d', '1–30 d', '>30 d']);
    expect([0, 1, 2].map((k) => bandLabel('buyerAge', String(k)))).toEqual(['<1 d', '1–30 d', '>30 d']);
    expect([0, 1, 2, 3, 4].map((k) => bandLabel('floor', String(k)))).toEqual(['<0.5×', '0.5–0.9×', '0.9–1.1×', '1.1–2×', '>2×']);
  });

  it('drops an impossible date or month instead of rolling it over', () => {
    for (const p of [{ from: '2023-02-30' }, { to: '2023-04-31' }, { from: '2023-03-01T24:00Z' }, { from: '2023-03-01T10:61Z' }]) expect(parseView(p, 'UTC', OWN).q).toEqual(NO_FILTER);
    expect(parseView({ from: '2024-02-29', to: '2023-03-01T23:59Z' }, 'UTC', OWN).q).toMatchObject({ fromMs: Date.UTC(2024, 1, 29), toMs: Date.parse('2023-03-01T23:59Z') });
    expect(groupFilter('month', '2023-13', 'UTC')).toBeNull();
    expect(groupFilter('month', '2023-00', 'UTC')).toBeNull();
    expect(groupFilter('held', '01', 'UTC')).toBeNull();
    expect(groupFilter('held', '1e0', 'UTC')).toBeNull();
    expect(bandLabel('held', '01')).toBe('Unknown');
  });

  it('one list has one URL, and a chip reads a band as its group row does', () => {
    const a = tradesHref('/c', { caught: ['AC', 'A'], venues: ['blur', 'opensea'] });
    expect(a).toBe(tradesHref('/c', { caught: ['A', 'AC'], venues: ['opensea', 'blur'] }));
    expect(a).toContain('caught=A,AC&market=opensea,blur');
    expect(parseView({ caught: ['AC', 'A'] }, 'UTC', OWN).q.caught).toEqual(['AC', 'A']);
    const q: TradeQuery = { ...NO_FILTER, heldOverS: 86_400, heldUnderS: 30 * 86_400, buyerAgeOverS: 3600, buyerAgeUnderS: 86_400, floorMin: 0.9, floorMax: 1.1 };
    expect(chips('/c', q, { by: null, page: 1 }, 'UTC').map((x) => x.label)).toEqual(['Held 1–30 d', 'Bought by a wallet 1 h–1 d old', 'Price vs floor 0.9–1.1×']);
    expect(chips('/c', { ...NO_FILTER, floorMin: 2, heldOverS: 3600 }, { by: null, page: 1 }, 'UTC').map((x) => x.label)).toEqual(['Held over 1 h', 'Price vs floor at least 2×']);
  });

  it('a date bound that is not midnight in the zone shows its time', () => {
    const q = { ...NO_FILTER, fromMs: Date.parse('2023-03-01T05:00Z'), toMs: Date.parse('2023-04-01T04:00Z') };
    expect(chips('/c', q, { by: null, page: 1 }, 'America/New_York')[0]!.label).toBe('1 Mar 2023 → 1 Apr 2023');
    expect(chips('/c', q, { by: null, page: 1 }, 'UTC')[0]!.label).toBe('1 Mar 2023 05:00 → 1 Apr 2023 04:00');
  });

  it('parses ETH exactly', () => {
    expect(ethToWei('.5')).toBe('500000000000000000');
    expect(ethToWei('1.')).toBe('1000000000000000000');
    expect(ethToWei('0.')).toBe('0');
    expect(ethToWei('007.5')).toBe('7500000000000000000');
    expect(ethToWei('.')).toBeNull();
    expect(ethToWei('')).toBeNull();
    expect(ethToWei('0.1234567890123456789')).toBeNull();
    expect(ethToWei('0.3')).toBe('300000000000000000');
    expect(ethToWei('1e3')).toBeNull();
    expect(ethToWei('12')).toBe('12000000000000000000');
    expect(ethToWei('0.0000000000000000001')).toBeNull();
    expect(ethToWei('-1')).toBeNull();
  });

  it('reads the form\'s plain number, unit and day fields when the combined parameter is absent', () => {
    const q = parseView({ heldunder_n: '90', heldunder_u: 'm', ageover_n: '2', ageover_u: 'd', from_day: '2023-03-01', to_day: '2023-04-01' }, 'America/New_York', OWN).q;
    expect(q).toMatchObject({ heldUnderS: 5400, buyerAgeOverS: 172_800, fromMs: Date.parse('2023-03-01T05:00:00Z'), toMs: Date.parse('2023-04-01T04:00:00Z') });
    expect(parseView({ from_day: '2023-03-01' }, 'UTC', OWN).q.fromMs).toBe(Date.UTC(2023, 2, 1));
  });

  it('lets the combined parameter win, ignores an empty number, and drops junk', () => {
    expect(parseView({ heldunder: '1h', heldunder_n: '5', heldunder_u: 'd', from: '2023-01-01', from_day: '2023-03-01' }, 'UTC', OWN).q).toMatchObject({ heldUnderS: 3600, fromMs: Date.UTC(2023, 0, 1) });
    expect(parseView({ heldover_n: '', heldover_u: 'h', ageunder_n: 'x', ageunder_u: 'h', heldunder_n: '3', heldunder_u: 'y', from_day: '2023-02-30', to_day: 'soon' }, 'UTC', OWN).q).toEqual(NO_FILTER);
  });
});

describe('your lenses in the URL', () => {
  it('round-trips L keys in caught, not, group and sort, built-ins first and yours by id', () => {
    const href = '/c/1/0xabc/flagged?kind=trades&caught=A,L7&not=L9&group=L7.t.5&sort=lens-L7';
    const { q, view } = roundTrip(href);
    expect(q).toMatchObject({ caught: ['A', 'L7'], notCaught: ['L9'], group: { method: 'L7', token: '5' }, sort: 'lens-L7' });
    expect(tradesHref('/c/1/0xabc', q, view)).toBe(href);
    expect(tradesHref('/c', { ...NO_FILTER, caught: ['L12', 'L7', 'AC', 'A'] })).toContain('caught=A,AC,L7,L12');
  });

  it('drops L0, L01, Lx and a key past int4, and a deleted lens: the lenses that exist are always given', () => {
    expect(parseView({ caught: 'L0,L01,Lx,L2147483648,L2147483647' }, 'UTC', new Set(['L2147483647'])).q.caught).toEqual(['L2147483647']);
    expect(parseView({ group: 'L0.t.5', sort: 'lens-Lx' }, 'UTC', OWN).q).toMatchObject({ group: null, sort: 'date' });
    const own = new Set(['L7']);
    expect(parseView({ caught: 'A,L7,L99', not: 'L99', group: 'L99.t.5', sort: 'lens-L99' }, 'UTC', own).q).toMatchObject({ caught: ['A', 'L7'], notCaught: [], group: null, sort: 'date' });
    // `own` is required, so no caller can forget to drop a deleted lens's key.
    // @ts-expect-error parseView has no default for the lenses that exist
    const forgot = () => parseView({ caught: 'L99' }, 'UTC');
    expect(forgot).toBeTypeOf('function');
  });

  it('names a lens of yours in a chip, and drops a key it has no name for', () => {
    const q = { ...NO_FILTER, caught: ['L7', 'L99'], group: { method: 'L99', token: '5' } } as TradeQuery;
    const c = chips('/c', q, { by: null, page: 1 }, 'UTC', { L7: 'Blur 3-hop' });
    expect(c.map((x) => x.label)).toEqual(['Flagged by Blur 3-hop']);
  });
});
