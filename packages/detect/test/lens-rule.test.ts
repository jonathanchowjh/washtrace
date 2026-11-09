import { describe, expect, it } from 'vitest';
import { COPIES, DEFAULT_RULE, EDGE_TYPES, INT4_MAX, NAME_MAX, checkRule, estimateTo, nameError, ruleLine, type FollowEstimate, type LensRule } from '../src/lens-rule.js';

const clone = (): LensRule => structuredClone(DEFAULT_RULE);
const errorOf = (raw: unknown) => {
  const r = checkRule(raw);
  if ('rule' in r) throw new Error('expected an error');
  return r.error;
};

describe('EDGE_TYPES', () => {
  it('lists the seven kinds in order with their labels', () => {
    expect(EDGE_TYPES.map((e) => [e.kind, e.label])).toEqual([
      ['nft-token', 'NFT: same token'],
      ['nft-collection', 'NFT: other tokens in this collection'],
      ['nft-watched', 'NFT: other watched collections'],
      ['eth', 'ETH payment'],
      ['internal', 'ETH sent by a contract (internal)'],
      ['weth', 'WETH (Blur Pool included)'],
      ['other-tokens', 'Other tokens'],
    ]);
  });

  it('marks money rows and the one unavailable row: other tokens are read now', () => {
    expect(EDGE_TYPES.filter((e) => e.money).map((e) => e.kind)).toEqual(['eth', 'internal', 'weth', 'other-tokens']);
    expect(EDGE_TYPES.filter((e) => e.unavailable).map((e) => [e.kind, e.unavailable])).toEqual([
      ['nft-watched', "Not in this version: a lens reads this collection's transfers."],
    ]);
  });
});

describe('DEFAULT_RULE', () => {
  it('carries the mockup values', () => {
    const wei = '10000000000000000';
    const e = DEFAULT_RULE.edges;
    expect(e['nft-token']).toEqual({ use: true, direction: 'along', max: null, minWei: null, repeats: 'each' });
    expect(e['nft-collection']).toEqual({ use: true, direction: 'along', max: 2, minWei: null, repeats: 'once' });
    expect(e.eth).toEqual({ use: true, direction: 'either', max: 2, minWei: wei, repeats: 'each' });
    expect(e.internal).toEqual({ use: true, direction: 'either', max: 1, minWei: wei, repeats: 'each' });
    expect(e.weth).toEqual({ use: true, direction: 'along', max: 2, minWei: wei, repeats: 'each' });
    expect(e['nft-watched'].use).toBe(false);
    expect(e['other-tokens'].use).toBe(false);
    expect(DEFAULT_RULE.hops).toEqual({ min: 1, max: 3 });
    expect(DEFAULT_RULE.closes).toBe('seller');
    expect(DEFAULT_RULE.window).toEqual({ days: 30, side: 'either' });
    expect(DEFAULT_RULE.order).toBe('any');
    expect(DEFAULT_RULE.never).toEqual({ marketplaces: true, over: 20, addresses: [] });
    expect(DEFAULT_RULE.judges).toBe('sales');
    expect(DEFAULT_RULE.minCycles).toBe(1);
  });

  it('passes checkRule', () => {
    expect(checkRule(DEFAULT_RULE)).toEqual({ rule: DEFAULT_RULE });
  });
});

