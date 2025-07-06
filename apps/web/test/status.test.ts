import { describe, expect, it } from 'vitest';
import type { CollectionRow, PassRow, WorkerConfig } from '@washtrace/detect';
import { status, type Notice, type Snapshot } from '@/lib/status';
import { eta } from '@/lib/format';

const NOW = 1_800_000_000_000;
const MIN = 60_000;

function pass(job: string, startedAgo: number, more: Partial<PassRow> = {}): PassRow {
  return { job, startedAt: NOW - startedAgo, finishedAt: NOW - startedAgo + 1_000, tookMs: 1_000, outcome: 'ok', detail: 'fine', heartbeatAt: null, doing: null, subjectId: null, ...more };
}

function collection(more: Partial<CollectionRow> = {}): CollectionRow {
  return {
    id: 1, chainId: 1, address: '0xbc4c', name: 'BAYC', startBlock: 100, cursorBlock: 995, headBlock: 1_000,
    addedAt: NOW, ingestedAt: NOW, error: null, errorAt: null, transfers: 10, wallets: 4, fundedWallets: 4,
    stale: false, latest: null, servedAt: null, readRate: null, priority: false, rules: {}, contract: null, ...more,
  };
}

const CONFIG: WorkerConfig = { rpc: new Map([[1, 'https://secret.example/key']]), etherscanKey: 'secret', etherscanPerSecond: 4, etherscanUrl: 'https://api.etherscan.io/v2/api', followHops: 3 };

function snapshot(more: Partial<Snapshot> = {}): Snapshot {
  return {
    passes: [pass('analyze', 10_000), pass('fund', 2_000), pass('ingest', 10_000)],
    collections: [collection()],
    funding: [{ chainId: 1, pending: 3, done: 4, failed: 0, truncated: 0, doneLastHour: 0 }],
    config: CONFIG,
    ...more,
  };
}

const texts = (s: Snapshot, severity: Notice['severity']) => status(s, NOW).notices.filter((n) => n.severity === severity).map((n) => n.text);
const stateOf = (s: Snapshot, job: string) => status(s, NOW).jobs.find((j) => j.job === job)!.state;

