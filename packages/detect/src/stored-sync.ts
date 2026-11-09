import { statSync, type Stats } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';
import { messageOf } from './env.js';
import { LockedRun } from './locked-run.js';
import { HUB, download, fetchManifest, hubUrl, partPath, removeStaleParts } from './hub.js';
import { LOCKS, retryMs, type CollectionRow, type Store } from './store.js';
import {
  DOWNLOAD_NOTES, StoredDataError, entryFor, readManifest, readTrail, readTransfers, sha256File, storedFile, storedKey, trailPaths, writeManifest,
  type Manifest, type StoredEntry, type StoredFileMeta, type StoredPart,
} from './stored.js';
import type { Flow, Transfer } from './types.js';
import type { Worker } from './worker.js';

/**
 * Whether a collection's stored data is still worth loading: it reaches past
 * what was read. That covers a fresh watch and one that started reading from
 * the deploy block before stored data came. Not one whose reading stopped
 * short of where the stored data starts: the cursor would jump the blocks in
 * between, and they would never be read.
 */
export function reaches(c: CollectionRow, entry: StoredEntry): boolean {
  return c.cursorBlock === null || (c.cursorBlock >= entry.startBlock - 1 && c.cursorBlock < entry.throughBlock);
}

/**
 * Whether to load a collection's stored data before reading its chain: it is
 * watched, its stored data reaches past what was read, and no earlier load
 * failed in a way that would fail again now. A load the data failed is noted
 * on what it was about, and skipped while `key` (storedKey, now) is the
 * same; a load the store failed waits until its retry time. Meanwhile the
 * collection is read from the chain, if it has an RPC, and analysed on what
 * it has.
 */
export function needsRestore(c: CollectionRow, entry: StoredEntry | null, key: string | null, now = Date.now()): boolean {
  if (c.pausedAt !== null || entry === null || !reaches(c, entry)) return false;
  if (c.restoreRetryAt !== null && now < c.restoreRetryAt) return false;
  return c.restoreNoteKey === null || c.restoreNoteKey !== key;
}

/**
 * Whether to load a collection's money trail from disk: it is watched, the
 * manifest has a trail for it, its two files on disk are that trail
 * (`onDisk`: both are there, and each matches its sha256 in the manifest),
 * and it is not the trail already loaded. A trail cut again has a new sha,
 * so it loads again. No request is needed: a trail on disk loads as stored
 * data does. Returns true when the trail is due, false when not.
 */
export function needsTrail(c: CollectionRow, e: StoredEntry | null, onDisk: boolean): boolean {
  if (c.pausedAt !== null || e?.trail == null || !onDisk) return false;
  return c.trailImportedSha !== e.trail.sha256;
}

/** The most a progress bar reads while a load or download runs: it never reads done, because the data is not there until the load commits and the progress is then cleared. */
export const NOT_DONE = 0.99;

/** Why a money trail on disk was not loaded, in the words the console shows. The full error goes to the log. */
export const TRAIL_NOTES = {
  mismatch: 'Money trail on disk does not match the stored data, so it was not loaded.',
  unreadable: 'Money trail on disk could not be read, so it was not loaded.',
  failed: 'The money trail could not be loaded. Tried again later.',
} as const;

/**
 * A trail import that committed no batch for this long is given up, and
 * fails. A batch is seconds; this is long enough for both its files' sha256s
 * to be checked before the first. Looked at every STALL_CHECK_MS.
 */
const TRAIL_STALL_MS = 15 * 60_000;

/**
 * How often the Hub is asked for its manifest. A publish is rare, and a
 * newly watched collection asks at once (see askHub).
 */
const HUB_EVERY_MS = 60 * 60_000;

/** An ask of the Hub is given this long: it runs in the ingest pass, under its lock, and a hung one would hold the pass until it is taken for stuck. */
const HUB_TIMEOUT_MS = 30_000;

/** A download whose part file has not grown for this long is given up, and fails. Looked at every STALL_CHECK_MS. */
const STALL_MS = 2 * 60_000;
const STALL_CHECK_MS = 10_000;

/**
 * Why a download or a trail import was stopped: its collection paused or
 * deleted, its trail cut again, or the worker stopping; transfers that go
 * first; a stall; or the connection holding its lock lost. Only the last two
 * are failures.
 */
export type Halt = 'stopped' | 'preempted' | 'stalled' | 'lost';

/** A download to start: whose, and which of its stored data: the transfers, or the trail's two files. */
interface Wanted { c: CollectionRow; entry: StoredEntry; file: 'transfers' | 'trail' }

/** One file a download fetches: from where, to where, and the sha256 and size the manifest gives it. */
interface DownloadPart { url: string; dest: string; sha256: string; bytes: number }

/** A trail import to start: whose, and the stat of its two files when they were found matching (see trailOnDisk). */
interface TrailDue { c: CollectionRow; entry: StoredEntry; key: string }

/**
 * The worker's stored data, kept in step with the Hub and the store: the
 * Hub's manifest asked for and kept on disk, each collection's stored
 * transfers loaded, its money trail imported, and either downloaded first
 * when it is not on disk. The ingest pass drives it (askHub, restore,
 * trails, downloads, in that order) and analyze asks it what is still to
 * load; a download and a trail import run in the background, outside every
 * pass.
 *
 * Its own class, apart from Worker's polling, because it has its own state
 * that no polling job touches: the files' hashes, the back-offs of loads,
 * imports and downloads that failed, the Hub's last ask, and the download and
 * the import in flight. It borrows the worker's `scrubbed` and `beat`, so an
 * error loses every secret the worker knows and a load says so in ingest's
 * heartbeat.
 */
