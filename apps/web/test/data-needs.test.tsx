import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RULE, tokensReason, type LensRule } from '@washtrace/detect/lens-rule';
import type { MoneyRead } from '@washtrace/detect';
import { DataNeeds } from '@/components/data-needs';
import { LOCAL_ONLY } from '@/lib/auth';

const ADDR = '0x' + 'b'.repeat(40);
const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh }) }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

/** A rule whose money is followed only the way it was sent, so it can read plain "Enough" (Ruling S19). */
function along(max: number | null, edit: (r: LensRule) => void = () => {}): LensRule {
  const r = structuredClone(DEFAULT_RULE);
  for (const k of ['eth', 'internal', 'weth'] as const) r.edges[k].direction = 'along';
  r.hops.max = max;
  edit(r);
  return r;
}
const MONEY = { traders: { checked: 10_000, of: 10_000 }, limit: 3, ownLimit: null, pendingByDepth: {}, estimate: null, seeding: false };
/** Start reading them never pressed, the worker running tokens.payees off (its default), Ethereum's listed symbols. */
const TOKENS_OFF: Parameters<typeof DataNeeds>[0]['tokens'] = { started: false, counts: null, payees: false, runTokensRead: null, symbols: 'USDC, USDT, DAI, APE' };
const FOLLOW_LINE = 'washtrace does not follow past a wallet that sent to more than 25 others, or whose history was too long to read.';

const view = (over: Partial<Parameters<typeof DataNeeds>[0]> = {}) =>
  render(
    <DataNeeds rule={along(4)} transfers={1_200_000} transfersRead money={MONEY} estimate={null} funding perSecond={4} watched={6} writable
      chainId={1} address={ADDR} followHops={3} fanout={25} callsPerWallet={4} behind={false} paused={false} tokens={TOKENS_OFF} {...over} />,
  ).container;
