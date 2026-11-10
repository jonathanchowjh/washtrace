import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RULE, ruleLine, type LensRule } from '@washtrace/detect/lens-rule';
import { needsWords } from '@/lib/lens-state';

const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40);
const lens = { id: 7, key: 'L7', name: 'Blur 3-hop', rule: DEFAULT_RULE, version: 1, createdAt: 0, updatedAt: 0 };
const done = { status: 'done', totals: { sales: 200, flaggedSales: 25 }, lensVersion: 1, analysisId: 4, throughBlock: 9, progress: null, tokensRead: null };
const coll = (id: number, address: string, name: string) => ({ id, chainId: 1, address, name, latest: { id: 4 }, stale: false, readTokens: false });
const state = { lenses: [{ lens, runs: new Map<number, object>([[1, done]]) }] as { lens: typeof lens; runs: Map<number, object> }[], fail: false };
vi.mock('@/lib/store', () => ({
  store: () => ({
    lensRunsAll: async () => { if (state.fail) throw new Error('down'); return state.lenses; },
    collections: async () => [coll(1, A, 'Demo Apes'), coll(2, B, 'Cats')],
    sources: async () => ({}), settings: async () => new Map(),
    moneyRead: async () => ({ limit: 2, pendingByDepth: {}, seeding: false }),
    tokenCounts: async () => null,
  }),
}));
vi.mock('next/server', () => ({ connection: async () => {} }));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ host: 'localhost:8080' }) }));
const push = vi.fn(), refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));

afterEach(() => { cleanup(); state.fail = false; state.lenses = [{ lens, runs: new Map<number, object>([[1, done]]) }]; });

async function lab() {
  const { default: Page } = await import('@/app/lab/page');
  return render(await Page()).container;
}

describe('the Lab', () => {
  it('lists each lens with a row per watched collection: its share where it ran, not run where it did not', async () => {
    const c = await lab();
    expect(c.querySelector('h2')?.textContent).toBe('Blur 3-hop');
    const rows = [...c.querySelectorAll('tbody tr')].map((r) => r.textContent);
    expect(rows[0]).toContain('Demo Apes');
    expect(rows[0]).toContain('12.5% of sales');
    expect(rows[1]).toContain('not run here');
    // Its share opens its tab on that collection; its editor, with Preview, is there too.
    const links = [...c.querySelectorAll('tbody tr')[0]!.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(links).toContain(`/c/1/${A}/methods?method=L7#evidence`);
    expect(links).toContain(`/c/1/${A}/methods?method=L7&lens=edit-L7`);
  });

  it('says how to write a first lens, where its preview can run', async () => {
    state.lenses = [];
    const c = await lab();
    expect(c.textContent).toContain('No lens of yours yet.');
    expect([...c.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toContain(`/c/1/${A}/methods?method=AC&lens=new`);
  });

  it('says the store is down rather than that there are no lenses', async () => {
    state.fail = true;
    expect((await lab()).textContent).toContain('It could not read your lenses.');
  });
});

describe('Runs on', () => {
  it('queues the lens on each collection ticked, then refreshes', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 202, json: async () => ({ queued: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    const { RunsOn } = await import('@/components/runs-on');
    const row = (address: string, name: string) => ({ chainId: 1, address, name, tab: '/t', edit: '/e', state: 'not run here', share: null, needs: null, busy: false });
    render(<RunsOn lensId={7} rows={[row(A, 'Demo Apes'), row(B, 'Cats')]} writable />);
    fireEvent.click(screen.getByLabelText('Run on Demo Apes'));
    fireEvent.click(screen.getByLabelText('Run on Cats'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Run on 2 collections' })); });
    expect(fetchMock.mock.calls.map((c) => [String(c[0]), JSON.parse(String(c[1]!.body)).address])).toEqual([['/api/lenses/7/runs', A], ['/api/lenses/7/runs', B]]);
    expect(refresh).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('stops at a run it cannot queue, says which, and keeps it and those after it ticked', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: 'Not a watched collection.' }) }));
    vi.stubGlobal('fetch', fetchMock);
    const { RunsOn } = await import('@/components/runs-on');
    const row = (address: string, name: string) => ({ chainId: 1, address, name, tab: '/t', edit: '/e', state: 'not run here', share: null, needs: null, busy: false });
    render(<RunsOn lensId={7} rows={[row(A, 'Demo Apes'), row(B, 'Cats')]} writable />);
    fireEvent.click(screen.getByLabelText('Run on Demo Apes'));
    fireEvent.click(screen.getByLabelText('Run on Cats'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Run on 2 collections' })); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Demo Apes: Not a watched collection\. Those still ticked are not queued\./)).toBeTruthy();
    expect([A, B].map((a) => (screen.getByLabelText(a === A ? 'Run on Demo Apes' : 'Run on Cats') as HTMLInputElement).checked)).toEqual([true, true]);
    vi.unstubAllGlobals();
  });
});

describe('the rule picture', () => {
  beforeEach(() => cleanup());
  const draw = async (rule: LensRule) => { const { RulePicture } = await import('@/components/rule-picture'); return render(<RulePicture rule={rule} />).container; };

  it('is named by the rule\'s words, and draws an optional wallet dashed', async () => {
    const c = await draw({ ...DEFAULT_RULE, hops: { min: 1, max: 2 } });
    expect(c.querySelector('svg')?.getAttribute('aria-label')).toBe(ruleLine({ ...DEFAULT_RULE, hops: { min: 1, max: 2 } }));
    const between = [...c.querySelectorAll('circle')].slice(2);
    expect(between.map((x) => x.hasAttribute('stroke-dasharray'))).toEqual([false, true]);
  });

  it('draws the way back dashed for money alone, solid for NFT alone', async () => {
    const only = (money: boolean): LensRule => ({ ...DEFAULT_RULE, edges: Object.fromEntries(Object.entries(DEFAULT_RULE.edges).map(([k, e]) => [k, { ...e, use: money ? ['eth'].includes(k) : k === 'nft-token' }])) as LensRule['edges'] });
    const back = (c: Element) => c.querySelectorAll('path')[2]!.getAttribute('stroke-dasharray');
    expect(back(await draw(only(true)))).toBe('4 3');
    cleanup();
    expect(back(await draw(only(false)))).toBeNull();
  });
});

describe('what a lens still needs', () => {
  it('says money and other tokens apart, and nothing when all is read', () => {
    expect(needsWords('limit', 'off')).toBe('money read further out than this collection follows; other tokens, not read here');
    expect(needsWords(null, null)).toBeNull();
  });
});