export class StoredSync {
  /** The last manifest read error logged, so a broken manifest is one line and not one a pass. */
  private manifestFailed = '';
  /**
   * Each stored file's sha256, by path, kept while its modified time and size
   * stay the same: a file can be gigabytes, and is looked at every pass.
   */
  private readonly shas = new Map<string, { file: string; sha: string }>();
  /** Trails that could not be read, by the path of their flows file and their trailOnDisk key: not tried again until either file changes. */
  private readonly trailsUnreadable = new Map<string, string>();
  /**
   * Loads of stored data the store failed, by collection, timed as the store
   * times them: kept here too, since the write that records a back-off can
   * fail with the load (a full disk), and the next pass would load it all
   * again.
   */
  private readonly restoreFailed = new Map<number, { failures: number; retryAt: number }>();
  /**
   * When the Hub was last asked for its manifest, whatever it answered, and
   * which repo. In memory: a restart asks at once. `hubFailing` is that the
   * last ask failed, so an outage is one log line and not one an hour.
   */
  private hubAskedAt = -Infinity;
  private hubRepo = '';
  private hubFailing = false;
  /** The download running in this process, outside every pass (see startDownload). One at a time. */
  private downloading: { id: number; file: 'transfers' | 'trail'; abort: AbortController; done: Promise<void> } | null = null;
  /** Downloads that failed, by collection, timed as the store times them: kept here too, as restoreFailed is, since the write that records the back-off can fail with the download (a full disk). */
  private readonly downloadsFailed = new Map<number, { failures: number; retryAt: number }>();
  /** The trail import running in this process, outside every pass (see startTrailImport). One at a time. */
  private importing: { id: number; sha: string; abort: AbortController; done: Promise<void> } | null = null;
  /** Trail imports the store failed, by collection, timed as a failed load is. In memory only: the note says it failed, and a restart tries again. */
  private readonly trailsRetry = new Map<number, { failures: number; retryAt: number }>();
  /** Collections whose progress an import could not clear (the store itself failing, usually). The value is this process's own, as it held the lock; each pass tries again (see trails). */
  private readonly progressUncleared = new Set<number>();

  /** `stored` is the stored-data folder, which holds manifest.json. */
  constructor(
    private readonly worker: Worker,
    private readonly store: Store,
    private readonly stored: string,
  ) {}

  /** Whether a download or a trail import is running in this process. */
  get inFlight(): boolean {
    return this.downloading !== null || this.importing !== null;
  }

  /** Stops any download (its part is kept, for the next worker to resume) and any trail import (loading it again is safe). */
  stop(): void {
    this.downloading?.abort.abort('stopped' satisfies Halt);
    this.importing?.abort.abort('stopped' satisfies Halt);
  }

  /**
   * The stored-data manifest, or null when it cannot be read: then no
   * collection has stored data, and that is said once. A Hub that said it has
   * none left an empty manifest on disk (askHub), which reads as empty.
   */
  async storedManifest(): Promise<Manifest | null> {
    try {
      const manifest = await this.manifest();
      this.manifestFailed = '';
      return manifest;
    } catch (err) {
      const message = this.worker.scrubbed(err);
      if (this.manifestFailed !== message) console.warn('[washtrace] stored data not used: %s', message);
      this.manifestFailed = message;
      return null;
    }
  }

  /**
   * Ask the Hub for its manifest and keep it on disk, where every step reads
   * it: once an hour, at once for a newly watched collection or another repo,
   * and next pass after a download that did not match it. A failed ask
   * counts, so a Hub that is down is asked hourly too; meanwhile the manifest
   * on disk, if any, is used, and the outage is one log line. A Hub that says
   * the repo has none means no stored data: the manifest on disk is replaced by
   * an empty one, so no step (and not the console, which reads the same file)
   * goes on quoting stored data that will not be downloaded. Only ingest asks: everything else
   * reads what is on disk.
   */
  async askHub(collections: readonly CollectionRow[], repo: string): Promise<void> {
    const now = Date.now();
    const watched = collections.some((c) => c.pausedAt === null && c.addedAt > this.hubAskedAt);
    if (now - this.hubAskedAt <= HUB_EVERY_MS && !watched && repo === this.hubRepo) return;
    this.hubAskedAt = now;
    this.hubRepo = repo;
    try {
      const fetched = await this.fetchHubManifest(repo);
      const manifest: Manifest = fetched ?? { version: 3, collections: [] };
      await mkdir(this.stored, { recursive: true });
      await writeManifest(join(this.stored, 'manifest.json'), manifest);
      this.hubFailing = false;
      // None from a repo with no public dataset, as a mistyped one is: its parts may be wanted again once it is put right.
      if (fetched !== null) await this.sweepParts(fetched);
    } catch (err) {
      if (!this.hubFailing) console.warn('[washtrace] stored data not fetched from Hugging Face: %s. The manifest on disk is used, if there is one.', this.worker.scrubbed(err));
      this.hubFailing = true;
    }
  }

  /**
   * Delete the download parts the manifest just fetched names no file for
   * (removeStaleParts). Under the download lock, so never a part a download
   * in any replica is writing; one held means a download runs, and the sweep
   * waits for the next ask. Fail-soft.
   */
  private async sweepParts(manifest: Manifest): Promise<void> {
    try {
      const removed = await this.store.locked(LOCKS.download, false, () => removeStaleParts(this.stored, manifest));
      if (removed !== 'skipped' && removed.length > 0) console.info('[washtrace] removed %d stale download parts: %s', removed.length, removed.join(', '));
    } catch (err) {
      console.warn('[washtrace] stale download parts not removed: %s', this.worker.scrubbed(err));
    }
  }

  /**
   * The Hub's manifest of `repo`, null when it has none. The Hub answers an anonymous read of a dataset
   * that does not exist, or is private, with 401: for the worker, which sends no token, that is no public
   * dataset, so no stored data. Tests override it on the instance.
   */
  async fetchHubManifest(repo: string): Promise<Manifest | null> {
    try {
      return await fetchManifest(repo, HUB, AbortSignal.timeout(HUB_TIMEOUT_MS));
    } catch (err) {
      if ((err as { status?: number }).status === 401) return null;
      throw err;
    }
  }

