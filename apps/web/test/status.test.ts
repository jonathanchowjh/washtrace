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
    restoreProgress: null, restoreNote: null, restoreNoteKey: null, restoreRetryAt: null, analysisError: null, analysisRetryAt: null, storedThroughTime: null, storedThroughBlock: null, trailImportedSha: null, trailNote: null,
    downloadFile: null, downloadProgress: null, downloadNote: null, downloadRetryAt: null, ...more,
  };
}

// What the worker reported, as configFromSources reads it: chain ids and whether funding is on, never a URL or the key.
const CONFIG: Snapshot['config'] = { chains: [1], funding: true, perSecond: 4, followHops: 3 };

function snapshot(more: Partial<Snapshot> = {}): Snapshot {
  return {
    passes: [pass('analyze', 10_000), pass('fund', 2_000), pass('ingest', 10_000)],
    collections: [collection()],
    funding: [{ chainId: 1, pending: 3, done: 4, failed: 0, stranded: 0, truncated: 0, doneLastHour: 0 }],
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

  it('calls a job stalled once no pass has finished in three intervals and a budget', () => {
    const s = snapshot({ passes: [pass('ingest', 4 * MIN + 1_000)] });
    expect(stateOf(s, 'ingest')).toBe('stalled');
    expect(texts(s, 'needs-you')).toContain('ingest has not run for 4 min.');
  });

  it('measures a finished pass from when it finished, so a long pass that has just ended is not stalled', () => {
    const s = snapshot({ passes: [pass('analyze', 17 * MIN + 30_000, { finishedAt: NOW - 30_000, tookMs: 17 * MIN }), pass('fund', 2_000), pass('ingest', 10_000)] });
    expect(stateOf(s, 'analyze')).toBe('ok');
    expect(texts(s, 'needs-you')).toEqual([]);
  });

  it('shows a long pass\'s failure, and that it has not run since as well once it is overdue', () => {
    const failed = (finishedAgo: number) => snapshot({
      passes: [pass('analyze', 10_000), pass('fund', 2_000), pass('ingest', 17 * MIN + finishedAgo, { finishedAt: NOW - finishedAgo, tookMs: 17 * MIN, outcome: 'failed', detail: 'RPC answered HTTP 429' })],
    });
    expect(stateOf(failed(30_000), 'ingest')).toBe('failed');
    expect(texts(failed(30_000), 'needs-you')).toEqual(['ingest failed: RPC answered HTTP 429']);
    expect(stateOf(failed(5 * MIN), 'ingest')).toBe('stalled');
    expect(texts(failed(5 * MIN), 'needs-you')).toEqual(['ingest failed: RPC answered HTTP 429', 'ingest has not run for 5 min.']);
    // The worker page colours what the pass said by how it ended, not by the job's state.
    expect(status(failed(5 * MIN), NOW).jobs.find((j) => j.job === 'ingest')).toMatchObject({ outcome: 'failed', detail: 'RPC answered HTTP 429' });
  });

  it('calls a pass stuck once it has run past its job\'s ceiling, however fresh its heartbeat', () => {
    const running = (job: string, ago: number) => snapshot({
      passes: [pass('analyze', 10_000), pass('fund', 2_000), pass('ingest', 10_000)].map((p) => p.job === job ? pass(job, ago, { finishedAt: null, heartbeatAt: NOW - 10_000 }) : p),
    });
    const s = running('analyze', 75 * MIN);
    expect(stateOf(s, 'analyze')).toBe('stalled');
    expect(status(s, NOW).notices.filter((n) => n.severity === 'needs-you')).toEqual([
      { severity: 'needs-you', text: 'analyze has been running for 75 min.', doThis: 'Restart the worker: docker compose restart worker' },
    ]);
    // An analysis can take most of an hour, a load of stored data many minutes, a funding pass not ten.
    for (const [job, ceiling] of [['analyze', 70], ['ingest', 30], ['fund', 10]] as const) {
      expect(stateOf(running(job, ceiling * MIN - 1_000), job)).toBe('running');
      expect(stateOf(running(job, ceiling * MIN + 1_000), job)).toBe('stalled');
    }
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

  it('names and links a collection whose analysis failed, while it does, even after a later pass went through', () => {
    const at = NOW + 20 * MIN;
    const failing = collection({ analysisError: 'out of memory', analysisRetryAt: at });
    // The latest analyze pass was another collection's, and went through.
    const s = snapshot({ collections: [failing] });
    expect(status(s, NOW, 'Asia/Tokyo').notices.filter((n) => n.severity === 'needs-you')).toEqual([{
      severity: 'needs-you', text: 'Analysis of BAYC failed: out of memory',
      doThis: `Wait: it is tried again after ${localTime(at, 'time', 'Asia/Tokyo', 'en-GB')}, while the other collections are analysed. If it keeps failing, check the worker's log: docker compose logs worker`,
      href: '/c/1/0xbc4c',
    }]);
    // No page shows a collection's rules: never sent to check them.
    expect(JSON.stringify(status(s, NOW).notices)).not.toContain('rules');
    // Its wait over, it is due, and waits only for the analysis thread.
    const due = status(snapshot({ collections: [collection({ analysisError: 'out of memory', analysisRetryAt: NOW - MIN })] }), NOW).notices.find((n) => n.severity === 'needs-you')!;
    expect(due).toMatchObject({ doThis: "Wait: it is due to be tried again, while the other collections are analysed. If it keeps failing, check the worker's log: docker compose logs worker" });
  });

  it('says the failed analysis once, on the collection, when the failed pass was its own', () => {
    const s = snapshot({
      passes: [pass('analyze', 1_000, { outcome: 'failed', detail: 'out of memory', subjectId: 1 }), pass('fund', 2_000), pass('ingest', 10_000)],
      collections: [collection({ analysisError: 'out of memory', analysisRetryAt: NOW + 5 * MIN })],
    });
    expect(stateOf(s, 'analyze')).toBe('failed');
    expect(texts(s, 'needs-you')).toEqual(['Analysis of BAYC failed: out of memory']);
  });

  it('says an analyze pass that failed with no collection to show it on as the job\'s own failure, sent to the log', () => {
    // Failed before it took a collection, or on one since removed.
    for (const subjectId of [null, 9]) {
      const s = snapshot({ passes: [pass('analyze', 1_000, { outcome: 'failed', detail: 'connection lost', subjectId }), pass('fund', 2_000), pass('ingest', 10_000)] });
      expect(status(s, NOW).notices.filter((n) => n.severity === 'needs-you')).toEqual([
        { severity: 'needs-you', text: 'analyze failed: connection lost', doThis: "Check the worker's log: docker compose logs worker" },
      ]);
    }
  });

  it('says a paused collection\'s failed analysis as information: nothing tries it until it is resumed', () => {
    const s = snapshot({ collections: [collection({ analysisError: 'out of memory', analysisRetryAt: NOW + 5 * MIN, pausedAt: NOW })] });
    expect(texts(s, 'needs-you')).toEqual([]);
    expect(texts(s, 'info')).toContain('BAYC: Paused · its last analysis before the pause failed: out of memory');
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

  it('says which collection is downloading which file and how far', () => {
    const manifest = { version: 2 as const, collections: [{ chainId: 1, address: '0xBC4C', name: 'BAYC', startBlock: 1, throughBlock: 2, throughTime: 3, transfers: { file: 'a', rows: 1, bytes: 12_300_000, sha256: 'x' }, trail: { rows: 1, wallets: 1, checked: 1, of: 1, bytes: 3_400_000_000, sha256: 'y' } }] };
    const run = (more: Partial<CollectionRow>) => texts(snapshot({ collections: [collection(more)], manifest }), 'working');
    expect(run({ downloadFile: 'transfers', downloadProgress: 0.416 })).toEqual(['Downloading stored data for BAYC · 41% of 12.3 MB']);
    expect(run({ downloadFile: 'trail', downloadProgress: 0.05 })).toEqual(['Downloading the money trail for BAYC · 5% of 3.4 GB']);
    // Paused, nothing downloads; no manifest, no size to say.
    expect(run({ downloadFile: 'trail', downloadProgress: 0.05, pausedAt: 1 })).toEqual([]);
    expect(texts(snapshot({ collections: [collection({ downloadFile: 'transfers', downloadProgress: 0.416 })] }), 'working')).toEqual(['Downloading stored data for BAYC · 41%']);
  });

  it('says a failed download as information, not a fault', () => {
    const s = snapshot({ collections: [collection({ downloadNote: 'Stored data could not be downloaded. Tried again later.' })] });
    expect(texts(s, 'info')).toContain('BAYC: Stored data could not be downloaded. Tried again later.');
    expect(texts(s, 'needs-you')).toEqual([]);
  });

  it('says a collection loading stored data is loading it, not behind', () => {
    const s = snapshot({ collections: [collection({ cursorBlock: null, startBlock: null, restoreProgress: 0.42 })] });
    expect(status(s, NOW).collections[0]).toMatchObject({ turn: 'restoring' });
    expect(texts(s, 'working')).toEqual(['Loading stored data for BAYC · 42%']);
    expect(texts(s, 'needs-you')).toEqual([]);
  });

  it('says why stored data was not loaded as information, not a fault: the worker reads the chain instead', () => {
    const note = 'Stored data could not be loaded: its file does not match the manifest.';
    const s = snapshot({ collections: [collection({ restoreNote: note })] });
    expect(texts(s, 'info')).toContain(`BAYC: ${note} Reading from the chain instead; it is tried again when its stored file or the manifest changes.`);
    expect(texts(s, 'needs-you')).toEqual([]);
  });

  it('never says the chain is read when its chain has no RPC, and says when a load the store failed is tried again', () => {
    const at = NOW + 5 * MIN;
    const s = snapshot({
      config: { ...CONFIG, chains: [] },
      collections: [collection({ cursorBlock: null, startBlock: null, headBlock: null, transfers: 0, restoreNote: 'Stored data could not be loaded.', restoreRetryAt: at })],
    });
    const said = texts(s, 'info').find((t) => t.startsWith('BAYC: Stored data could not'))!;
    expect(said).toBe(`BAYC: Stored data could not be loaded. It is tried again after ${localTime(at, 'time', 'UTC', 'en-GB')}.`);
    expect(said).not.toContain('chain');
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
    const s = snapshot({ funding: [{ chainId: 1, pending: 0, done: 1, failed: 2, stranded: 0, truncated: 0, doneLastHour: 0 }] });
    expect(texts(s, 'needs-you')).toEqual(['Ethereum: 2 wallets could not be checked for money, and none was checked in the last hour.']);
    expect(status(s, NOW).notices[0]).toMatchObject({ href: '/settings#etherscan.key' });
  });

  it('reports a few failed wallets among wallets being checked as retrying on their own, not as a fault', () => {
    const s = snapshot({ funding: [{ chainId: 1, pending: 10, done: 100, failed: 2, stranded: 0, truncated: 0, doneLastHour: 50 }] });
    expect(texts(s, 'needs-you')).toEqual([]);
    expect(texts(s, 'working')).toContain('Ethereum: 2 wallets could not be checked for money; they retry on their own after an hour.');
    // With funding off nothing retries them, and the funding-off notice says why.
    const off = snapshot({ config: { ...CONFIG, funding: false }, funding: [{ chainId: 1, pending: 0, done: 1, failed: 2, stranded: 0, truncated: 0, doneLastHour: 0 }] });
    expect(status(off, NOW).notices.some((n) => n.text.includes('could not be checked'))).toBe(false);
  });

  it('says wallets held back by paused collections as information, never as a key to check', () => {
    // fundingBacklog counts a paused collection's failed wallets as stranded, not failed: no lane retries them.
    const s = snapshot({ funding: [{ chainId: 1, pending: 0, done: 1, failed: 0, stranded: 3, truncated: 0, doneLastHour: 0 }] });
    expect(texts(s, 'needs-you')).toEqual([]);
    expect(texts(s, 'info')).toContain('Ethereum: 3 wallets are not checked while their collections are paused or removed, or they are further out than the hops followed.');
    expect(status(s, NOW).funding[0]!.etaMs).toBeNull();
    // With funding off no wallet is checked, and the funding-off notice says so.
    const off = snapshot({ config: { ...CONFIG, funding: false }, funding: [{ chainId: 1, pending: 0, done: 1, failed: 0, stranded: 3, truncated: 0, doneLastHour: 0 }] });
    expect(status(off, NOW).notices.some((n) => n.text.includes('paused or removed'))).toBe(false);
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
    const funding = (doneLastHour: number) => [{ chainId: 1, pending: 1_000, done: 1_000, failed: 0, stranded: 0, truncated: 0, doneLastHour }];
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
      funding: [{ chainId: 1, pending: 3, done: 4, failed: 2, stranded: 0, truncated: 0, doneLastHour: 0 }],
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
    const f = (doneLastHour: number, pending = 50) => status(snapshot({ funding: [{ chainId: 1, pending, done: 4, failed: 0, stranded: 0, truncated: 0, doneLastHour }] }), NOW).funding[0]!.etaMs;
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
