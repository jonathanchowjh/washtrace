import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RULE, type LensRule } from '@washtrace/detect/lens-rule';
import { tokensReason } from '@washtrace/detect/lens-reads';
import type { MoneyRead } from '@washtrace/detect';
import { DataNeeds } from '@/components/data-needs';
import { LOCAL_ONLY } from '@/lib/auth';
import { ETHERSCAN_CTA, ETHERSCAN_HREF } from '@/lib/format';

const ADDR = '0x' + 'b'.repeat(40);
const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh }) }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

/** DEFAULT_RULE with this many wallets between at most (so it needs one less wallets out), then `edit`. */
function withMax(max: number | null, edit: (r: LensRule) => void = () => {}): LensRule {
  const r = structuredClone(DEFAULT_RULE);
  r.hops.max = max;
  edit(r);
  return r;
}
const MONEY = { traders: { checked: 10_000, of: 10_000 }, limit: 3, ownLimit: null, pendingByDepth: {}, estimate: null, seeding: false };
/** Read other tokens never pressed, the worker running tokens.payees off (its default), Ethereum's listed symbols. */
const TOKENS_OFF: Parameters<typeof DataNeeds>[0]['tokens'] = { started: false, counts: null, payees: false, runTokensRead: null, symbols: 'USDC, USDT, DAI, APE' };
const APPLIES = 'Applies to this collection for every lens; Cancel does not undo it.';
const FOLLOW_LINE = 'washtrace does not follow past a wallet that sent to more than 25 others, or whose history or token list was too long to read.';

const view = (over: Partial<Parameters<typeof DataNeeds>[0]> = {}) =>
  render(
    <DataNeeds rule={withMax(4)} transfers={1_200_000} transfersRead money={MONEY} estimate={null} funding perSecond={4} watched={6} writable
      chainId={1} address={ADDR} followHops={3} fanout={25} callsPerWallet={4} behind={false} paused={false} tokens={TOKENS_OFF} {...over} />,
  ).container;
/** The strip's lines, as text. */
const lines = (c: Element) => [...c.querySelectorAll('li')].map((li) => li.textContent!);
const occurrences = (c: Element, text: string) => c.textContent!.split(text).length - 1;
const reply = (status: number, body: object) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe('the strip', () => {
  it('renders nothing when money is read enough and tokens are unused', () => {
    expect(view().innerHTML).toBe('');
  });

  it('shows a lens that uses no money, or whose rule has no limit, no money line', () => {
    const noMoney = withMax(6, (x) => { for (const k of ['eth', 'internal', 'weth'] as const) x.edges[k].use = false; });
    expect(view({ rule: noMoney }).innerHTML).toBe('');
    cleanup();
    expect(view({ rule: withMax(null), money: { ...MONEY, limit: 0 } }).innerHTML).toBe('');
  });

  it('says nothing about money read enough the way it was sent, or with a run behind within the global limit', () => {
    expect(view({ rule: withMax(4, (x) => { x.edges.eth.direction = 'either'; }) }).innerHTML).toBe('');
    cleanup();
    expect(view({ money: { ...MONEY, limit: 5, ownLimit: 5 }, behind: true }).innerHTML).toBe('');
  });

  it('names the heading and carries no "hop" word in any state', () => {
    const c = view({ rule: withMax(6), estimate: { wallets: 18_200, exactTo: 4 }, transfersRead: false });
    expect(within(c).getByRole('heading', { name: 'Data this lens needs' })).toBeTruthy();
    expect(c.textContent).not.toMatch(/\bhops?\b/i);
    expect(c.textContent).not.toMatch(/\b(A|AU|AC)\b/);
  });
});