  /**
   * Load the stored data of the first collection that needs it (see
   * needsRestore), and say how many loaded and which others are deferred to
   * a later pass. Loads at most one collection per pass; a failed load does
   * not use up the pass. This runs in the ingest pass, under its lock, so no
   * span is read into a collection while it loads, and every other
   * collection's reading waits for it; with six to load, they would wait for
   * all six. A load that fails has said why on the collection, and its chain
   * is read as if there were no stored data. A note about stored
   * data the collection no longer reaches for says nothing true, and goes.
   */
  async restore(collections: readonly CollectionRow[], manifest: Manifest): Promise<{ loaded: number; deferred: Set<number> }> {
    let loaded = 0;
    let loadedOne = false;
    const deferred = new Set<number>();
    for (const c of collections) {
      if (c.pausedAt !== null) continue;
      const entry = entryFor(manifest, c.chainId, c.address);
      if (entry === null || !reaches(c, entry)) {
        if (c.restoreNote !== null) {
          await this.store.clearRestoreNote(c.id).catch((err) => console.error('[washtrace] collection %d: stored data note not cleared: %s', c.id, this.worker.scrubbed(err)));
        }
        continue;
      }
      // Its trail is importing: that import stops this pass (see trails), and the load goes next pass, never beside it.
      if (this.importing?.id === c.id) continue;
      const noted = await this.noteKey(c, entry);
      if (!this.restoreDue(c, entry, noted, Date.now())) continue;
      // Not on disk yet, and the Hub has it: it is downloaded first (see downloads). Loaded now, it would only be noted missing.
      if (await this.fetchable(manifest, join(this.stored, entry.transfers.file), entry.transfers.sha256)) continue;
      if (loadedOne) {
        deferred.add(c.id);
        continue;
      }
      // Taken before the load, so a file replaced while it runs is tried again.
      const key = noted ?? await this.restoreKey(entry);
      await this.worker.beat('ingest', `Loading stored data for ${c.name ?? entry.name}`, c.id);
      try {
        await this.store.restore(c.id, c.chainId, entry, this.storedTransfers(entry), key);
        this.restoreFailed.delete(c.id);
        loaded += 1;
        // Only a load that went through spends the pass: one that failed leaves the next to go now.
        loadedOne = true;
      } catch (err) {
        console.error('[washtrace] collection %d: stored data not loaded: %s', c.id, this.worker.scrubbed(err));
        // Bad stored data is keyed on the file, not timed.
        if (err instanceof StoredDataError) this.restoreFailed.delete(c.id);
        else {
          const failures = (this.restoreFailed.get(c.id)?.failures ?? 0) + 1;
          this.restoreFailed.set(c.id, { failures, retryAt: Date.now() + retryMs(failures) });
        }
      }
    }
    return { loaded, deferred };
  }

  /** Whether to load a collection's stored data now: needsRestore, and no back-off held here (restoreFailed) still running. */
  restoreDue(c: CollectionRow, entry: StoredEntry | null, key: string | null, now: number): boolean {
    return (this.restoreFailed.get(c.id)?.retryAt ?? 0) <= now && needsRestore(c, entry, key, now);
  }

  /** What a collection's stored data is now (storedKey), for one whose last load the data failed; else null, and nothing is read. */
  async noteKey(c: CollectionRow, entry: StoredEntry | null): Promise<string | null> {
    return c.restoreNoteKey === null || entry === null ? null : this.restoreKey(entry);
  }

  /** What a collection's stored data is now: the manifest's sha256 and its file's stat. Tests override it on the instance. */
  restoreKey(entry: StoredEntry): Promise<string> {
    return storedKey(join(this.stored, entry.transfers.file), entry.transfers.sha256);
  }

