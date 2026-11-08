import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RULE, type LensRule } from '@washtrace/detect/lens-rule';
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
const FOLLOW_LINE = 'washtrace does not follow past a wallet that sent to more than 25 others, or whose history was too long to read.';

const view = (over: Partial<Parameters<typeof DataNeeds>[0]> = {}) =>
  render(
    <DataNeeds rule={along(4)} transfers={1_200_000} transfersRead money={MONEY} estimate={null} funding perSecond={4} watched={6} writable
      chainId={1} address={ADDR} followHops={3} fanout={25} callsPerWallet={4} behind={false} paused={false} {...over} />,
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

  it('Other tokens reads not read and off in this lens, with no button in this slice', () => {
    const r = row(view(), 'Other tokens');
    expect(r.textContent).toContain('Not read: washtrace has never fetched them');
    expect(r.textContent).toContain('Off in this lens');
    expect(within(r).queryByRole('button')).toBeNull();
  });
});
