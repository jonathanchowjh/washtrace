import { describe, expect, it } from 'vitest';
import type { CollectionRow, PassRow } from '@washtrace/detect';
import { status, type Notice, type Snapshot } from '@/lib/status';
import { eta, localTime } from '@/lib/format';

const NOW = 1_800_000_000_000;
const MIN = 60_000;

function pass(job: string, startedAgo: number, more: Partial<PassRow> = {}): PassRow {
  return { job, startedAt: NOW - startedAgo, finishedAt: NOW - startedAgo + 1_000, tookMs: 1_000, outcome: 'ok', detail: 'fine', heartbeatAt: null, doing: null, subjectId: null, ...more };
}

function collection(more: Partial<CollectionRow> = {}): CollectionRow {
  return {
    id: 1, chainId: 1, address: '0xbc4c', name: 'BAYC', startBlock: 100, cursorBlock: 995, headBlock: 1_000,
    addedAt: NOW, ingestedAt: NOW, error: null, errorAt: null, transfers: 10, wallets: 4, fundedWallets: 4,
    stale: false, latest: null, servedAt: null, readRate: null, priority: false, pausedAt: null, rules: {}, contract: null,
    restoreProgress: null, restoreNote: null, storedThroughTime: null, storedThroughBlock: null, trailImportedSha: null, trailNote: null, ...more,
  };
}

// What the worker reported, as configFromSources reads it: chain ids and whether funding is on, never a URL or the key.
const CONFIG: Snapshot['config'] = { chains: [1], funding: true, perSecond: 4, followHops: 3 };