  /**
   * Start the import of the next money trail on disk that is due, if none
   * runs in this process, and stop the one running once it is no longer
   * wanted. A trail is due when needsTrail says so, its collection's
   * transfers are not still to load (needsRestore, keyed as restore keys
   * it), and no failure of its own is waiting out its back-off. A trail
   * whose files are not both on disk is not there yet (a download may be
   * between them) and says nothing. One with a file that is not the
   * manifest's, or that cannot be read, imports nothing and says so on the
   * collection, and is not tried again until a file changes. The pass
   * never waits for an import: one of millions of flows takes an hour (see
   * startTrailImport). Meanwhile its collection is read and analysed as any.
   *
   * The stop conditions here, the restore guard and the trail-download guard
   * act per process. With two replicas, if the other keeps winning the ingest
   * lock, an import can run on to the end on a superseded sha. That wastes
   * time but does no harm: the statements are idempotent, and a later restore
   * resets the traders to depth 0. Stopping on needsRestore means that while
   * a transfers load keeps failing and its back-off keeps expiring, an import
   * longer than the back-off is stopped each time.
   */
  async trails(collections: readonly CollectionRow[], manifest: Manifest): Promise<void> {
    const now = Date.now();
    // A clear that failed left progress the console shows as loading. Tried again, never for the import that runs: its progress is true.
    for (const id of [...this.progressUncleared]) {
      if (this.importing?.id === id) continue;
      try {
        await this.store.setTrailProgress(id, null);
        this.progressUncleared.delete(id);
      } catch (err) {
        console.error('[washtrace] collection %d: money trail progress not cleared: %s', id, this.worker.scrubbed(err));
      }
    }
    const running = this.importing;
    if (running !== null) {
      const c = collections.find((x) => x.id === running.id);
      const entry = c === undefined ? null : entryFor(manifest, c.chainId, c.address);
      // Paused or deleted, cut again, or its transfers to load again: stopped, not failed. Loading it again later is safe.
      if (c === undefined || c.pausedAt !== null || entry?.trail?.sha256 !== running.sha || needsRestore(c, entry, await this.noteKey(c, entry), now)) {
        running.abort.abort('stopped' satisfies Halt);
      }
    }
    let next: TrailDue | null = null;
    for (const c of collections) {
      const entry = entryFor(manifest, c.chainId, c.address);
      if (c.pausedAt !== null) continue;
      if (entry?.trail == null) {
        // No trail in the manifest any more: a note about one says nothing true.
        if (c.trailNote !== null) await this.noteTrail(c.id, null);
        continue;
      }
      // Imported already: the files have nothing more to give, so they are not hashed (a gigabyte, at every start).
      // Its import cleared any note; one written since is about files that no longer matter.
      if (c.trailImportedSha === entry.trail.sha256) {
        if (c.trailNote !== null) await this.noteTrail(c.id, null);
        continue;
      }
      const disk = await this.trailOnDisk(entry).catch((err) => {
        console.error('[washtrace] collection %d: money trail not read: %s', c.id, this.worker.scrubbed(err));
        return undefined;
      });
      if (disk === undefined) continue;
      // A note about a trail no longer on disk, or whose files now match, says nothing true: cleared. Files that could not be read keep their note.
      if (c.trailNote !== null && (disk === null || (disk.bad === null && c.trailNote === TRAIL_NOTES.mismatch))) {
        await this.noteTrail(c.id, null);
      }
      if (disk?.bad != null) {
        if (c.trailNote !== TRAIL_NOTES.mismatch) {
          console.warn('[washtrace] collection %d: %s does not match the manifest (sha256 %s, expected %s)', c.id, disk.bad.path, disk.bad.sha, disk.bad.expected);
          await this.noteTrail(c.id, TRAIL_NOTES.mismatch);
        }
        continue;
      }
      if (!needsTrail(c, entry, disk !== null) || this.trailsUnreadable.get(trailPaths(this.stored, entry).flows) === disk!.key) continue;
      // One at a time; the first due goes.
      if (this.importing !== null || next !== null) continue;
      if (now < (this.trailsRetry.get(c.id)?.retryAt ?? 0)) continue;
      if (needsRestore(c, entry, await this.noteKey(c, entry), now)) continue;
      next = { c, entry, key: disk!.key };
    }
    if (next !== null) this.startTrailImport(next);
  }

  /**
   * Run one trail import in the background, outside every pass: an import of
   * an hour holds no job lock and writes no pass or heartbeat, so it is never
   * taken for a stuck ingest. It holds the trail lock for its whole length
   * instead, so two replicas never import at once: one that finds it held
   * starts nothing, the other replica is importing. With the download's,
   * that is at most two of the pool's ten clients (Store.connect) held for
   * hours; the passes and the checks share the rest. Never rejects: it has
   * no caller.
   */
  private startTrailImport(due: TrailDue): void {
    const abort = new AbortController();
    const done = this.store.locked(LOCKS.trail, false, (client) => this.importTrail(client, due, abort))
      .then(() => {}, (err) => console.error('[washtrace] collection %d: money trail not loaded: %s', due.c.id, this.worker.scrubbed(err)))
      .finally(() => { if (this.importing?.abort === abort) this.importing = null; });
    this.importing = { id: due.c.id, sha: due.entry.trail!.sha256, abort, done };
  }