const row = (c: Element, name: string) => within(c as HTMLElement).getByText(name).closest('tr') as HTMLElement;
const reply = (status: number, body: object) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe('the section', () => {
  it('names the columns and the four edge types, and says what it is for', () => {
    const c = view();
    expect(within(c).getByRole('heading', { name: '3 · Data this lens needs' })).toBeTruthy();
    expect(within(c).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Edge type', 'Read so far', 'For this lens', 'Action']);
    for (const r of ['NFT, this collection', 'ETH, internal ETH, WETH', 'NFT, other watched collections', 'Other tokens']) expect(within(c).getByText(r)).toBeTruthy();
    expect(c.textContent).toContain('how new data gets fetched');
  });

  it('reads all N transfers of this collection as enough', () => {
    const r = row(view(), 'NFT, this collection');
    expect(r.textContent).toContain('All 1,200,000 transfers');
    expect(r.textContent).toContain('Enough');
  });

  it('does not read Enough while the collection\'s history is still being read', () => {
    const r = row(view({ transfersRead: false }), 'NFT, this collection');
    expect(r.textContent).toContain('So far 1,200,000 transfers');
    expect(r.textContent).toContain("Reading history: this collection's transfers are still being read");
    expect(r.textContent).not.toContain('Enough');
    expect(r.textContent).not.toContain('All 1,200,000');
  });

  it('uses lens names, never the codes A, AU or AC', () => {
    const c = view({ rule: along(6), estimate: { wallets: 18_200, exactTo: 4 } });
    expect(c.textContent).not.toMatch(/\b(A|AU|AC)\b/);
  });
});

describe('the money row', () => {
  it('reads the share of wallets read and "Enough: the loop is at most k hops" when the rule needs no more than the limit', () => {
    const r = row(view(), 'ETH, internal ETH, WETH');
    expect(r.textContent).toContain('Wallets up to 3 hops out: 100% of 10,000');
    expect(r.textContent).toContain('Enough: the loop is at most 4 hops');
    expect(r.textContent).toContain(FOLLOW_LINE);
    expect(within(r).queryByRole('button')).toBeNull();
  });

  it('takes the 25 from the fan-out it is handed', () => {
    expect(row(view({ fanout: 40 }), 'ETH, internal ETH, WETH').textContent).toContain('sent to more than 40 others');
  });

  it('with money followed either way never reads plain Enough (Ruling S19)', () => {
    const r = row(view({ rule: along(4, (x) => { x.edges.eth.direction = 'either'; }) }), 'ETH, internal ETH, WETH');
    expect(r.textContent).toContain('Enough the way money was sent: the loop is at most 4 hops');
    expect(r.textContent).toContain('money is followed only the way it was sent, so a loop against it can be missed');
    expect(r.textContent).not.toContain('Enough: the loop');
    expect(r.textContent).toContain(FOLLOW_LINE);
  });

  it('reads the shortfall as about W more wallets and about T at R calls a second, with Fetch them', () => {
    // 18,200 wallets x 4 calls at 4 a second is 18,200 s, about 5 h.
    const c = view({ rule: along(6), estimate: { wallets: 18_200, exactTo: 4 } });
    const r = row(c, 'ETH, internal ETH, WETH');
    expect(r.textContent).toContain('Needs about 18,200 more wallets checked, about 5 h at 4 Etherscan calls a second');
    expect(r.textContent).not.toContain('Enough');
    expect(within(r).getByRole('button', { name: 'Fetch them' })).toBeTruthy();
    expect(r.textContent).toContain(FOLLOW_LINE);
    // It glosses the button: nothing is queued until it is pressed.
    expect(r.textContent).toContain('Fetch them queues the reads in the worker; the run uses what is read and marks its share "at least".');
  });

  it('says it has not counted yet, and still offers Fetch them (Ruling S21)', () => {
    const r = row(view({ rule: along(6), estimate: null }), 'ETH, internal ETH, WETH');
    expect(r.textContent).toContain('Not counted yet: washtrace counts how many wallets this means in a coming money check.');
    expect(within(r).getByRole('button', { name: 'Fetch them' })).toBeTruthy();
  });

  it('posts the hops the rule needs, then refreshes the page', async () => {
    const fetchMock = reply(202, { set: true });
    vi.stubGlobal('fetch', fetchMock);
    const c = view({ rule: along(6), estimate: null });
    fireEvent.click(within(c).getByRole('button', { name: 'Fetch them' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/collections/1/${ADDR}/follow`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ hops: 5 });
  });

  it('shows a refusal instead of refreshing', async () => {
    vi.stubGlobal('fetch', reply(400, { error: 'No.' }));
    const c = view({ rule: along(6) });
    fireEvent.click(within(c).getByRole('button', { name: 'Fetch them' }));
    await waitFor(() => expect(within(c).getByRole('alert').textContent).toBe('No.'));
    expect(refresh).not.toHaveBeenCalled();
  });

  it('reads the real share in Read so far while the traders\' check runs: 94% (Ruling S32)', () => {
    const r = row(view({ rule: along(6), money: { ...MONEY, traders: { checked: 9400, of: 10_000 } } }), 'ETH, internal ETH, WETH');
    expect(r.textContent).toContain('Wallets up to 3 hops out: 94% of 10,000');
    expect(r.textContent).toContain("The traders' check is still running");
    expect(within(r).queryByRole('button')).toBeNull();
  });

  it('floors the share: 9,996 of 10,000 reads 99%, never 100% while the check runs', () => {
    const r = row(view({ rule: along(6), money: { ...MONEY, traders: { checked: 9996, of: 10_000 } } }), 'ETH, internal ETH, WETH');
    expect(r.textContent).toContain('Wallets up to 3 hops out: 99% of 10,000');
  });

  it('a truncated trader is checked as far as it will be: every trader done offers Fetch them (Ruling S35)', () => {
    // moneyRead counts it checked, so checked reaches of.
    const r = row(view({ rule: along(6), money: { ...MONEY, traders: { checked: 2, of: 2 } } }), 'ETH, internal ETH, WETH');
    expect(r.textContent).not.toContain("The traders' check is still running");
    expect(within(r).getByRole('button', { name: 'Fetch them' })).toBeTruthy();
  });

  it('says the traders\' check is still running before anything about hops, with no Fetch them', () => {
    const r = row(view({ rule: along(6), money: { ...MONEY, traders: { checked: 40, of: 100 } } }), 'ETH, internal ETH, WETH');
    expect(r.textContent).toContain("The traders' check is still running: 40 of 100 traders checked");
    expect(r.textContent).not.toContain('Enough');
    expect(within(r).queryByRole('button')).toBeNull();
  });

  it('with no key reads "Needs an Etherscan key → Settings", linked, with no button', () => {
    const r = row(view({ rule: along(6), funding: false }), 'ETH, internal ETH, WETH');
    const link = within(r).getByRole('link', { name: 'Needs an Etherscan key → Settings' });
    expect(link.getAttribute('href')).toBe('/settings#etherscan.key');
    expect(within(r).queryByRole('button')).toBeNull();
    expect(r.textContent).not.toContain('Enough');
  });

  it('a lens with no money edge reads "Not used by this lens", with no button', () => {
    const rule = along(4, (x) => { for (const k of ['eth', 'internal', 'weth'] as const) x.edges[k].use = false; });
    const r = row(view({ rule }), 'ETH, internal ETH, WETH');
    expect(r.textContent).toContain('Not used by this lens');
    expect(within(r).queryByRole('button')).toBeNull();
  });

  it('past 10 hops reads "Needs more than washtrace follows (10 hops)", with no button', () => {
    const r = row(view({ rule: along(13), estimate: { wallets: 5, exactTo: 4 } }), 'ETH, internal ETH, WETH');
    expect(r.textContent).toContain('Needs more than washtrace follows (10 hops)');
    expect(within(r).queryByRole('button')).toBeNull();
  });

  it('is disabled with the local-only title where writes are refused', () => {
    const b = within(view({ rule: along(6), writable: false })).getByRole('button', { name: 'Fetch them' }) as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(b.title).toBe(LOCAL_ONLY);
  });
});

describe('money still being read (Ruling S25)', () => {
  it('while seeding never reads Enough, and shows no button', () => {
    const r = row(view({ rule: along(6), money: { ...MONEY, limit: 5, ownLimit: 5, seeding: true } }), 'ETH, internal ETH, WETH');
    expect(r.textContent).toContain('Finding the wallets up to 5 hops out from the money already read');
    expect(r.textContent).not.toContain('Enough');
    expect(within(r).queryByRole('button')).toBeNull();
  });

  it('paused while seeding: says the walk goes on once resumed, with no button', () => {
    const r = row(view({ rule: along(6), money: { ...MONEY, limit: 5, ownLimit: 5, seeding: true }, paused: true }), 'ETH, internal ETH, WETH');
    expect(r.textContent).toContain('Paused: finding the wallets continues once this collection is resumed');
    expect(r.textContent).not.toContain('Finding the wallets up to');
    expect(within(r).queryByRole('button')).toBeNull();
  });

  it('seeding does not hold back a lens that needs no more than the global limit (Ruling S31)', () => {
    const r = row(view({ rule: along(4), money: { ...MONEY, limit: 5, ownLimit: 5, seeding: true } }), 'ETH, internal ETH, WETH');
    expect(r.textContent).toContain('Enough: the loop is at most 4 hops');
    expect(r.textContent).not.toContain('Finding the wallets');
  });

  it('with wallets pending up to the depth needed reads how many are still to read, and shows no button', () => {
    const money = { ...MONEY, limit: 5, ownLimit: 5, pendingByDepth: { 4: 120, 5: 30, 6: 900 } };
    const r = row(view({ rule: along(6), money }), 'ETH, internal ETH, WETH');
    expect(r.textContent).toContain('Reading: 150 wallets still to read up to 5 hops');
    expect(r.textContent).not.toContain('Enough');
    expect(within(r).queryByRole('button')).toBeNull();
  });

  it('read, but the lens\'s run is behind it: says the next analysis or lens run takes it in, never Enough, with no button (Ruling S36)', () => {
    const r = row(view({ rule: along(6), money: { ...MONEY, limit: 5, ownLimit: 5 }, behind: true }), 'ETH, internal ETH, WETH');
    expect(r.textContent).toContain('Read: the next analysis or lens run takes it in');
    expect(r.textContent).not.toContain('Enough');
    expect(within(r).queryByRole('button')).toBeNull();
  });

  it('a run behind holds back no lens within the global limit', () => {
    const r = row(view({ rule: along(4), money: { ...MONEY, limit: 5, ownLimit: 5 }, behind: true }), 'ETH, internal ETH, WETH');
    expect(r.textContent).toContain('Enough: the loop is at most 4 hops');
  });

  it('Read so far names the depth read through, not the new limit (Ruling S37)', () => {
    const at = (money: object) => row(view({ rule: along(6), money: { ...MONEY, limit: 5, ownLimit: 5, ...money } }), 'ETH, internal ETH, WETH').textContent;
    expect(at({ seeding: true })).toContain('Wallets up to 3 hops out: 100% of 10,000');
    cleanup();
    expect(at({ pendingByDepth: { 4: 500 } })).toContain('Wallets up to 3 hops out');
    cleanup();
    expect(at({ pendingByDepth: { 5: 500 } })).toContain('Wallets up to 4 hops out');
    cleanup();
    expect(at({})).toContain('Wallets up to 5 hops out');
  });

  it('wallets pending only past the depth needed do not hold back Enough', () => {
    const money = { ...MONEY, limit: 5, ownLimit: 5, pendingByDepth: { 5: 30 } };
    expect(row(view({ rule: along(4), money }), 'ETH, internal ETH, WETH').textContent).toContain('Enough: the loop is at most 4 hops');
  });
});

describe('the other two rows', () => {
  it('NFT, other watched collections reads how many are watched, off in this lens, with Watch another collection', () => {
    const r = row(view(), 'NFT, other watched collections');
    expect(r.textContent).toContain('6 collections watched');
    expect(r.textContent).toContain('Off in this lens');
    expect(within(r).getByRole('link', { name: 'Watch another collection' }).getAttribute('href')).toBe('/');
  });
});

describe('the Other tokens row', () => {
  const SYMBOLS = 'USDC, USDT, DAI, APE';
  /** The line every state carries: the tokens read, then what is never read past (Ruling P15). */
  const LIMITS = `Reads ${SYMBOLS}. washtrace does not read past a wallet whose token list was too long to read, and a wallet that sent these tokens to more than 25 others is no way back.`;
  /** A rule that uses Other tokens and no ETH or WETH, with hops.max k. */
  const tokenRule = (max: number | null = 3) => along(max, (r) => { for (const k of ['eth', 'internal', 'weth'] as const) r.edges[k].use = false; r.edges['other-tokens'].use = true; });
  const counted = { wallets: 300_000, read: 300_000, truncated: 0, failed: 0, moneyFailed: 0, settled: true, payees: false, at: '2026-11-09T00:00:00.000Z' };
  const started = (counts: Partial<typeof counted> | null, over: Partial<typeof TOKENS_OFF> = {}) =>
    ({ ...TOKENS_OFF, started: true, counts: counts === null ? null : { ...counted, ...counts }, runTokensRead: counted.read, ...over });
  const tokenRow = (over: Partial<Parameters<typeof DataNeeds>[0]> = {}) => row(view({ rule: tokenRule(), ...over }), 'Other tokens');
  const cells = (r: HTMLElement) => [...r.querySelectorAll('td')].map((td) => td.textContent);

  it('names the tokens it reads, from the list, and says a lens not using them does not', () => {
    const r = tokenRow({ rule: along(4) });
    expect(cells(r).slice(1, 3)).toEqual([`Reads ${SYMBOLS}`, `Not used by this lens${LIMITS}`]);
    expect(within(r).queryByRole('button')).toBeNull();
  });

  it('names the tokens in every state, the ones that spend reads included, and says when none are listed', () => {
    for (const t of [TOKENS_OFF, started(null), started({ read: 5 }), started({})]) expect(cells(tokenRow({ tokens: t }))[2]!.endsWith(LIMITS)).toBe(true);
    expect(cells(tokenRow({ tokens: { ...TOKENS_OFF, symbols: '' } }))[2]).toContain('Reads no tokens: none are listed for this chain. washtrace does not read past');
  });

  it('with no key reads "Needs an Etherscan key → Settings", linked, with no button', () => {
    const r = tokenRow({ funding: false });
    expect(r.textContent).toContain(`Reads ${SYMBOLS}`);
    expect(within(r).getByRole('link', { name: 'Needs an Etherscan key → Settings' }).getAttribute('href')).toBe('/settings#etherscan.key');
    expect(within(r).queryByRole('button')).toBeNull();
  });

  it('before Start reading, not counted: says so, with the button', () => {
    const r = tokenRow();
    expect(cells(r).slice(1, 3)).toEqual(['Not read: washtrace has never fetched them', `Not counted yet: washtrace counts how many wallets this means in a coming money check.${LIMITS}`]);
    expect(within(r).getByRole('button', { name: 'Start reading them' })).toBeTruthy();
  });

  it('an estimate stored before `within` was counted reads as not counted', () => {
    const old = { depth: 4, wallets: 9, growth: null, cut: false, at: 'x' } as unknown as MoneyRead['estimate'];
    expect(tokenRow({ money: { ...MONEY, estimate: old } }).textContent).toContain('Not counted yet');
  });

  const COUNTED = { ...MONEY, estimate: { depth: 4, wallets: 9, growth: null, cut: false, within: 300_000, at: 'x' } };
  it('before Start reading, counted: about W wallets, at least T at R calls a second', () => {
    const r = tokenRow({ money: COUNTED });
    expect(cells(r)[2]).toBe(`Not read: about 300,000 wallets, at least 20 h at 4 Etherscan calls a second${LIMITS}`);
    expect(within(r).getByRole('button', { name: 'Start reading them' })).toBeTruthy();
  });

  it("with tokens.payees on, adds the traders' payees to the estimate", () => {
    const r = tokenRow({ money: COUNTED, tokens: { ...TOKENS_OFF, payees: true } });
    expect(cells(r)[2]).toContain('at 4 Etherscan calls a second; plus up to 25 for each trader paid in these tokens');
  });

  it('Start reading them posts {} to the tokens route and refreshes; disabled with the reason where writes are refused', async () => {
    const fetchMock = reply(202, { started: true });
    vi.stubGlobal('fetch', fetchMock);
    const r = tokenRow();
    fireEvent.click(within(r).getByRole('button', { name: 'Start reading them' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/collections/1/${ADDR}/tokens`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({});
    cleanup();
    const locked = within(tokenRow({ writable: false })).getByRole('button', { name: 'Start reading them' }) as HTMLButtonElement;
    expect(locked.disabled).toBe(true);
    expect(locked.title).toBe(LOCAL_ONLY);
  });

  it('shows a refusal in an alert and does not refresh', async () => {
    vi.stubGlobal('fetch', reply(404, { error: 'This collection is not watched.' }));
    const r = tokenRow();
    fireEvent.click(within(r).getByRole('button', { name: 'Start reading them' }));
    await waitFor(() => expect(within(r).getByRole('alert').textContent).toBe('This collection is not watched.'));
    expect(refresh).not.toHaveBeenCalled();
  });

  it('started, no count yet: Started, the next money check counts the wallets, no button', () => {
    const r = tokenRow({ tokens: started(null) });
    expect(cells(r).slice(1, 3)).toEqual(['Started', `Reading: the next money check counts the wallets${LIMITS}`]);
    expect(within(r).queryByRole('button')).toBeNull();
  });

  it('seeding: the walk is not settled, with the limit it walks to and any failed money checks', () => {
    const r = tokenRow({ tokens: started({ settled: false, read: 1_200, wallets: 5_000 }), money: { ...MONEY, ownLimit: 5 } });
    expect(cells(r).slice(1, 3)).toEqual(['1,200 of 5,000 wallets read so far', `Finding this collection's wallets up to 5 hops out${LIMITS}`]);
    const failed = tokenRow({ tokens: started({ settled: false, moneyFailed: 3 }) });
    expect(cells(failed)[2]).toContain("Finding this collection's wallets up to 3 hops out; 3 wallets' money checks failed, tried again hourly");
    expect(tokenRow({ tokens: started({ settled: false, moneyFailed: 1 }) }).textContent).toContain("1 wallet's money check failed, tried again hourly");
  });

  it('paused and not done: continues once resumed, whether still seeding or reading', () => {
    for (const counts of [{ settled: false, read: 10, wallets: 50 }, { read: 10, wallets: 50 }, null]) {
      const r = tokenRow({ tokens: started(counts), paused: true });
      expect(cells(r)[2]).toBe(`Paused: reading continues once this collection is resumed${LIMITS}`);
      expect(cells(r)[1]).toBe(counts === null ? 'Started' : '10 of 50 wallets read so far');
    }
    // A finished read is not paused work.
    expect(tokenRow({ tokens: started({}), paused: true }).textContent).not.toContain('Paused');
  });

  it('pending: N wallets still to read, and any failed reads', () => {
    expect(cells(tokenRow({ tokens: started({ read: 299_000 }) })).slice(1, 3)).toEqual(['299,000 of 300,000 wallets read', `Reading: 1,000 wallets still to read${LIMITS}`]);
    expect(cells(tokenRow({ tokens: started({ read: 299_000, failed: 40 }) }))[2]).toBe(`Reading: 1,000 wallets still to read; 40 failed, tried again hourly${LIMITS}`);
  });

  it('behind: all read, the next lens run takes it in', () => {
    const r = tokenRow({ tokens: started({}, { runTokensRead: 12 }) });
    expect(cells(r).slice(1, 3)).toEqual(['All 300,000 wallets read', `Read: the next lens run takes it in${LIMITS}`]);
    expect(within(r).queryByRole('button')).toBeNull();
  });

  it('read, with no middle wallet: Enough', () => {
    expect(cells(tokenRow({ rule: tokenRule(0), tokens: started({}) })).slice(1, 3)).toEqual(['All 300,000 wallets read', `Enough${LIMITS}`]);
  });

  it('read, with more middles than the read reaches: Enough only for wallets reached by ETH or WETH', () => {
    const r = tokenRow({ tokens: started({}) });
    expect(cells(r)[2]).toBe(`Enough for wallets reached by ETH or WETH: a loop through tokens can be missed${LIMITS}`);
    expect(within(r).queryByRole('button')).toBeNull();
    // With tokens.payees on, one token payment more is reached, so one middle is enough and two are not.
    expect(cells(tokenRow({ rule: tokenRule(1), tokens: started({ payees: true }) }))[2]).toBe(`Enough${LIMITS}`);
    expect(cells(tokenRow({ rule: tokenRule(2), tokens: started({ payees: true }) }))[2]).toBe(
      `Enough for wallets reached by ETH, WETH or one token payment: a loop through tokens can be missed${LIMITS}`);
    // Followed either way, a middle that paid both traders is in no set: one middle is already more than is read, in the setting's words (Ruling P13).
    const either = tokenRule(1);
    either.edges['other-tokens'].direction = 'either';
    expect(cells(tokenRow({ rule: either, tokens: started({ payees: true }) }))[2]).toBe(
      `Enough for wallets reached by ETH, WETH or one token payment: a loop through tokens can be missed${LIMITS}`);
  });

  it('takes the 25 from the fan-out it is handed', () => {
    expect(tokenRow({ fanout: 40 }).textContent).toContain('sent these tokens to more than 40 others');
  });

  it('uses lens names, never the codes', () => {
    for (const t of [TOKENS_OFF, started(null), started({}), started({ settled: false })]) {
      expect(tokenRow({ tokens: t }).textContent).not.toMatch(/\b(A|AU|AC)\b/);
    }
  });

  it('agrees with tokensReason over a grid of its inputs', () => {
    /** The exact words of the row for one decision, before the line every state carries. */
    const expected = (why: ReturnType<typeof tokensReason>, t: Parameters<typeof DataNeeds>[0]['tokens'], paused: boolean, estimated: boolean) => {
      const c = t.counts;
      if (why === 'off') {
        return estimated
          ? `Not read: about 300,000 wallets, at least 20 h at 4 Etherscan calls a second${t.payees ? '; plus up to 25 for each trader paid in these tokens' : ''}`
          : 'Not counted yet: washtrace counts how many wallets this means in a coming money check.';
      }
      if ((why === 'seeding' || why === 'pending') && paused) return 'Paused: reading continues once this collection is resumed';
      if (why === 'seeding') return c === null ? 'Reading: the next money check counts the wallets' : "Finding this collection's wallets up to 3 hops out";
      if (why === 'pending') return `Reading: ${(c!.wallets - c!.read).toLocaleString('en-US')} wallets still to read`;
      if (why === 'behind') return 'Read: the next lens run takes it in';
      if (why === null) return 'Enough';
      return c!.payees
        ? 'Enough for wallets reached by ETH, WETH or one token payment: a loop through tokens can be missed'
        : 'Enough for wallets reached by ETH or WETH: a loop through tokens can be missed';
    };
    // Before Start reading the counts do not matter and the estimate does; after it, the other way round. With no key, nothing else matters.
    for (const isStarted of [false, true]) for (const counts of isStarted ? [null, {}, { read: 5 }, { settled: false }, { payees: true }] : [null, {}]) for (const run of [4, 300_000]) for (const max of [0, 1, 2, null])
      for (const payees of [false, true]) for (const paused of [false, true]) for (const [funding, estimated] of (isStarted ? [[true, false], [false, false]] : [[true, false], [true, true], [false, false]]) as [boolean, boolean][]) {
        const rule = tokenRule(max);
        const t = { started: isStarted, counts: counts === null ? null : { ...counted, ...counts }, payees, runTokensRead: run, symbols: SYMBOLS };
        const why = tokensReason(rule, t.started, t.counts, t.runTokensRead);
        const r = tokenRow({ rule, tokens: t, paused, funding, money: estimated ? COUNTED : MONEY });
        // With no key nothing is read, whatever was started: the row says so, and offers nothing to press.
        expect(cells(r)[2]).toBe(`${funding ? expected(why, t, paused, estimated) : 'Needs an Etherscan key → Settings'}${LIMITS}`);
        // The button shows exactly when nothing has been started and a key is set.
        expect(within(r).queryByRole('button') !== null).toBe(funding && why === 'off');
        cleanup();
      }
  // Some 500 renders: about 1 s alone, over 3 s beside the whole web suite, so past the default 5 s it would flake.
  }, 20_000);
});