function snapshot(more: Partial<Snapshot> = {}): Snapshot {
  return {
    passes: [pass('analyze', 10_000), pass('fund', 2_000), pass('ingest', 10_000)],
    collections: [collection()],
    funding: [{ chainId: 1, pending: 3, done: 4, failed: 0, truncated: 0, doneLastHour: 0 }],
    config: CONFIG,
    trailFunded: false,
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

  it('names and links the collection whose analysis failed', () => {
    const s = snapshot({ passes: [pass('analyze', 1_000, { outcome: 'failed', detail: 'out of memory', subjectId: 1 }), pass('fund', 2_000), pass('ingest', 10_000)] });
    const n = status(s, NOW).notices.find((x) => x.severity === 'needs-you');
    expect(n).toEqual({
      severity: 'needs-you', text: 'Analysis of BAYC failed: out of memory',
      doThis: 'Open BAYC and check its rules. It is tried again after a wait, and the other collections are analysed meanwhile.', href: '/c/1/0xbc4c',
    });
    // A collection no longer watched: the job's own words, as before.
    const gone = snapshot({ passes: [pass('analyze', 1_000, { outcome: 'failed', detail: 'out of memory', subjectId: 9 }), pass('fund', 2_000), pass('ingest', 10_000)] });
    expect(texts(gone, 'needs-you')).toEqual(['analyze failed: out of memory']);
  });

  it('says a paused collection is paused, and does not call it behind or check its wallets', () => {
    const s = snapshot({
      collections: [collection({ cursorBlock: 0, wallets: 10, fundedWallets: 2, pausedAt: NOW })],
    });
    expect(status(s, NOW).collections[0]).toMatchObject({ turn: 'paused' });
    expect(texts(s, 'working')).toEqual([]);
  });

  it('reports a collection with an error as needing a person, and one far behind as work in progress', () => {
    const s = snapshot({ collections: [collection({ cursorBlock: 0 }), collection({ name: null, address: '0xdead', error: 'RPC timed out' })] });
    expect(texts(s, 'needs-you')).toEqual(['1:0xdead: RPC timed out']);
    expect(texts(s, 'working')).toEqual(['BAYC: 1,000 blocks behind the finalized head.']);
    expect(status(s, NOW).collections[0]).toMatchObject({ turn: 'backfilling' });
  });

  it('says a collection loading stored data is loading it, not behind', () => {
    const s = snapshot({ collections: [collection({ cursorBlock: null, startBlock: null, restoreProgress: 0.42 })] });
    expect(status(s, NOW).collections[0]).toMatchObject({ turn: 'restoring' });
    expect(texts(s, 'working')).toEqual(['Loading stored data for BAYC · 42%']);
    expect(texts(s, 'needs-you')).toEqual([]);
  });

  it('says why stored data was not loaded as information, not a fault: the worker reads the chain instead', () => {
    const note = 'Stored data could not be loaded (checksum differs); reading from the chain instead.';
    const s = snapshot({ collections: [collection({ restoreNote: note })] });
    expect(texts(s, 'info')).toContain(`BAYC: ${note}`);
    expect(texts(s, 'needs-you')).toEqual([]);
  });

  it('calls a paused collection paused even with a load\'s progress left over', () => {
    const s = snapshot({ collections: [collection({ restoreProgress: 0.5, pausedAt: NOW })] });
    expect(status(s, NOW).collections[0]).toMatchObject({ turn: 'paused' });
  });

  it('says funding off is a choice, not a fault', () => {
    const r = status(snapshot({ config: { ...CONFIG, funding: false } }), NOW);
    expect(r.notices.filter((n) => n.severity === 'needs-you')).toEqual([]);
    expect(r.notices).toContainEqual(expect.objectContaining({ severity: 'info', action: expect.objectContaining({ href: '/settings#etherscan.key' }) }));
  });

  it('never calls the money lenses unavailable with funding off when a collection loaded a stored money trail', () => {
    const off = { ...CONFIG, funding: false };
    expect(texts(snapshot({ config: off }), 'info')).toContain('Funding is off, so Money loops back and Linked wallets are unavailable.');
    const text = texts(snapshot({ config: off, collections: [collection({ trailImportedSha: 'feed' })], trailFunded: true }), 'info').find((t) => t.startsWith('Funding is off'));
    expect(text).toBe('Funding is off: Money loops back and Linked wallets run on stored money trails only, and newer wallets go unchecked.');
  });

  it('asks whether a trail feeds the money lenses as the worker page and Settings do, not whether one loaded', () => {
    // Loaded, but it checked no wallet: the money lenses do not run on it.
    const s = snapshot({ config: { ...CONFIG, funding: false }, collections: [collection({ trailImportedSha: 'feed' })], trailFunded: false });
    expect(texts(s, 'info')).toContain('Funding is off, so Money loops back and Linked wallets are unavailable.');
  });

  it('counts a backfill as work in progress with an ETA', () => {
    const r = status(snapshot({ collections: [collection({ cursorBlock: 0, headBlock: 36_000, readRate: 10 })] }), NOW);
    expect(r.notices).toContainEqual(expect.objectContaining({ severity: 'working', text: expect.stringContaining('about 1 h left') }));
  });

  it('gives no ETA while the read rate is unknown', () => {
    expect(texts(snapshot({ collections: [collection({ cursorBlock: 0, readRate: null })] }), 'working')).toEqual(['BAYC: 1,000 blocks behind the finalized head.']);
  });

  it('reports wallets whose funding failed as needing a person once none is checked any more', () => {
    const s = snapshot({ funding: [{ chainId: 1, pending: 0, done: 1, failed: 2, truncated: 0, doneLastHour: 0 }] });
    expect(texts(s, 'needs-you')).toEqual(['Ethereum: 2 wallets could not be checked for money, and none was checked in the last hour.']);
    expect(status(s, NOW).notices[0]).toMatchObject({ href: '/settings#etherscan.key' });
  });

  it('reports a few failed wallets among wallets being checked as retrying on their own, not as a fault', () => {
    const s = snapshot({ funding: [{ chainId: 1, pending: 10, done: 100, failed: 2, truncated: 0, doneLastHour: 50 }] });
    expect(texts(s, 'needs-you')).toEqual([]);
    expect(texts(s, 'working')).toContain('Ethereum: 2 wallets could not be checked for money; they retry on their own after an hour.');
    // With funding off nothing retries them, and the funding-off notice says why.
    const off = snapshot({ config: { ...CONFIG, funding: false }, funding: [{ chainId: 1, pending: 0, done: 1, failed: 2, truncated: 0, doneLastHour: 0 }] });
    expect(status(off, NOW).notices.some((n) => n.text.includes('could not be checked'))).toBe(false);
  });

  it('says the error of a paused collection as information: the worker does not touch it until it resumes', () => {
    const s = snapshot({ collections: [collection({ pausedAt: NOW, error: 'RPC timed out' }), collection({ address: '0xbeef', chainId: 8453, pausedAt: NOW, error: 'No RPC is configured for chain 8453.' })] });
    expect(texts(s, 'needs-you')).toEqual([]);
    expect(texts(s, 'info')).toEqual(expect.arrayContaining(['BAYC: Paused · last error before the pause: RPC timed out', 'BAYC: Paused · last error before the pause: No RPC is configured for chain 8453.']));
  });

  it('sends a collection failing for want of an RPC to its setting, not to the collection', () => {
    const s = snapshot({ config: { ...CONFIG, chains: [] }, collections: [collection({ error: 'No RPC is configured for chain 1. Set WASHTRACE_RPC_1.' })] });
    expect(status(s, NOW).notices.find((n) => n.severity === 'needs-you')).toMatchObject({ doThis: expect.stringContaining('Ethereum RPC URL'), href: '/settings#rpc.1' });
  });

  it('says where to set an RPC for a chain the console has no field for', () => {
    const s = snapshot({ config: { ...CONFIG, chains: [] }, collections: [collection({ chainId: 8453, error: 'No RPC is configured for chain 8453.' })] });
    const n = status(s, NOW).notices.find((x) => x.severity === 'needs-you');
    expect(n).toMatchObject({ doThis: expect.stringContaining('WASHTRACE_RPC_8453') });
    expect(n && 'href' in n ? n.href : undefined).toBeUndefined();
  });

  describe('stored data with no RPC', () => {
    // Restored: cursor at the stored throughBlock, no head without an RPC, and the worker's old "No RPC" error not yet cleared.
    const stored = (more: Partial<CollectionRow> = {}) => collection({
      headBlock: null, cursorBlock: 900, storedThroughTime: Date.UTC(2026, 9, 14), storedThroughBlock: 900, error: 'No RPC is configured for chain 1. Set it in Settings, or WASHTRACE_RPC_1 for the worker.', ...more,
    });
    const none = (c: CollectionRow) => snapshot({ config: { ...CONFIG, chains: [] }, collections: [c] });
    // Built on the server, so in a pinned locale; the date from the app's own formatter, never hard-coded.
    const DAY = localTime(Date.UTC(2026, 9, 14), 'date', 'UTC', 'en-GB');

    it('says it shows stored data only, as information with the way to read on, never as a fault', () => {
      const report = status(none(stored()), NOW);
      expect(report.collections[0]).toMatchObject({ turn: 'stored-only' });
      expect(report.notices).toContainEqual({ severity: 'info', text: `BAYC shows stored data only. Set an RPC to continue from ${DAY}.`, action: { label: 'Open Settings', href: '/settings#rpc.1' } });
      expect(texts(none(stored()), 'needs-you')).toEqual([]);
    });

    it('names the environment variable for a chain the console has no field for', () => {
      const n = status(none(stored({ chainId: 8453 })), NOW).notices.find((x) => x.text.startsWith('BAYC shows stored data only'));
      expect(n).toEqual({ severity: 'info', text: `BAYC shows stored data only. Set WASHTRACE_RPC_8453 for the worker to continue from ${DAY}.` });
    });

    it('says the block it was read to, with no stored date, once read past the stored data', () => {
      const report = status(none(stored({ cursorBlock: 1_250_000 })), NOW);
      expect(report.collections[0]).toMatchObject({ turn: 'stored-only' });
      expect(report.notices).toContainEqual({ severity: 'info', text: 'BAYC is read to block 1,250,000 and its chain has no RPC. Set an RPC to continue from block 1,250,000.', action: { label: 'Open Settings', href: '/settings#rpc.1' } });
    });

    it('calls a paused one paused, and says nothing of its stored data', () => {
      const report = status(none(stored({ pausedAt: 5 })), NOW);
      expect(report.collections[0]).toMatchObject({ turn: 'paused' });
      expect(report.notices.some((n) => n.text.includes('stored data only'))).toBe(false);
    });

    it('is read as usual once its chain has an RPC', () => {
      expect(status(snapshot({ collections: [stored({ error: null })] }), NOW).collections[0]!.turn).not.toBe('stored-only');
    });
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
      expect(texts(snapshot({ collections: [half()], config: { ...CONFIG, funding: false } }), 'working')).toEqual([]);
    });
  });

  it('orders notices needs-you, working, info', () => {
    const s = snapshot({ config: { ...CONFIG, funding: false }, collections: [collection({ cursorBlock: 0 }), collection({ address: '0xdead', error: 'boom' })] });
    expect(status(s, NOW).notices.map((n) => n.severity)).toEqual(['needs-you', 'working', 'info']);
  });

  it('gives every needs-you notice a sentence saying what to do', () => {
    const s = snapshot({
      passes: [pass('ingest', 10_000, { outcome: 'failed' }), pass('fund', 10_000, { outcome: 'failed' }), pass('analyze', 10_000, { outcome: 'failed' })],
      collections: [collection({ error: 'boom' })],
      funding: [{ chainId: 1, pending: 3, done: 4, failed: 2, truncated: 0, doneLastHour: 0 }],
    });
    const needs = status(s, NOW).notices.filter((n) => n.severity === 'needs-you');
    expect(needs).toHaveLength(5);
    for (const n of needs) expect(n.severity === 'needs-you' && n.doThis.length > 10).toBe(true);
    expect(needs).toContainEqual(expect.objectContaining({ doThis: expect.stringContaining('Etherscan key'), href: '/settings#etherscan.key' }));
    expect(needs).toContainEqual(expect.objectContaining({ doThis: expect.stringContaining('RPC'), href: '/settings#rpc.1' }));
    expect(needs).toContainEqual(expect.objectContaining({ href: '/c/1/0xbc4c' }));
    const never = status(snapshot({ passes: [] }), NOW).notices.filter((n) => n.severity === 'needs-you');
    expect(never.every((n) => n.severity === 'needs-you' && n.doThis.includes('docker compose ps worker'))).toBe(true);
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