  /**
   * One trail import, said on the collection as it goes: at most once per
   * 1%, capped at 99% (the manifest's count of rows is a guide), fail-soft,
   * and a write that finds the collection paused or deleted stops it, as the
   * next pass would. The row is read again first, under the lock: another
   * replica, or an earlier pass, may have imported it since the pass read
   * it. No batch committed for TRAIL_STALL_MS stops it too, as a failure. A
   * bad file is noted, and keyed on the trail's two files; any other failure says it
   * failed and waits its back-off. One stopped is no failure: only its
   * progress goes. One that goes through clears its progress and its note in
   * its last statement (Store.importTrail).
   *
   * `client` holds the trail lock, as fetchStored's holds the download's:
   * lost, or found dead by a look once a minute, it fails the import, since
   * the lock went with it.
   */
  private async importTrail(client: pg.PoolClient, { c, entry, key }: TrailDue, abort: AbortController): Promise<void> {
    const sha = entry.trail!.sha256;
    const row = await this.store.collection(c.chainId, c.address);
    if (row === null || row.pausedAt !== null || row.trailImportedSha === sha) return;
    // A retry: "could not be loaded" must not show beside the progress. A note about the files is not this one's to clear.
    if (row.trailNote === TRAIL_NOTES.failed) await this.noteTrail(c.id, null);
    // Says 0 at once: 0 while both files' sha256s are checked, before the first batch.
    const run = new LockedRun(client, abort, (share) => this.store.setTrailProgress(c.id, share),
      (err) => console.warn('[washtrace] collection %d: money trail progress not written: %s', c.id, this.worker.scrubbed(err)));
    const rows = Math.max(1, entry.trail!.rows);
    const onFlows = (flows: number) => run.progress(Math.min(NOT_DONE, flows / rows));
    let movedAt = Date.now();
    const watch = setInterval(() => { if (Date.now() - movedAt >= TRAIL_STALL_MS) abort.abort('stalled' satisfies Halt); }, STALL_CHECK_MS);
    watch.unref?.();
    // Found matching moments ago (shaOnDisk): hashed again only if either file has changed since, as that cache trusts.
    const read = async () => this.storedTrail(entry, (await this.trailKey(entry)) !== key)[Symbol.asyncIterator]();
    // The store asks for a batch once the one before it committed: that is the import moving. Each pass ends
    // only once the progress written so far has landed, so none lands after the last statement clears it.
    // A read is raced against the abort, so one that never returns is still given up; no statement runs
    // during a read, so none is left running under the lock. A statement waiting on a lock ends by
    // its own timeout (Store.trailLockTimeout).
    const open = () => (async function* () {
      const batches = await read();
      try {
        for (;;) {
          const next = await orAborted(batches.next(), abort.signal);
          if (next.done) return;
          yield next.value;
          movedAt = Date.now();
        }
      } finally {
        // Closed however the pass ends (the wallets pass breaks off, an abort, a failure), so the file and its
        // decompressor go. Not awaited: a close queues behind a read that never returns, and would hang with it.
        Promise.resolve(batches.return?.()).catch(() => {});
        await run.writes;
      }
    })();
    try {
      const { wallets, flows } = await this.store.importTrail(c.id, c.chainId, sha, open, { onFlows, signal: abort.signal });
      this.trailsRetry.delete(c.id);
      console.info('[washtrace] collection %d: money trail loaded, %d wallets and %d flows', c.id, wallets, flows);
    } catch (err) {
      await run.writes;
      await this.store.setTrailProgress(c.id, null).catch((e) => { this.progressUncleared.add(c.id); this.logged(c.id, 'money trail progress not cleared')(e); });
      const halt: Halt | null = abort.signal.aborted ? abort.signal.reason : null;
      if (halt === 'stopped') return;
      if (halt === null && err instanceof StoredDataError) {
        // Bad stored data is keyed on the files, not timed.
        console.error('[washtrace] collection %d: money trail not loaded: %s', c.id, this.worker.scrubbed(err));
        this.trailsRetry.delete(c.id);
        this.trailsUnreadable.set(trailPaths(this.stored, entry).flows, key);
        await this.noteTrail(c.id, err.kind === 'mismatch' ? TRAIL_NOTES.mismatch : TRAIL_NOTES.unreadable);
        return;
      }
      const why = halt === 'stalled' ? `nothing was written for ${TRAIL_STALL_MS / 60_000} minutes`
        : halt === 'lost' ? `the connection holding its lock was lost (${this.worker.scrubbed(run.lost)})` : this.worker.scrubbed(err);
      console.error('[washtrace] collection %d: money trail not loaded: %s', c.id, why);
      const failures = (this.trailsRetry.get(c.id)?.failures ?? 0) + 1;
      this.trailsRetry.set(c.id, { failures, retryAt: Date.now() + retryMs(failures) });
      await this.noteTrail(c.id, TRAIL_NOTES.failed);
    } finally {
      clearInterval(watch);
      run.close();
    }
  }

  /**
   * Forget the progress of a trail import that was running when the last
   * worker died: the console says it imports for ever otherwise. Only while
   * no replica imports: it takes the trail lock, and one held means another
   * replica is importing, and its progress is true. For start-up.
   *
   * It also skips while a dead session still holds the trail lock (LOCKS.trail), until Postgres
   * reaps it. A row paused by then can keep its stale progress until the next
   * restart; the console hides a trail line on a paused row, so that is no lie.
   */
  async clearStaleTrailProgress(): Promise<void> {
    await this.store.locked(LOCKS.trail, false, () => this.store.clearTrailProgress());
  }

  /**
   * Forget the progress a worker that died left, before the first pass (which
   * may start a load or a download of its own): all three, each failing soft
   * with a warning. A load of stored data that was running rolled back, but
   * the progress it showed was written outside it, and the console would say
   * "Loading stored data" for ever. A download that was running keeps its part
   * file, and the next pass resumes it. A trail import is cleared unless
   * another replica is importing now (see clearStaleTrailProgress).
   */
  async clearStaleProgress(): Promise<void> {
    await this.store.clearRestoreProgress().catch((err) => console.warn('[worker] stale stored-data progress not cleared: %s', messageOf(err)));
    await this.store.clearDownloads().catch((err) => console.warn('[worker] stale download progress not cleared: %s', messageOf(err)));
    await this.clearStaleTrailProgress().catch((err) => console.warn('[worker] stale money trail progress not cleared: %s', messageOf(err)));
  }

  /** Say on the collection why its trail was not loaded, or with null that nothing is wrong. Fail-soft: the rest of the pass goes on. */
  private async noteTrail(id: number, note: string | null): Promise<void> {
    await this.store.setTrailNote(id, note).catch((err) => console.error('[washtrace] collection %d: money trail note not written: %s', id, this.worker.scrubbed(err)));
  }

  /** A catch for a fail-soft write about collection `id`: logs, scrubbed, that `what` failed, and the run goes on. */
  private logged(id: number, what: string): (err: unknown) => void {
    return (err) => console.error('[washtrace] collection %d: %s: %s', id, what, this.worker.scrubbed(err));
  }

  /**
   * The sha256 of the stored file at `path`, and the modified time and size
   * it was taken at; null when there is no file. Hashed again only once the
   * file changes.
   */
  private async shaOnDisk(path: string): Promise<{ key: string; sha: string } | null> {
    const key = await statKey(path);
    if (key === null) return null;
    const known = this.shas.get(path);
    if (known?.file === key) return { key, sha: known.sha };
    const sha = await this.fileSha(path);
    this.shas.set(path, { file: key, sha });
    return { key, sha };
  }

  /**
   * A collection's money trail as it stands on disk: null when either of its
   * two files is not there, which is no trail yet. Otherwise the stat of both
   * (`key`, as trailKey) and, in `bad`, the first file, wallets before
   * flows, whose sha256 is not the manifest's. Hashed as shaOnDisk hashes.
   */
  private async trailOnDisk(entry: StoredEntry): Promise<{ key: string; bad: { path: string; sha: string; expected: string } | null } | null> {
    // Both there before either is hashed: the wallets alone are no trail.
    if ((await this.trailKey(entry)) === null) return null;
    const paths = trailPaths(this.stored, entry);
    const keys: string[] = [];
    let bad: { path: string; sha: string; expected: string } | null = null;
    for (const which of ['wallets', 'flows'] as const) {
      const file = await this.shaOnDisk(paths[which]);
      if (file === null) return null;
      keys.push(file.key);
      const expected = entry.trail!.files[which].sha256;
      if (bad === null && file.sha !== expected) bad = { path: paths[which], sha: file.sha, expected };
    }
    return { key: keys.join('|'), bad };
  }