describe('the collection line', () => {
  it('shows only while the history is being read, and only for a lens using NFT edges', () => {
    expect(lines(view({ transfersRead: false }))).toEqual(["This collection's transfers are still being read: 1,200,000 so far"]);
    cleanup();
    const noNft = withMax(4, (x) => { x.edges['nft-token'].use = false; x.edges['nft-collection'].use = false; });
    expect(view({ rule: noNft, transfersRead: false }).innerHTML).toBe('');
  });

  it('has no action and none of the read caveats', () => {
    const c = view({ transfersRead: false });
    expect(within(c).queryByRole('button')).toBeNull();
    expect(c.textContent).not.toContain(APPLIES);
    expect(c.textContent).not.toContain(FOLLOW_LINE);
  });
});

describe('the money line', () => {
  it('short: one line with the shortfall and Read money 3 wallets out for a loop of at most 4 wallets between', () => {
    // 18,200 wallets x 4 calls at 4 a second is 18,200 s, about 5 h.
    const c = view({ rule: withMax(4), money: { ...MONEY, limit: 2 }, estimate: { wallets: 18_200, exactTo: 2 } });
    expect(lines(c)).toHaveLength(1);
    expect(lines(c)[0]).toContain('Money is read 2 wallets out, and this lens needs 3: needs about 18,200 more wallets checked, about 5 h at 4 Etherscan calls a second');
    expect(within(c).getByRole('button', { name: 'Read money 3 wallets out' })).toBeTruthy();
    expect(c.textContent).not.toContain('Fetch them');
  });

  it('says it has not counted yet, and still offers the button', () => {
    const c = view({ rule: withMax(6), estimate: null });
    expect(c.textContent).toContain('Not counted yet: washtrace counts how many wallets this means in a coming money check.');
    expect(within(c).getByRole('button', { name: 'Read money 5 wallets out' })).toBeTruthy();
  });

  it('POSTs the depth the rule needs to /follow, then refreshes the page', async () => {
    const fetchMock = reply(202, { set: true });
    vi.stubGlobal('fetch', fetchMock);
    const c = view({ rule: withMax(4), money: { ...MONEY, limit: 2 } });
    fireEvent.click(within(c).getByRole('button', { name: 'Read money 3 wallets out' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/collections/1/${ADDR}/follow`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ hops: 3 });
  });

  it('shows a refusal in an alert instead of refreshing', async () => {
    vi.stubGlobal('fetch', reply(400, { error: 'No.' }));
    const c = view({ rule: withMax(6) });
    fireEvent.click(within(c).getByRole('button', { name: 'Read money 5 wallets out' }));
    await waitFor(() => expect(within(c).getByRole('alert').textContent).toBe('No.'));
    expect(refresh).not.toHaveBeenCalled();
  });

  it('is disabled with the local-only title where writes are refused', () => {
    const b = within(view({ rule: withMax(6), writable: false })).getByRole('button', { name: 'Read money 5 wallets out' }) as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(b.title).toBe(LOCAL_ONLY);
  });

  it('titles its action with "so far", as a read now running is a moving cause', () => {
    const b = within(view({ rule: withMax(6) })).getByRole('button', { name: 'Read money 5 wallets out' }) as HTMLButtonElement;
    expect(b.title).toContain('"so far"');
  });

  it('while the traders\' check runs: says so with the share checked, and no button', () => {
    const c = view({ rule: withMax(6), money: { ...MONEY, traders: { checked: 40, of: 100 } } });
    expect(c.textContent).toContain("The traders' check is still running: 40 of 100 traders checked");
    expect(within(c).queryByRole('button')).toBeNull();
  });

  it('a truncated trader counts as checked: every trader done offers the button', () => {
    const c = view({ rule: withMax(6), money: { ...MONEY, traders: { checked: 2, of: 2 } } });
    expect(c.textContent).not.toContain("The traders' check");
    expect(within(c).getByRole('button', { name: 'Read money 5 wallets out' })).toBeTruthy();
  });

  it('with no key shows the Etherscan link in place of the button', () => {
    const c = view({ rule: withMax(6), funding: false });
    expect(within(c).getByRole('link', { name: ETHERSCAN_CTA }).getAttribute('href')).toBe(ETHERSCAN_HREF);
    expect(within(c).queryByRole('button')).toBeNull();
    expect(c.textContent).toContain('the lens runs on the stored money trail only');
  });

  it('while seeding reads how far it finds wallets, and paused says it goes on once resumed; neither has a button', () => {
    const seeding = { ...MONEY, limit: 5, ownLimit: 5, seeding: true };
    const c = view({ rule: withMax(6), money: seeding });
    expect(lines(c)[0]).toBe('Finding the wallets up to 5 wallets out from the money already read');
    expect(within(c).queryByRole('button')).toBeNull();
    cleanup();
    const p = view({ rule: withMax(6), money: seeding, paused: true });
    expect(lines(p)[0]).toBe('Paused: finding the wallets continues once this collection is resumed');
  });

  it('seeding does not hold back a lens within the global limit', () => {
    expect(view({ rule: withMax(4), money: { ...MONEY, limit: 5, ownLimit: 5, seeding: true } }).innerHTML).toBe('');
  });

  it('with wallets pending up to the depth needed reads how many are still to read; those past it hold nothing back', () => {
    const c = view({ rule: withMax(6), money: { ...MONEY, limit: 5, ownLimit: 5, pendingByDepth: { 4: 120, 5: 30, 6: 900 } } });
    expect(lines(c)[0]).toBe('Reading: 150 wallets still to read up to 5 wallets out');
    expect(within(c).queryByRole('button')).toBeNull();
    cleanup();
    expect(view({ rule: withMax(4), money: { ...MONEY, limit: 5, ownLimit: 5, pendingByDepth: { 5: 30 } } }).innerHTML).toBe('');
  });

  it('read, but the lens\'s run is behind it: the next analysis or lens run takes it in', () => {
    const c = view({ rule: withMax(6), money: { ...MONEY, limit: 5, ownLimit: 5 }, behind: true });
    expect(lines(c)[0]).toBe('Read: the next analysis or lens run takes it in');
    expect(within(c).queryByRole('button')).toBeNull();
  });
});

describe('the Other tokens line', () => {
  /** A rule that uses Other tokens and no ETH or WETH, with hops.max k. */
  const tokenRule = (max: number | null = 3) => withMax(max, (r) => { for (const k of ['eth', 'internal', 'weth'] as const) r.edges[k].use = false; r.edges['other-tokens'].use = true; });
  const counted = { wallets: 300_000, read: 300_000, truncated: 0, failed: 0, moneyFailed: 0, settled: true, payees: false, at: '2026-11-09T00:00:00.000Z' };
  const started = (counts: Partial<typeof counted> | null, over: Partial<typeof TOKENS_OFF> = {}) =>
    ({ ...TOKENS_OFF, started: true, counts: counts === null ? null : { ...counted, ...counts }, runTokensRead: counted.read, ...over });
  const tokenView = (over: Partial<Parameters<typeof DataNeeds>[0]> = {}) => view({ rule: tokenRule(), ...over });
  const COUNTED = { ...MONEY, estimate: { depth: 4, wallets: 9, growth: null, cut: false, within: 300_000, at: 'x' } };

  it('is not shown for a lens not using Other tokens', () => {
    expect(view({ rule: withMax(4) }).innerHTML).toBe('');
  });

  it('with no key shows the Etherscan link in place of the button', () => {
    const c = tokenView({ funding: false });
    expect(within(c).getByRole('link', { name: ETHERSCAN_CTA }).getAttribute('href')).toBe(ETHERSCAN_HREF);
    expect(within(c).queryByRole('button')).toBeNull();
  });

  it('before Read other tokens, not counted: says so, with the button', () => {
    const c = tokenView();
    expect(lines(c)[0]).toContain('Other tokens (USDC, USDT, DAI, APE) are not read: not counted yet, washtrace counts how many wallets this means in a coming money check');
    expect(within(c).getByRole('button', { name: 'Read other tokens' })).toBeTruthy();
  });

  it('an estimate stored before `within` was counted reads as not counted', () => {
    const old = { depth: 4, wallets: 9, growth: null, cut: false, at: 'x' } as unknown as MoneyRead['estimate'];
    expect(tokenView({ money: { ...MONEY, estimate: old } }).textContent).toContain('not counted yet');
  });

  it('before Read other tokens, counted: about W wallets, at least T at R calls a second; payees add their share; says when none are listed', () => {
    expect(lines(tokenView({ money: COUNTED }))[0]).toContain('Other tokens (USDC, USDT, DAI, APE) are not read: about 300,000 wallets, at least 20 h at 4 Etherscan calls a second');
    cleanup();
    expect(tokenView({ money: COUNTED, tokens: { ...TOKENS_OFF, payees: true } }).textContent).toContain('at 4 Etherscan calls a second; plus up to 25 for each trader paid in these tokens');
    cleanup();
    expect(tokenView({ tokens: { ...TOKENS_OFF, symbols: '' } }).textContent).toContain('Other tokens (none are listed for this chain) are not read');
  });

  it('titles its action with "so far"', () => {
    expect((within(tokenView()).getByRole('button', { name: 'Read other tokens' }) as HTMLButtonElement).title).toContain('"so far"');
  });

  it('POSTs {} to /tokens and refreshes; disabled with the reason where writes are refused', async () => {
    const fetchMock = reply(202, { started: true });
    vi.stubGlobal('fetch', fetchMock);
    fireEvent.click(within(tokenView()).getByRole('button', { name: 'Read other tokens' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/collections/1/${ADDR}/tokens`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({});
    cleanup();
    const locked = within(tokenView({ writable: false })).getByRole('button', { name: 'Read other tokens' }) as HTMLButtonElement;
    expect(locked.disabled).toBe(true);
    expect(locked.title).toBe(LOCAL_ONLY);
  });

  it('shows a refusal in an alert and does not refresh', async () => {
    vi.stubGlobal('fetch', reply(404, { error: 'This collection is not watched.' }));
    const c = tokenView();
    fireEvent.click(within(c).getByRole('button', { name: 'Read other tokens' }));
    await waitFor(() => expect(within(c).getByRole('alert').textContent).toBe('This collection is not watched.'));
    expect(refresh).not.toHaveBeenCalled();
  });

  it('started, no count yet: the next money check counts the wallets, no button', () => {
    const c = tokenView({ tokens: started(null) });
    expect(lines(c)[0]).toBe('Other tokens: reading, the next money check counts the wallets');
    expect(within(c).queryByRole('button')).toBeNull();
  });

  it('seeding: the walk is not settled, with the limit it walks to and any failed money checks', () => {
    const c = tokenView({ tokens: started({ settled: false, read: 1_200, wallets: 5_000 }), money: { ...MONEY, ownLimit: 5 } });
    expect(lines(c)[0]).toBe("Other tokens: 1,200 of 5,000 wallets read so far, finding this collection's wallets up to 5 wallets out");
    expect(lines(tokenView({ tokens: started({ settled: false, moneyFailed: 3 }) }))[0]).toContain("up to 3 wallets out; 3 wallets' money checks failed, tried again hourly");
    cleanup();
    expect(tokenView({ tokens: started({ settled: false, moneyFailed: 1 }) }).textContent).toContain("1 wallet's money check failed, tried again hourly");
  });

  it('paused and not done: continues once resumed, whether still seeding or reading; a finished read is not paused work', () => {
    for (const counts of [{ settled: false, read: 10, wallets: 50 }, { read: 10, wallets: 50 }, null]) {
      expect(lines(tokenView({ tokens: started(counts), paused: true }))[0]).toBe('Other tokens: paused, reading continues once this collection is resumed');
      cleanup();
    }
    expect(tokenView({ tokens: started({}), paused: true }).textContent).not.toContain('paused');
  });

  it('pending: N wallets still to read, and any failed reads', () => {
    expect(lines(tokenView({ tokens: started({ read: 299_000 }) }))[0]).toBe('Other tokens: reading, 1,000 wallets still to read');
    cleanup();
    expect(lines(tokenView({ tokens: started({ read: 299_000, failed: 40 }) }))[0]).toBe('Other tokens: reading, 1,000 wallets still to read; 40 failed, tried again hourly');
  });

  it('behind: all read, the next lens run takes it in, with no button', () => {
    const c = tokenView({ tokens: started({}, { runTokensRead: 12 }) });
    expect(lines(c)[0]).toBe('Other tokens: read, the next lens run takes it in');
    expect(within(c).queryByRole('button')).toBeNull();
  });

  it('read enough, or reached only by ETH or WETH: nothing to show', () => {
    expect(tokenView({ rule: tokenRule(0), tokens: started({}) }).innerHTML).toBe('');
    cleanup();
    expect(tokenView({ tokens: started({}) }).innerHTML).toBe('');
  });

  it('agrees with tokensReason over a grid of its inputs: a line exactly when it is short, a button exactly when nothing was started', () => {
    for (const isStarted of [false, true]) for (const counts of isStarted ? [null, {}, { read: 5 }, { settled: false }, { payees: true }] : [null, {}]) for (const run of [4, 300_000]) for (const max of [0, 1, 2, null])
      for (const payees of [false, true]) for (const paused of [false, true]) for (const funding of [true, false]) {
        const rule = tokenRule(max);
        const t = { started: isStarted, counts: counts === null ? null : { ...counted, ...counts }, payees, runTokensRead: run, symbols: TOKENS_OFF.symbols };
        const why = tokensReason(rule, t.started, t.counts, t.runTokensRead);
        const c = view({ rule, tokens: t, paused, funding });
        const short = !funding || (why !== null && why !== 'unreached');
        expect(c.querySelectorAll('li').length).toBe(short ? 1 : 0);
        expect(within(c).queryByRole('button') !== null).toBe(funding && why === 'off');
        cleanup();
      }
  // Some 400 renders: about 1 s alone, over 3 s beside the whole web suite, so past the default 5 s it would flake.
  }, 20_000);
});

describe('what the strip says once', () => {
  const short = () => view({ rule: tokenRule(4), money: { ...MONEY, limit: 2 }, tokens: TOKENS_OFF, transfersRead: false });
  const tokenRule = (max: number) => withMax(max, (r) => { r.edges['other-tokens'].use = true; });

  it('Applies to this collection for every lens; Cancel does not undo it. appears once under any action, even with two buttons', () => {
    const c = short();
    expect(within(c).getAllByRole('button').map((b) => b.textContent)).toEqual(['Read money 3 wallets out', 'Read other tokens']);
    expect(occurrences(c, APPLIES)).toBe(1);
    cleanup();
    expect(occurrences(view({ rule: withMax(6) }), APPLIES)).toBe(1);
  });

  it('does not say it where no button shows', () => {
    expect(view({ rule: withMax(6), funding: false }).textContent).not.toContain(APPLIES);
  });

  it('the fan-out caveat appears exactly once when a money or tokens line shows, as the last line but the Watch link, and takes its 25 from the fan-out', () => {
    expect(occurrences(short(), FOLLOW_LINE)).toBe(1);
    cleanup();
    const c = view({ rule: withMax(6), fanout: 40 });
    expect(c.textContent).toContain('sent to more than 40 others');
    expect(occurrences(c, 'washtrace does not follow past a wallet')).toBe(1);
  });

  it('has the Watch another collection link, with how many are watched', () => {
    const c = view({ rule: withMax(6) });
    expect(c.textContent).toContain('6 collections watched');
    expect(within(c).getByRole('link', { name: 'Watch another collection' }).getAttribute('href')).toBe('/');
  });
});