describe('checkRule errors', () => {
  it('refuses what is not a rule', () => {
    expect(errorOf(null)).toBe('Not a lens rule.');
    expect(errorOf([])).toBe('Not a lens rule.');
  });

  it('refuses an unknown edge type', () => {
    const r: any = clone();
    r.edges.xyz = r.edges.eth;
    expect(errorOf(r)).toBe('Unknown edge type: xyz.');
  });

  it('refuses hops that run backwards or out of range', () => {
    const r = clone();
    r.hops = { min: 3, max: 1 };
    expect(errorOf(r)).toBe('Hops: "from" is more than "to".');
    r.hops = { min: 0, max: 7 };
    expect(errorOf(r)).toBe('Hops go from 0 to 6, or "any" when only "NFT: same token" is on.');
    r.hops = { min: 0, max: null };
    expect(errorOf(r)).toBe('Hops go from 0 to 6, or "any" when only "NFT: same token" is on.');
  });

  it('allows "any" hops when only the same-token row is on', () => {
    expect('rule' in checkRule(COPIES.A.rule)).toBe(true);
  });

  it('refuses a fewest-wallets count above 0 with "any" length', () => {
    const r = structuredClone(COPIES.A.rule);
    r.hops = { min: 1, max: null };
    expect(errorOf(r)).toBe('With "any" length, the fewest wallets between must be 0.');
  });

  it('needs the same-token row for two loops', () => {
    const r = clone();
    r.edges['nft-token'].use = false;
    r.minCycles = 2;
    expect(errorOf(r)).toBe('At least 2 loops needs "NFT: same token" switched on.');
  });

  it('refuses the unavailable row switched on, and takes other tokens', () => {
    const w = clone();
    w.edges['nft-watched'].use = true;
    expect(errorOf(w)).toBe("Not in this version: a lens reads this collection's transfers.");
    const o = clone();
    o.edges['other-tokens'].use = true;
    expect(checkRule(o)).toEqual({ rule: o });
  });

  it("refuses a smallest amount on other tokens switched on, with T9's message; switched off, the value is ignored and the rule reads (Ruling P12)", () => {
    const on = clone();
    on.edges['other-tokens'] = { ...on.edges['other-tokens'], use: true, minWei: '1000000' };
    expect(errorOf(on)).toBe('Other tokens take no smallest amount: tokens differ in value.');
    // A rule saved with the row off and a value in it is no corrupt rule.
    const off = clone();
    off.edges['other-tokens'] = { ...off.edges['other-tokens'], use: false, minWei: '1000000' };
    expect(checkRule(off)).toEqual({ rule: off });
    // The other money rows keep theirs.
    const e = clone();
    e.edges.weth.minWei = '1000000';
    expect('rule' in checkRule(e)).toBe(true);
  });

  it('refuses loop order with edges all before the trade', () => {
    const r = clone();
    r.order = 'loop';
    r.window = { days: 30, side: 'before' };
    expect(errorOf(r)).toBe('Edges in loop order cannot all be before the trade.');
  });

  it('refuses a bad address', () => {
    const r = clone();
    r.never.addresses = ['0x12'];
    expect(errorOf(r)).toBe('Not an address: 0x12.');
  });

  it('bounds every number and list, since the routes take untrusted rules', () => {
    const at = (edit: (r: LensRule) => void) => { const r = clone(); edit(r); return checkRule(r); };
    expect(errorOf({ ...clone(), window: { days: 3651, side: 'either' } })).toBe('Window: at most 3650 days.');
    expect('rule' in at((r) => { r.window = { days: 3650, side: 'either' }; })).toBe(true);
    expect(errorOf({ ...clone(), edges: { ...clone().edges, eth: { ...clone().edges.eth, max: 101 } } })).toBe('"ETH payment": at most 100 in a loop.');
    expect('rule' in at((r) => { r.edges.eth.max = 100; })).toBe(true);
    expect(errorOf({ ...clone(), never: { ...clone().never, over: 1_000_000_001 } })).toBe('Never pass through: linked wallets at most 1,000,000,000.');
    expect('rule' in at((r) => { r.never.over = 1_000_000_000; })).toBe(true);
    const wei = (digits: number) => at((r) => { r.edges.eth.minWei = '1'.repeat(digits); });
    expect('rule' in wei(78)).toBe(true);
    expect('error' in wei(79) && wei(79)).toEqual({ error: '"ETH payment": the smallest payment has at most 78 digits in wei.' });
    const addrs = (n: number) => at((r) => { r.never.addresses = Array.from({ length: n }, (_, i) => '0x' + i.toString(16).padStart(40, '0')); });
    expect('rule' in addrs(200)).toBe(true);
    expect('error' in addrs(201) && addrs(201)).toEqual({ error: 'Never pass through: at most 200 addresses.' });
  });

  it('refuses fractions, negatives and signs where a whole number is wanted', () => {
    const r: any = clone();
    r.edges.eth.max = 1.5;
    expect(errorOf(r)).toBe('"ETH payment" is not a valid edge rule.');
    const n: any = clone();
    n.edges.eth.minWei = '-5';
    expect(errorOf(n)).toBe('"ETH payment" is not a valid edge rule.');
    const w: any = clone();
    w.window = { days: -3, side: 'either' };
    expect(errorOf(w)).toBe('Window: days from 1, and a side.');
  });

  it('needs an edge type on', () => {
    const r = clone();
    for (const k of Object.keys(r.edges) as (keyof LensRule['edges'])[]) r.edges[k].use = false;
    expect(errorOf(r)).toBe('Switch on at least one edge type.');
  });
});

describe('checkRule cleaning', () => {
  it('lowercases and dedupes addresses and drops unknown top-level keys', () => {
    const a = '0x' + 'AB'.repeat(20);
    const r: any = clone();
    r.never.addresses = [a, a.toLowerCase()];
    r.extra = 1;
    const out = checkRule(r);
    if (!('rule' in out)) throw new Error(out.error);
    expect(out.rule.never.addresses).toEqual([a.toLowerCase()]);
    expect('extra' in out.rule).toBe(false);
  });
});