  /** The stat of a trail's two files, joined as trailOnDisk keys them; null when either is not there. */
  private async trailKey(entry: StoredEntry): Promise<string | null> {
    const paths = trailPaths(this.stored, entry);
    const wallets = await statKey(paths.wallets);
    const flows = await statKey(paths.flows);
    return wallets === null || flows === null ? null : `${wallets}|${flows}`;
  }

  /** A file's sha256. Tests override it on the instance. */
  fileSha(path: string): Promise<string> {
    return sha256File(path);
  }

  /** A collection's money trail from its two files, checked against the manifest first unless `verify` is false (see readTrail). Tests override it on the instance. */
  storedTrail(entry: StoredEntry, verify: boolean): AsyncIterable<{ checked: string[]; flows: Flow[] }> {
    return readTrail(trailPaths(this.stored, entry), entry.trail!.files, verify);
  }

  /** The stored-data manifest; empty when there is none. Tests override it on the instance. */
  manifest(): Promise<Manifest> {
    return readManifest(join(this.stored, 'manifest.json'));
  }

  /** A collection's stored transfers, checked against the manifest's sha256 first. Tests override it on the instance. */
  storedTransfers(entry: StoredEntry): AsyncIterable<Transfer[]> {
    return readTransfers(join(this.stored, entry.transfers.file), entry.transfers.sha256);
  }

  /**
   * Whether the stored file at `path` is to come from the Hub: the manifest
   * names the commit to fetch it at, and the file on disk is missing or not
   * the one it names. A manifest cut here names none: its files are only
   * ever on disk. A file that cannot be read is left to the step that reads
   * it, which says so.
   */
  private async fetchable(manifest: Manifest, path: string, sha256: string): Promise<boolean> {
    if (manifest.revision === undefined) return false;
    const file = await this.shaOnDisk(path).catch(() => undefined);
    return file === null || (file !== undefined && file.sha !== sha256);
  }

  /**
   * Whether a collection's money trail is to come from the Hub: either of its
   * two files is (see fetchable). Both are looked at, so the download finds
   * the one already whole (see knownWhole).
   */
  private async trailFetchable(manifest: Manifest, entry: StoredEntry): Promise<boolean> {
    const paths = trailPaths(this.stored, entry);
    const { wallets, flows } = entry.trail!.files;
    const fetchWallets = await this.fetchable(manifest, paths.wallets, wallets.sha256);
    const fetchFlows = await this.fetchable(manifest, paths.flows, flows.sha256);
    return fetchWallets || fetchFlows;
  }

  /**
   * Whether the file at `path` is known to be whole: its sha256, as shaOnDisk
   * cached it for the file as it stands now, is `sha256`. A file not hashed
   * since it changed is not known. A stat, not a read, and synchronous, so a
   * download starts in the pass that started it.
   */
  private knownWhole(path: string, sha256: string): boolean {
    let key: string | null;
    try {
      const s = statSync(path, { throwIfNoEntry: false });
      key = s === undefined ? null : keyOf(s);
    } catch {
      return false;
    }
    const known = this.shas.get(path);
    return key !== null && known?.file === key && known.sha === sha256;
  }

  /**
   * Start the next download of stored data, if one is due and none runs in
   * this process, and say whose chain reading waits for theirs. A file is
   * wanted while the step that loads it would load it and it is not on disk
   * (see fetchable): the transfers while needsRestore, the trail while it is
   * not the one loaded and either of its two files is not on disk. One at a
   * time, every collection's transfers before any trail, since only
   * transfers hold the chain reading back: a trail download running when
   * transfers come due is stopped, its part kept, and the transfers start
   * next pass. A failed download waits out its back-off and holds nothing
   * meanwhile: the collection is served as it would be with no stored data.
   * A paused or deleted collection's download is stopped.
   */
  async downloads(collections: readonly CollectionRow[], manifest: Manifest, repo: string): Promise<Set<number>> {
    const running = this.downloading;
    if (running !== null) {
      const c = collections.find((x) => x.id === running.id);
      if (c === undefined || c.pausedAt !== null) running.abort.abort('stopped' satisfies Halt);
    }
    const held = new Set<number>();
    const revision = manifest.revision;
    let started: number | null = null;
    if (revision !== undefined) {
      const now = Date.now();
      let transfers: Wanted | null = null;
      let trail: Wanted | null = null;
      for (const c of collections) {
        const entry = entryFor(manifest, c.chainId, c.address);
        if (c.pausedAt !== null || entry === null) continue;
        const waits = this.downloadWaits(c, now);
        // A file whose bytes did not match at this publish, the transfers or either of the trail's: the same bytes would come again (see downloadMismatch).
        const due = (file: 'transfers' | 'trail') => !waits && downloadParts(entry, file, this.stored, repo, revision).every((p) => p.url !== c.downloadMismatch);
        // No key: a note on an earlier load is about the file as it stood, which the download replaces.
        if (needsRestore(c, entry, null, now) && await this.fetchable(manifest, join(this.stored, entry.transfers.file), entry.transfers.sha256)) {
          // Downloading in some replica (the row says so to all of them), or about to here.
          if (due('transfers') || c.downloadFile === 'transfers') held.add(c.id);
          if (due('transfers')) transfers ??= { c, entry, file: 'transfers' };
        } else if (entry.trail !== null && due('trail') && trail === null && c.trailImportedSha !== entry.trail.sha256 && this.importing?.id !== c.id
          // Not over the files an import is still reading: it stops this pass (see trails), and the download starts the next.
          && await this.trailFetchable(manifest, entry)) {
          trail = { c, entry, file: 'trail' };
        }
      }
      if (running !== null) {
        if (running.file === 'trail' && transfers !== null) running.abort.abort('preempted' satisfies Halt);
      } else {
        const next = transfers ?? trail;
        if (next !== null) {
          started = next.c.id;
          this.startDownload(next, repo, revision);
        }
      }
    }
    await this.tidyDownloads(collections, manifest, held, started);
    return held;
  }