describe('status', () => {
  it('reports no problems when every job ran lately and every collection is caught up', () => {
    const report = status(snapshot(), NOW);
    expect(report.notices.filter((n) => n.severity !== 'info')).toEqual([]);
    expect(report.collections[0]).toMatchObject({ turn: 'keeping-up' });
    expect(report.jobs.map((j) => [j.job, j.state])).toEqual([['ingest', 'ok'], ['fund', 'ok'], ['analyze', 'ok']]);
    expect(report.collections[0]).toMatchObject({ name: 'BAYC', behind: 5 });
  });

  it('names a job that has never run', () => {
    const report = status(snapshot({ passes: [] }), NOW);
    expect(report.jobs[0]!.state).toBe('never');
    expect(texts(snapshot({ passes: [] }), 'needs-you')).toContain('ingest has never run.');
  });

  it('calls a job running while its pass has started and not finished', () => {
    expect(stateOf(snapshot({ passes: [pass('ingest', 5_000, { finishedAt: NOW - 70_000 })] }), 'ingest')).toBe('running');
  });

  it('calls a job stalled once no pass has started in three intervals and a budget', () => {
    const s = snapshot({ passes: [pass('ingest', 4 * MIN)] });
    expect(stateOf(s, 'ingest')).toBe('stalled');
    expect(texts(s, 'needs-you')).toContain('ingest has not run for 4 min.');
  });

  it('calls a long pass with a fresh heartbeat running', () => {
    expect(stateOf(snapshot({ passes: [pass('analyze', 14 * MIN, { finishedAt: null, heartbeatAt: NOW - 20_000 })] }), 'analyze')).toBe('running');
  });
  it('calls a pass stalled when its heartbeat is two minutes old', () => {
    expect(stateOf(snapshot({ passes: [pass('analyze', 14 * MIN, { finishedAt: null, heartbeatAt: NOW - 3 * MIN })] }), 'analyze')).toBe('stalled');
  });

  it('reports a failed pass with its message', () => {
    const s = snapshot({ passes: [pass('fund', 1_000, { outcome: 'failed', detail: 'Etherscan answered HTTP 502' })] });
    expect(stateOf(s, 'fund')).toBe('failed');
    expect(texts(s, 'needs-you')).toContain('fund failed: Etherscan answered HTTP 502');
  });

  it('reports a collection with an error as needing a person, and one far behind as work in progress', () => {
    const s = snapshot({ collections: [collection({ cursorBlock: 0 }), collection({ name: null, address: '0xdead', error: 'RPC timed out' })] });
    expect(texts(s, 'needs-you')).toEqual(['1:0xdead: RPC timed out']);
    expect(texts(s, 'working')).toEqual(['BAYC: 1,000 blocks behind the finalized head.']);
    expect(status(s, NOW).collections[0]).toMatchObject({ turn: 'backfilling' });
  });

  it('says funding off is a choice, not a fault', () => {
    const r = status(snapshot({ config: { ...CONFIG, etherscanKey: null } }), NOW);
    expect(r.notices.filter((n) => n.severity === 'needs-you')).toEqual([]);
    expect(r.notices).toContainEqual(expect.objectContaining({ severity: 'info', action: expect.objectContaining({ href: '/worker#sources' }) }));
  });

  it('counts a backfill as work in progress with an ETA', () => {
    const r = status(snapshot({ collections: [collection({ cursorBlock: 0, headBlock: 36_000, readRate: 10 })] }), NOW);
    expect(r.notices).toContainEqual(expect.objectContaining({ severity: 'working', text: expect.stringContaining('about 1 h left') }));
  });

  it('gives no ETA while the read rate is unknown', () => {
    expect(texts(snapshot({ collections: [collection({ cursorBlock: 0, readRate: null })] }), 'working')).toEqual(['BAYC: 1,000 blocks behind the finalized head.']);
  });

  it('reports wallets whose funding failed as needing a person', () => {
    const s = snapshot({ funding: [{ chainId: 1, pending: 0, done: 1, failed: 2, truncated: 0, doneLastHour: 0 }] });
    expect(texts(s, 'needs-you')).toEqual(['Ethereum: 2 wallets could not be funded.']);
  });

  describe('checking wallets', () => {
    const funding = (doneLastHour: number) => [{ chainId: 1, pending: 1_000, done: 1_000, failed: 0, truncated: 0, doneLastHour }];
    const half = (more: Partial<CollectionRow> = {}) => collection({ wallets: 2_000, fundedWallets: 1_000, ...more });

    it('says how far along a collection is, with an ETA', () => {
      expect(texts(snapshot({ collections: [half()], funding: funding(1_000) }), 'working')).toEqual(['Checking wallets for BAYC: 1,000 of 2,000 · about 1 h left']);
    });
    it('leaves the ETA out until the worker has finished some', () => {
      expect(texts(snapshot({ collections: [half()], funding: funding(0) }), 'working')).toEqual(['Checking wallets for BAYC: 1,000 of 2,000']);
    });
    it('splits a chain\'s rate between the collections still checking', () => {
      const s = snapshot({ collections: [half(), half({ name: 'Other', address: '0xbeef' }), collection({ address: '0xdone' })], funding: funding(1_000) });
      expect(texts(s, 'working')).toEqual(['Checking wallets for BAYC: 1,000 of 2,000 · about 2 h left', 'Checking wallets for Other: 1,000 of 2,000 · about 2 h left']);
    });
    it('says nothing about it when funding is off', () => {
      expect(texts(snapshot({ collections: [half()], config: { ...CONFIG, etherscanKey: null } }), 'working')).toEqual([]);
    });
  });

  it('orders notices needs-you, working, info', () => {
    const s = snapshot({ config: { ...CONFIG, etherscanKey: null }, collections: [collection({ cursorBlock: 0 }), collection({ address: '0xdead', error: 'boom' })] });
    expect(status(s, NOW).notices.map((n) => n.severity)).toEqual(['needs-you', 'working', 'info']);
  });

  it('estimates the funding wait from the last hour of work', () => {
    const f = (doneLastHour: number, pending = 50) => status(snapshot({ funding: [{ chainId: 1, pending, done: 4, failed: 0, truncated: 0, doneLastHour }] }), NOW).funding[0]!.etaMs;
    expect(f(100)).toBe(30 * MIN);
    expect(f(0)).toBeNull();
    expect(f(100, 0)).toBeNull();
  });

  it('writes a wait as minutes, hours or days', () => {
    expect([40 * MIN, 10 * 60 * MIN, 3 * 24 * 60 * MIN].map(eta)).toEqual(['about 40 min left', 'about 10 h left', 'about 3 days left']);
  });

  it('shows which chains are configured, never their URLs or the key', () => {
    const report = status(snapshot(), NOW);
    expect(report.config).toEqual({ chains: [1], funding: true });
    expect(JSON.stringify(report)).not.toContain('secret');
  });
});