describe('ruleLine', () => {
  it("folds Round trips' rule into v2 A's line", () => {
    expect(ruleLine(COPIES.A.rule)).toBe('NFT only, follows arrows, same token, any length, repeats count each');
  });

  it('describes the default rule', () => {
    const line = ruleLine(DEFAULT_RULE);
    expect(line.startsWith('NFT and money')).toBe(true);
    expect(line).toContain('1–3 wallets between');
    expect(line).toContain('within 30 days either side');
  });

  it.each([
    ['the default rule', DEFAULT_RULE, 'NFT and money, either way where allowed, any token of this collection, 1–3 wallets between, within 30 days either side, repeats once'],
    ["Money loops back's copy", COPIES.AU.rule, 'NFT and money, follows arrows, same token, 0–6 wallets between, repeats once'],
    ["Linked wallets' copy: money only, so no NFT scope", COPIES.AC.rule, 'Money only, either way where allowed, 0–1 wallets between, repeats once'],
    ['a window on one side', { ...COPIES.AC.rule, window: { days: 7, side: 'after' } } satisfies LensRule, 'Money only, either way where allowed, 0–1 wallets between, within 7 days after, repeats once'],
  ])('folds %s into one line', (_name, rule, line) => {
    expect(ruleLine(rule)).toBe(line);
  });
});

describe('nameError', () => {
  it.each([
    ['Blur 3-hop', null],
    ['  Padded  ', null],
    ['x'.repeat(60), null],
    ['', 'Give the lens a name.'],
    ['   ', 'Give the lens a name.'],
    ['x'.repeat(61), 'A name is at most 60 characters.'],
    [` ${'x'.repeat(60)} `, null],
    ['tab\there', 'A name cannot hold control characters.'],
    ['nul\u0000', 'A name cannot hold control characters.'],
    ['del\u007f', 'A name cannot hold control characters.'],
  ])('%j: %s', (name, error) => {
    expect(nameError(name)).toBe(error);
  });

  it('is the rule the routes and the editor share: names to 60 characters, ids to int4', () => {
    expect(NAME_MAX).toBe(60);
    expect(INT4_MAX).toBe(2_147_483_647);
  });
});

describe('COPIES', () => {
  it('copies Round trips exactly', () => {
    expect(COPIES.A.differs).toBeNull();
    const r = COPIES.A.rule;
    expect(r.edges['nft-token']).toEqual({ use: true, direction: 'along', max: null, minWei: null, repeats: 'each' });
    expect(Object.entries(r.edges).filter(([, e]) => e.use).map(([k]) => k)).toEqual(['nft-token']);
    expect(r.hops).toEqual({ min: 0, max: null });
    expect(r.window).toBeNull();
    expect(r.order).toBe('any');
    expect(r.never).toEqual({ marketplaces: false, over: null, addresses: [] });
    expect(r.judges).toBe('owners');
    expect(r.minCycles).toBe(2);
  });

  it('every copy passes checkRule and says how it differs in one sentence', () => {
    for (const m of ['A', 'AU', 'AC'] as const) expect('rule' in checkRule(COPIES[m].rule)).toBe(true);
    for (const m of ['AU', 'AC'] as const) {
      const d = COPIES[m].differs!;
      expect(d.length).toBeGreaterThan(0);
      expect(d.endsWith('.')).toBe(true);
      expect(d.slice(0, -1)).not.toContain('. ');
      // A lens ignores sale money too (Ruling K) and bars wallets whose history was cut short (Ruling BB): neither is a difference.
      expect(d).not.toMatch(/sales|cut short|truncated/);
      // Nor is the go-between: the copies bar it as the built-ins do (Ruling JJ).
      expect(d).not.toMatch(/go-between|linked to more than/);
    }
  });

  it('bars a wallet linked to more than 20 of this collection\'s wallets in the money copies, as hubDegree does (Ruling JJ)', () => {
    expect(COPIES.AU.rule.never).toEqual({ marketplaces: true, over: 20, addresses: [] });
    expect(COPIES.AC.rule.never).toEqual({ marketplaces: true, over: 20, addresses: [] });
    expect(COPIES.AU.differs).toBe('Money loops back also needs two laps when no money is involved, and follows money through up to 30 wallets; this copy is as close as the editor can say.');
    expect(COPIES.AC.differs).toBe('Linked wallets also counts every round trip; this copy finds only the money link.');
  });
});

describe('estimateTo', () => {
  const counted: FollowEstimate = { depth: 4, wallets: 10, growth: 2, cut: false, within: 40, at: '2026-11-09T00:00:00.000Z' };

  it('is null with nothing counted, or for a depth short of the one counted', () => {
    expect(estimateTo(null, 5)).toBeNull();
    expect(estimateTo(counted, 3)).toBeNull();
  });

  it('is exact to the counted depth, and each level past it is the one before times the growth, rounded', () => {
    expect(estimateTo(counted, 4)).toEqual({ wallets: 10, exactTo: 4 });
    expect(estimateTo(counted, 6)).toEqual({ wallets: 70, exactTo: 4 }); // 10 + 20 + 40
    expect(estimateTo({ ...counted, growth: 0.25 }, 6)).toEqual({ wallets: 13, exactTo: 4 }); // 10 + 2.5 + 0.625
  });

  it('a count the walk cut is exact only to the depth before it', () => {
    expect(estimateTo({ ...counted, cut: true }, 5)).toEqual({ wallets: 30, exactTo: 3 });
  });

  it('with no growth to go by, adds no levels past the counted one', () => {
    expect(estimateTo({ ...counted, growth: null }, 6)).toEqual({ wallets: 10, exactTo: 4 });
  });
});