  /**
   * Make what a collection says of its download true again. A failure note
   * (and its back-off) of a download no longer wanted, because the Hub has no
   * stored data, the collection is read past it, or its entry is gone, says
   * nothing true, and goes, as restore does for a load. A collection held for
   * a transfers download that has not started is marked as waiting: its
   * file, no progress. A mark on one no longer held is cleared. Fail-soft: it
   * is said again next pass.
   */
  private async tidyDownloads(collections: readonly CollectionRow[], manifest: Manifest, held: ReadonlySet<number>, started: number | null): Promise<void> {
    for (const c of collections) {
      const idle = c.downloadFile === null && this.downloading?.id !== c.id;
      if (c.downloadNote !== null && idle && c.pausedAt === null && !(await this.wantsDownload(c, manifest))) {
        this.downloadsFailed.delete(c.id);
        await this.store.clearDownloadNote(c.id, true).catch(this.logged(c.id, 'download note not cleared'));
      }
      if (held.has(c.id)) {
        if (idle && c.id !== started) await this.store.setDownload(c.id, 'transfers', null).catch(this.logged(c.id, 'waiting download not noted'));
      } else if (c.downloadFile === 'transfers' && c.downloadProgress === null && this.downloading?.id !== c.id) {
        await this.store.setDownload(c.id, null, null).catch(this.logged(c.id, 'waiting download not cleared'));
      }
    }
  }

  /** Whether either of a collection's stored files is to be downloaded, whether or not its turn has come (see downloads). */
  private async wantsDownload(c: CollectionRow, manifest: Manifest): Promise<boolean> {
    const entry = entryFor(manifest, c.chainId, c.address);
    if (entry === null) return false;
    if (needsRestore(c, entry, null, Date.now()) && await this.fetchable(manifest, join(this.stored, entry.transfers.file), entry.transfers.sha256)) return true;
    return entry.trail !== null && c.trailImportedSha !== entry.trail.sha256 && await this.trailFetchable(manifest, entry);
  }

  /** Whether a collection's last download failed and is still waiting out its back-off: the store's, or the one held here. */
  downloadWaits(c: CollectionRow, now: number): boolean {
    return now < (c.downloadRetryAt ?? 0) || now < (this.downloadsFailed.get(c.id)?.retryAt ?? 0);
  }

  /**
   * Run one download in the background, outside every pass: a download of
   * hours holds no job lock and writes no pass, so it is never taken for a
   * stuck or silent ingest. It holds the download lock for its whole length
   * instead, so two replicas never write one part file: one that finds it
   * held starts nothing, the other replica is downloading. Never rejects:
   * it has no caller.
   */
  private startDownload({ c, entry, file }: Wanted, repo: string, revision: string): void {
    const parts = downloadParts(entry, file, this.stored, repo, revision);
    const abort = new AbortController();
    const done = this.store.locked(LOCKS.download, false, async (client) => {
      // A retry: the failure it noted is being tried again, and "could not be downloaded" must not show beside the progress. The back-off count stays.
      if (c.downloadNote !== null) await this.store.clearDownloadNote(c.id, false).catch((err) => console.error('[washtrace] collection %d: download note not cleared: %s', c.id, this.worker.scrubbed(err)));
      return this.fetchStored(client, c.id, file, parts, abort);
    })
      .then(() => {}, (err) => console.error('[washtrace] collection %d: stored data not downloaded: %s', c.id, this.worker.scrubbed(err)))
      .finally(() => { if (this.downloading?.abort === abort) this.downloading = null; });
    this.downloading = { id: c.id, file, abort, done };
  }

