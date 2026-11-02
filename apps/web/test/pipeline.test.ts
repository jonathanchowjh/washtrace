import { describe, expect, it } from 'vitest';
import { TRAIL_NOTES, type CollectionRow, type StoredEntry } from '@washtrace/detect';
import { pipeline, STATE_WORDS } from '@/lib/pipeline';

const LATEST = { throughBlock: 1000 };
const TRAIL = { file: 'trail.parquet', rows: 3, bytes: 30, sha256: 'feed' } as unknown as StoredEntry['trail'];

const row = (more: Partial<CollectionRow> = {}) => ({
  id: 1, chainId: 1, address: '0xabc', name: 'Demo', startBlock: 1, cursorBlock: 1000, headBlock: 1000, transfers: 5,
  wallets: 4, fundedWallets: 4, latest: LATEST, error: null, stale: false, pausedAt: null, analysisError: null,
  storedThroughTime: null, storedThroughBlock: null, downloadFile: null, downloadProgress: null, downloadNote: null,
  restoreProgress: null, restoreNote: null, trailProgress: null, trailNote: null, trailImportedSha: null, ...more,
}) as unknown as CollectionRow;

const entry = (more: Partial<StoredEntry> = {}) => ({
  chainId: 1, address: '0xabc', name: 'Demo', startBlock: 1, throughBlock: 500, throughTime: 1,
  transfers: { file: 'transfers.parquet', rows: 5, bytes: 50, sha256: 'abc' }, trail: null, ...more,
}) as StoredEntry;

const states = (s: ReturnType<typeof pipeline>) => s.map((x) => x.state);
const ON = new Set([1]);
const run = (c: CollectionRow, e: StoredEntry | null = null, more: { analyzing?: boolean; funding?: boolean; rpcChains?: ReadonlySet<number> } = {}) =>
  pipeline({ c, entry: e, rpcChains: ON, funding: true, analyzing: false, ...more });

