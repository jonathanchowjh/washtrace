import { describe, expect, it } from 'vitest';
import type { CollectionRow, PassRow, WorkerConfig } from '@washtrace/detect';
import { status, type Snapshot } from '@/lib/status';

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
    funding: [{ chainId: 1, pending: 3, done: 4, failed: 0, truncated: 0 }],
    config: CONFIG,
    ...more,
  };
}

const stateOf = (s: Snapshot, job: string) => status(s, NOW).jobs.find((j) => j.job === job)!.state;

describe('status', () => {
  it('reports no problems when every job ran lately and every collection is caught up', () => {
    const report = status(snapshot(), NOW);
    expect(report.problems).toEqual([]);
    expect(report.jobs.map((j) => [j.job, j.state])).toEqual([['ingest', 'ok'], ['fund', 'ok'], ['analyze', 'ok']]);
    expect(report.collections[0]).toMatchObject({ name: 'BAYC', behind: 5 });
  });

  it('names a job that has never run', () => {
    const report = status(snapshot({ passes: [] }), NOW);
    expect(report.jobs[0]!.state).toBe('never');
    expect(report.problems).toContain('ingest has never run.');
  });

  it('calls a job running while its pass has started and not finished', () => {
    expect(stateOf(snapshot({ passes: [pass('ingest', 5_000, { finishedAt: NOW - 70_000 })] }), 'ingest')).toBe('running');
  });

  it('calls a job stalled once no pass has started in three intervals and a budget', () => {
    const s = snapshot({ passes: [pass('ingest', 4 * MIN)] });
    expect(stateOf(s, 'ingest')).toBe('stalled');
    expect(status(s, NOW).problems).toContain('ingest has not run for 4 min.');
  });

  it('calls a pass running for ten minutes stalled', () => {
    const s = snapshot({ passes: [pass('analyze', 11 * MIN, { finishedAt: null })] });
    expect(stateOf(s, 'analyze')).toBe('stalled');
    expect(status(s, NOW).problems).toContain('analyze has been running for 11 min.');
  });

  it('reports a failed pass with its message', () => {
    const s = snapshot({ passes: [pass('fund', 1_000, { outcome: 'failed', detail: 'Etherscan answered HTTP 502' })] });
    expect(stateOf(s, 'fund')).toBe('failed');
    expect(status(s, NOW).problems).toContain('fund failed: Etherscan answered HTTP 502');
  });

  it('reports a collection far behind, and one with an error', () => {
    const s = snapshot({ collections: [collection({ cursorBlock: 0 }), collection({ name: null, address: '0xdead', error: 'RPC timed out' })] });
    expect(status(s, NOW).problems).toEqual(['BAYC: 1,000 blocks behind the finalized head.', '1:0xdead: RPC timed out']);
  });

  it('reports funding off, and wallets whose funding failed', () => {
    const s = snapshot({ config: { ...CONFIG, etherscanKey: null }, funding: [{ chainId: 1, pending: 0, done: 1, failed: 2, truncated: 0 }] });
    expect(status(s, NOW).problems).toEqual([
      'Funding is off: set WASHTRACE_ETHERSCAN_KEY. Money loops back and Linked wallets are unavailable.',
      'Ethereum: 2 wallets could not be funded.',
    ]);
  });

  it('shows which chains are configured, never their URLs or the key', () => {
    const report = status(snapshot(), NOW);
    expect(report.config).toEqual({ chains: [1], funding: true });
    expect(JSON.stringify(report)).not.toContain('secret');
  });
});