  /**
   * One download, said on the collection as it goes: at most once per 1%,
   * fail-soft, and a write that finds the collection paused or deleted stops
   * it, as the next pass would. Its `parts` are fetched in order (the
   * transfers' one file, or a trail's wallets then its flows), and the
   * progress is their bytes on disk out of all of theirs. A part already on
   * disk and matching, from a try stopped after it, is not fetched again. A
   * part file that does not grow for STALL_MS stops it, as a failure. A
   * failure is noted and waits its back-off (a full disk says so); a file
   * that did not match its checksum from its first byte has the manifest
   * asked for again, as a new publish is the likely cause, and is not
   * fetched again at the same publish, by any replica (downloadMismatch,
   * which keeps that file's URL). One resumed from a part is retried whole.
   * A download stopped is no failure: only its progress goes, and its part
   * is kept to resume. Once whole, the next ingest pass loads it as it would
   * files put there by hand.
   *
   * `client` holds the download lock, idle for hours. Out of the pool, no
   * one hears its errors but its LockedRun: an error unheard ends the
   * process. Lost, or found dead by a look once a minute, it fails the
   * download, since the lock went with it.
   */
  private async fetchStored(client: pg.PoolClient, id: number, file: 'transfers' | 'trail', parts: DownloadPart[], abort: AbortController): Promise<void> {
    const run = new LockedRun(client, abort, (share) => this.store.setDownload(id, file, share),
      (err) => console.warn('[washtrace] collection %d: download progress not written: %s', id, this.worker.scrubbed(err)));
    const total = Math.max(1, parts.reduce((n, p) => n + p.bytes, 0));
    // The bytes of the parts before this one, whole on disk.
    let done = 0;
    // The part being fetched, which a failure is about, and whether it resumed from bytes kept on disk.
    let current = parts[0]!;
    let resumed = false;
    let watch: ReturnType<typeof setInterval> | undefined;
    try {
      for (const p of parts) {
        current = p;
        // Whole already, from a try stopped after it, as the pass that wanted this download found it.
        if (this.knownWhole(p.dest, p.sha256)) {
          done += p.bytes;
          continue;
        }
        run.progress(done / total);
        const part = partPath(p.dest, p.sha256);
        // Resumed from bytes kept on disk, a mismatch may be theirs (a crash tears a write), not the Hub's.
        // At once, as watchStall looks: the first part starts in the pass that started the download.
        resumed = false;
        try {
          resumed = (statSync(part, { throwIfNoEntry: false })?.size ?? 0) > 0;
        } catch {
          // Not readable: the download finds out.
        }
        watch = watchStall(part, abort);
        await this.downloadFile(p.url, p.dest, p.sha256, (share) => run.progress((done + share * p.bytes) / total), abort.signal, p.bytes);
        clearInterval(watch);
        // Checked as it was written: the next pass need not hash it again to know it.
        const key = await statKey(p.dest).catch(() => null);
        if (key !== null) this.shas.set(p.dest, { file: key, sha: p.sha256 });
        done += p.bytes;
      }
      await run.writes;
      this.downloadsFailed.delete(id);
      await this.store.downloadDone(id).catch(this.logged(id, 'finished download not noted'));
      console.info('[washtrace] collection %d: stored %s downloaded', id, file);
    } catch (err) {
      await run.writes;
      const halt: Halt | null = abort.signal.aborted ? abort.signal.reason : null;
      if (halt === 'stopped' || halt === 'preempted') {
        await this.store.setDownload(id, null, null).catch(this.logged(id, 'stopped download not cleared'));
        return;
      }
      const why = halt === 'stalled' ? `nothing came for ${STALL_MS / 60_000} minutes`
        : halt === 'lost' ? `the connection holding its lock was lost (${this.worker.scrubbed(run.lost)})` : this.worker.scrubbed(err);
      console.error('[washtrace] collection %d: stored %s not downloaded: %s', id, file, why);
      // The Hub's own bytes, from the first: they would come again. Resumed, the part is gone and the next try starts at its first byte.
      // A part fetched whole before this one is on disk, and is not fetched again.
      const mismatch = err instanceof StoredDataError && err.kind === 'mismatch' && !resumed;
      if (mismatch) this.hubAskedAt = -Infinity;
      const failures = (this.downloadsFailed.get(id)?.failures ?? 0) + 1;
      this.downloadsFailed.set(id, { failures, retryAt: Date.now() + retryMs(failures) });
      const note = mismatch ? DOWNLOAD_NOTES.mismatch : err instanceof StoredDataError && err.kind === 'disk' ? DOWNLOAD_NOTES.disk : DOWNLOAD_NOTES.failed;
      await this.store.downloadFailed(id, note, mismatch ? current.url : null).catch(this.logged(id, 'failed download not noted'));
    } finally {
      clearInterval(watch);
      run.close();
    }
  }

  /** Download `url` to `dest`, resumable and checked against `sha256`, whose size is `bytes` (see hub.ts). Tests override it on the instance. */
  downloadFile(url: string, dest: string, sha256: string, onProgress: (share: number) => void, signal: AbortSignal, bytes?: number): Promise<void> {
    return download(url, dest, sha256, onProgress, signal, bytes);
  }
}

/**
 * What shaOnDisk keys a file's sha256 on, and what a trail read checks
 * against to skip hashing it again: its size, modified time and change
 * time, as storedKey. The change time catches a copy that kept the
 * modified time (cp -p, rsync -t). Null when there is no file.
 */
async function statKey(path: string): Promise<string | null> {
  try {
    return keyOf(await stat(path));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** A stat as statKey keys it. */
function keyOf(s: Stats): string {
  return `${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
}

/**
 * The files a download of `file` fetches, in order: the transfers' one, or a
 * trail's wallets then its flows, each named as the cut names it, at
 * `revision` of `repo`, and kept in `dir`.
 */
function downloadParts(entry: StoredEntry, file: 'transfers' | 'trail', dir: string, repo: string, revision: string): DownloadPart[] {
  const part = (which: StoredPart, { sha256, bytes }: StoredFileMeta): DownloadPart => {
    const name = storedFile(entry.chainId, entry.address, which);
    return { url: hubUrl(repo, revision, name), dest: join(dir, name), sha256, bytes };
  };
  return file === 'transfers' ? [part('transfers', entry.transfers)] : [part('wallets', entry.trail!.files.wallets), part('flows', entry.trail!.files.flows)];
}

/**
 * Stop a download as stalled once its part file has not grown for STALL_MS.
 * The part's size, not the progress, is the measure: progress comes once per
 * 1%, which for gigabytes on a slow line can be minutes apart. A stat every
 * STALL_CHECK_MS, not a wait, so it costs nothing.
 */
function watchStall(part: string, abort: AbortController): ReturnType<typeof setInterval> {
  let size = -1;
  let grewAt = Date.now();
  const timer = setInterval(() => {
    let now = -1;
    try {
      now = statSync(part, { throwIfNoEntry: false })?.size ?? -1;
    } catch {
      // Not readable: as good as no bytes.
    }
    if (now !== size) {
      size = now;
      grewAt = Date.now();
    } else if (Date.now() - grewAt >= STALL_MS) abort.abort('stalled' satisfies Halt);
  }, STALL_CHECK_MS);
  timer.unref?.();
  return timer;
}

/** `p`, or a rejection with `signal`'s reason once it aborts first: for a read that may never return. */
function orAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}
