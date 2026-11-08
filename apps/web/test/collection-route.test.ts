import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RULE } from '@washtrace/detect/lens-rule';

const ADDR = '0x' + 'ab'.repeat(20);
const totals = { available: true, sales: 10, flaggedSales: 1 };
const lens = (id: number, name: string) => ({ id, key: `L${id}`, name, rule: DEFAULT_RULE, version: 1, createdAt: 0, updatedAt: 0 });
/** One that ran (L7, through block 90), one queued, one failed, and one never run here. */
const RUNS = [
  { lens: lens(7, 'Blur 3-hop'), run: { totals: { available: true }, status: 'done', throughBlock: 90, analysisId: 4, lensVersion: 1 } },
  { lens: lens(8, 'Queued'), run: { totals: null, status: 'queued', throughBlock: null, analysisId: null, lensVersion: 1 } },
  { lens: lens(9, 'Failed'), run: { totals: null, status: 'failed', throughBlock: null, analysisId: null, lensVersion: 1, error: 'boom' } },
  { lens: lens(10, 'Never here'), run: null },
];
const fake = {
  collection: vi.fn(async () => ({ id: 1, latest: { id: 4, totals: { A: totals, AU: { available: false }, AC: totals } } })),
  lensRuns: vi.fn(async () => RUNS),
  history: vi.fn(async () => []),
  lensTokens: vi.fn(async (..._a: unknown[]) => ({ rows: [], total: 0 })),
  lensWallets: vi.fn(async (..._a: unknown[]) => ({ rows: [], total: 0 })),
};
vi.mock('@/lib/store', () => ({ store: () => fake }));
vi.mock('next/server', () => ({ connection: async () => {} }));

const { GET } = await import('@/app/api/collections/[chain]/[address]/route');
const ctx = { params: Promise.resolve({ chain: '1', address: ADDR }) };
const get = (method: string) => GET(new Request(`http://x/api/collections/1/${ADDR}?method=${method}`), ctx);

beforeEach(() => vi.clearAllMocks());

describe('GET a collection with ?method=', () => {
  it('selects a lens of yours that exists, and lists it as one that ran', async () => {
    const body = await (await get('L7')).json();
    expect(body.method).toBe('L7');
    expect(fake.lensTokens.mock.calls[0]![1]).toBe('L7');
    expect((fake.lensTokens.mock.calls[0]![3] as { ran: string[] }).ran).toContain('L7');
  });

  it('reads your lens\'s lists only through the block its run read (Ruling FF)', async () => {
    await get('L7');
    expect(fake.lensTokens.mock.calls[0]![3]).toMatchObject({ ran: ['A', 'AC', 'L7'], through: { L7: 90 } });
    expect(fake.lensWallets.mock.calls[0]![3]).toMatchObject({ through: { L7: 90 } });
  });

  it('answers each lens of yours with its run, so a reader tells queued, failed or never run from one that ran and flags nothing (Ruling FF)', async () => {
    const body = await (await get('L7')).json();
    expect(body.lenses).toEqual(JSON.parse(JSON.stringify(RUNS)));
    expect(body.lenses.map((l: { lens: { key: string }; run: { status: string } | null }) => [l.lens.key, l.run?.status ?? null]))
      .toEqual([['L7', 'done'], ['L8', 'queued'], ['L9', 'failed'], ['L10', null]]);
  });

  it('falls back like an unknown method for a deleted or unknown lens', async () => {
    expect((await (await get('L99')).json()).method).toBe('AC');
    expect((await (await get('nonsense')).json()).method).toBe('AC');
  });
});