describe('pipeline', () => {
  it('a caught-up collection with no stored data needs stages 1–3 not at all, and follows new blocks', () => {
    expect(states(run(row()))).toEqual(['not-needed', 'not-needed', 'not-needed', 'live', 'done', 'done']);
  });
  it('runs on stored data alone with no keys, and says which key each blocked stage needs', () => {
    const s = run(row({ storedThroughTime: 1, storedThroughBlock: 500, cursorBlock: 500, headBlock: null, latest: { ...LATEST, throughBlock: 500 } } as Partial<CollectionRow>), entry(), { rpcChains: new Set(), funding: false });
    expect(states(s)).toEqual(['done', 'done', 'done', 'blocked', 'blocked', 'done']);
    expect(s[3]!.needs).toEqual({ text: 'Add an RPC URL in Settings →', href: '/settings#rpc.1' });
    expect(s[4]!.needs).toEqual({ text: 'Add an Etherscan key in Settings →', href: '/settings#etherscan.key' });
  });
  it('names the variable, with no Settings link, for a chain Settings does not offer', () => {
    const s = run(row({ chainId: 8453 }));
    expect(s[3]!.needs).toEqual({ text: 'Set WASHTRACE_RPC_8453 for the worker to read this chain.', href: null });
  });
  it('downloading stored transfers: stage 1 runs with its share, and the chain waits for the load', () => {
    const s = run(row({ cursorBlock: null, headBlock: null, latest: null, downloadFile: 'transfers', downloadProgress: 0.4 } as Partial<CollectionRow>), entry());
    expect(states(s)).toEqual(['running', 'waiting', 'waiting', 'waiting', 'waiting', 'waiting']);
    expect(s[0]).toMatchObject({ share: 0.4, file: 'transfers' });
  });
  it('restoring the transfers: stage 1 is done, the file has arrived, and stage 2 runs on it', () => {
    const s = run(row({ cursorBlock: null, headBlock: null, latest: null, restoreProgress: 0.5 } as Partial<CollectionRow>), entry());
    expect([s[0]!.state, s[1]!.state, s[1]!.share, s[1]!.file]).toEqual(['done', 'running', 0.5, 'transfers']);
  });
  it('stored data the chain was read past is not needed, never waited for', () => {
    const s = run(row({ cursorBlock: 900 }), entry({ throughBlock: 500 }));
    expect(states(s).slice(0, 3)).toEqual(['not-needed', 'not-needed', 'not-needed']);
  });
  it('a not-needed stage says why: no stored data, read past it, or reading that started before it', () => {
    const skipped = (c: CollectionRow, e: StoredEntry | null) => run(c, e).slice(0, 3).map((x) => x.skipped);
    const none = 'No stored data for this collection.';
    expect(skipped(row(), null)).toEqual([none, none, none]);
    const past = 'Read past its stored data from the chain, so it was not needed.';
    expect(skipped(row({ cursorBlock: 900 }), entry({ throughBlock: 500 }))).toEqual([past, past, past]);
    // Exactly at the stored data's end counts as read past.
    expect(skipped(row({ cursorBlock: 500 }), entry({ throughBlock: 500 }))).toEqual([past, past, past]);
    // Reading stopped short of where the stored data starts: reaches() is false there too, but "read past" would be untrue.
    const before = 'Its reading started before its stored data, so it was not needed.';
    expect(skipped(row({ cursorBlock: 5 }), entry({ startBlock: 100, throughBlock: 500 }))).toEqual([before, before, before]);
  });
  it('a stage that is not not-needed has no such sentence, and a paused not-needed stage keeps it', () => {
    expect(run(row()).slice(3).map((x) => x.skipped)).toEqual([null, null, null]);
    expect(run(row({ storedThroughTime: 1, storedThroughBlock: 500 } as Partial<CollectionRow>), entry()).map((x) => x.skipped)).toEqual([null, null, null, null, null, null]);
    expect(run(row({ pausedAt: 5 })).slice(0, 3).map((x) => x.skipped)).toEqual(Array(3).fill('No stored data for this collection.'));
  });
  it('a trail importing: stage 1 done, stage 2 runs on the trail', () => {
    const s = run(row({ storedThroughTime: 1, storedThroughBlock: 500, trailProgress: 0.3 } as Partial<CollectionRow>), entry({ trail: TRAIL }));
    expect([s[0]!.state, s[1]!.state, s[1]!.share, s[1]!.file]).toEqual(['done', 'running', 0.3, 'trail']);
  });
  it('a trail downloaded but not yet importing reads as waiting, never failed', () => {
    const s = run(row({ storedThroughTime: 1, storedThroughBlock: 500 } as Partial<CollectionRow>), entry({ trail: TRAIL }));
    expect([s[0]!.state, s[1]!.state]).toEqual(['waiting', 'waiting']);
  });
  it('a failed download, a failed load, and a failed trail import each fail their own stage', () => {
    const p = (more: Partial<CollectionRow>) => states(run(row({ cursorBlock: null, headBlock: null, latest: null, ...more }), entry({ trail: TRAIL })));
    expect(p({ downloadNote: 'The Hub did not answer.' })[0]).toBe('failed');
    expect(p({ restoreNote: 'The stored file is damaged.' })[1]).toBe('failed');
    // Any trail note fails stage 2; failed and unreadable are noted after the file was read, mismatch is not.
    const noted = (trailNote: string) => p({ storedThroughTime: 1, storedThroughBlock: 500, trailNote } as Partial<CollectionRow>);
    expect(noted(TRAIL_NOTES.failed).slice(0, 2)).toEqual(['done', 'failed']);
    expect(noted(TRAIL_NOTES.unreadable).slice(0, 2)).toEqual(['done', 'failed']);
    expect(noted(TRAIL_NOTES.mismatch).slice(0, 2)).toEqual(['waiting', 'failed']);
  });
  it('a retry while stage 3 runs waits at stage 6 instead of showing the old failure', () => {
    const c = row({ storedThroughTime: 1, storedThroughBlock: 500, latest: null, analysisError: 'Ran out of memory.' } as Partial<CollectionRow>);
    const s = run(c, entry(), { analyzing: true });
    expect([s[2]!.state, s[5]!.state]).toEqual(['running', 'waiting']);
  });
  it('after a failed load the analysis of what the worker has shows at stage 6, never stage 3', () => {
    const c = (more: Partial<CollectionRow>) => row({ latest: null, restoreNote: 'Damaged.', ...more } as Partial<CollectionRow>);
    const mid = (x: CollectionRow, analyzing: boolean) => { const s = run(x, entry(), { analyzing }); return [s[2]!.state, s[5]!.state]; };
    expect(mid(c({ cursorBlock: null }), true)).toEqual(['waiting', 'running']);
    expect(mid(c({ cursorBlock: null, analysisError: 'Ran out of memory.' }), false)).toEqual(['waiting', 'failed']);
  });
  it('a paused collection part-way through: unfinished stages are paused, done ones stay done, nothing runs', () => {
    const s = run(row({ pausedAt: 5, cursorBlock: 200, headBlock: 1000, fundedWallets: 1, stale: true }));
    expect(states(s)).toEqual(['not-needed', 'not-needed', 'not-needed', 'paused', 'paused', 'paused']);
    expect(s.every((x) => x.share === null || x.state === 'done')).toBe(true);
  });
  it('catching up runs stage 4 with the share of blocks read; within BEHIND_BLOCKS it follows', () => {
    expect(run(row({ cursorBlock: 251, headBlock: 1001 }))[3]).toMatchObject({ state: 'running', share: 0.25 });
    expect(run(row({ cursorBlock: 950, headBlock: 1000 }))[3]!.state).toBe('live');
  });
  it('stage 4 waits for stored transfers still to load, but not after a load or download failed', () => {
    const behind = { startBlock: 1, cursorBlock: 100, headBlock: 1000 };
    expect(run(row(behind), entry({ throughBlock: 500 }))[3]!.state).toBe('waiting');
    // After either note the worker reads the chain as if there were no stored data.
    expect(run(row({ ...behind, restoreNote: 'Damaged.' }), entry({ throughBlock: 500 }))[3]!.state).toBe('running');
    expect(run(row({ ...behind, downloadNote: 'No answer.' }), entry({ throughBlock: 500 }))[3]!.state).toBe('running');
  });
  it('a key just added before the first analysis waits for the wallet count, never runs at 0%', () => {
    expect(run(row({ latest: null, wallets: 0, fundedWallets: 0 }))[4]!.state).toBe('waiting');
  });
  it('wallets still to check run stage 5 with the share checked', () => {
    expect(run(row({ fundedWallets: 1 }))[4]).toMatchObject({ state: 'running', share: 0.25 });
  });
  it('an analysis running on this collection runs stage 6 once the stored data is analysed, and stage 3 before', () => {
    expect(run(row({ stale: true }), null, { analyzing: true })[5]!.state).toBe('running');
    const s = run(row({ storedThroughTime: 1, storedThroughBlock: 500, latest: null } as Partial<CollectionRow>), entry(), { analyzing: true });
    expect([s[2]!.state, s[5]!.state]).toEqual(['running', 'waiting']);
  });
  it('a failed analysis fails stage 6, and stage 3 while the stored data is not yet analysed', () => {
    const s = run(row({ storedThroughTime: 1, storedThroughBlock: 500, latest: null, analysisError: 'Ran out of memory.' } as Partial<CollectionRow>), entry());
    expect([s[2]!.state, s[5]!.state]).toEqual(['failed', 'failed']);
  });
  it('a retry of a failed analysis reads running, not failed', () => {
    const c = row({ storedThroughTime: 1, storedThroughBlock: 500, latest: { ...LATEST, throughBlock: 500 }, analysisError: 'Ran out of memory.' } as Partial<CollectionRow>);
    expect(run(c, entry(), { analyzing: true })[5]!.state).toBe('running');
  });
  it('read past its stored data with a loaded trail: stages 1 and 2 are done, stage 3 is not needed', () => {
    const c = row({ cursorBlock: 900, trailImportedSha: 'feed' } as Partial<CollectionRow>);
    expect(states(run(c, entry({ throughBlock: 500, trail: TRAIL }))).slice(0, 3)).toEqual(['done', 'done', 'not-needed']);
  });
  it('a queued download waits even when the transfers are loaded; a not-needed stage stays not needed', () => {
    const loaded = row({ storedThroughTime: 1, storedThroughBlock: 500, downloadFile: 'trail' } as Partial<CollectionRow>);
    expect(run(loaded, entry({ trail: TRAIL }))[0]!.state).toBe('waiting');
    expect(run(row({ downloadFile: 'transfers' } as Partial<CollectionRow>))[0]!.state).toBe('not-needed');
  });
  it('a download or a load never reads as 100% while it runs', () => {
    const d = run(row({ cursorBlock: null, headBlock: null, latest: null, downloadFile: 'transfers', downloadProgress: 1 } as Partial<CollectionRow>), entry());
    expect(d[0]!.share).toBe(0.99);
    const l = run(row({ cursorBlock: null, headBlock: null, latest: null, restoreProgress: 1 } as Partial<CollectionRow>), entry());
    expect(l[1]!.share).toBe(0.99);
    const t = run(row({ storedThroughTime: 1, storedThroughBlock: 500, trailProgress: 1 } as Partial<CollectionRow>), entry({ trail: TRAIL }));
    expect(t[1]!.share).toBe(0.99);
  });
  it('transfers loading with a trail still to come: stage 1 stays waiting, stage 2 runs', () => {
    const s = run(row({ cursorBlock: null, headBlock: null, latest: null, restoreProgress: 0.5 } as Partial<CollectionRow>), entry({ trail: TRAIL }));
    expect([s[0]!.state, s[1]!.state]).toEqual(['waiting', 'running']);
  });
  it('a retried load is not a failed one: the chain waits while it runs, and reads on once it fails again', () => {
    const behind = { startBlock: 1, cursorBlock: 100, headBlock: 1000, restoreNote: 'Damaged.' };
    expect(run(row({ ...behind, restoreProgress: 0.2 } as Partial<CollectionRow>), entry({ throughBlock: 500 }))[3]!.state).toBe('waiting');
    expect(run(row(behind), entry({ throughBlock: 500 }))[3]!.state).toBe('running');
  });
  it('a paused collection keeps its done stages done and pauses the rest', () => {
    const c = row({ pausedAt: 5, storedThroughTime: 1, storedThroughBlock: 500, cursorBlock: 500, headBlock: 1000, fundedWallets: 1, stale: true, latest: { ...LATEST, throughBlock: 500 } } as Partial<CollectionRow>);
    expect(states(run(c, entry()))).toEqual(['done', 'done', 'done', 'paused', 'paused', 'paused']);
  });
  it('titles and feeds are the spec\'s, in order', () => {
    const s = run(row());
    expect(s.map((x) => x.title)).toEqual(['Download stored data', 'Load it into the database', 'Analyze the stored data', 'Read new transfers from the chain', 'Check wallets for money', 'Re-analyze with everything']);
    expect(s.map((x) => x.feeds)).toEqual([
      'stage 2: the history it holds arrives once it has downloaded.',
      'every lens: the history up to where the stored data stops, and the money trail for Money loops back and Linked wallets.',
      'every number on this page until the chain is read.',
      'every lens. Unread history can move any share either way.',
      'Money loops back and Linked wallets. An unchecked wallet hides its links, so their shares can only rise.',
      'every number on this page: it turns stages 1 to 5 into them.',
    ]);
  });
  it('has a chip word for every state', () => {
    expect(STATE_WORDS).toEqual({ waiting: 'Waiting', running: 'Running', done: 'Done', 'not-needed': 'Not needed', blocked: 'Needs a key', failed: 'Failed', paused: 'Paused', live: 'Following' });
  });
});
