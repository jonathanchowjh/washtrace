import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { commit, createRepo, whoAmI, type CommitFile } from '@huggingface/hub';
import { Agent, fetch as undiciFetch } from 'undici';
import {
  MIGRATIONS, STORED_REPO, Store, datasetCard, entryFor, fetchManifest, mergeManifest, messageOf, parseManifest, parseTarget, cutCollection,
  readTransfers, readTrail, storedFile,
  type Manifest, type StoredEntry,
} from '@washtrace/detect';

/**
 * How long one upload request may wait for the Hub's answer. The Hub answers
 * a block of a large file (up to about 64 MB) only once all of it is in, so on
 * a slow uplink one takes past fetch's default 300 s, and the commit fails as
 * "fetch failed" near its end, as the first upload of the dataset did twice.
 */
export const UPLOAD_TIMEOUT_MS = 30 * 60_000;

/** A fetch for the commit that waits `timeoutMs` for an answer instead of 300 s. */
export function uploadFetch(timeoutMs = UPLOAD_TIMEOUT_MS): typeof fetch {
  const dispatcher = new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
  return ((input, init) => undiciFetch(input as never, { ...init, dispatcher } as never)) as typeof fetch;
}

function bad(name: string): never {
  throw new Error(`${name} is not <chainId>/<address>`);
}

export const PUBLISH_USAGE = 'usage: npm run publish:hub -- --store <url> [--dry-run] [<chainId>/<address> ...]\n       npm run publish:hub -- --from <dir> [--check]';

/**
 * The CLI's arguments, or null when they are not a usage: `--from` stands
 * alone (with `--check` only), and `--check` means nothing without it.
 */
export function parsePublishArgs(args: string[]): { dryRun: boolean; check: boolean; url?: string; from?: string; names: string[] } | null {
  let dryRun = false;
  let check = false;
  let url: string | undefined;
  let from: string | undefined;
  const names: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') dryRun = true;
    else if (args[i] === '--check') check = true;
    else if (args[i] === '--store') url = args[++i];
    else if (args[i] === '--from') from = args[++i];
    else names.push(args[i]!);
  }
  if (names.some((n) => n.startsWith('--')) || [url, from].some((v) => v?.startsWith('--'))) return null;
  if (from !== undefined) {
    if (from === '' || url !== undefined || dryRun || names.length > 0) return null;
  } else if (!url || check) return null;
  return { dryRun, check, url, from, names };
}

/**
 * Publishes stored data to the Hub dataset, for the maintainer. It reads a
 * store the prep script migrated, cuts each collection's transfers and trail
 * into a temp folder, and commits them with the merged manifest and the
 * dataset card in one commit. A class because every step needs the same
 * store, token, repo and folder. `runFrom` publishes a folder a dry run
 * already wrote instead, with no store.
 *
 * Nothing here parses arguments or exits: publish-main.ts does. Hub calls
 * are in `remote`, `ensureRepo` and `commit`, so a test replaces them on the
 * instance.
 */
export class Publisher {
  /** The folder the commit reads its files from: the temp folder `run` cuts into, or the one `runFrom` is given. */
  dir = '';

  constructor(readonly store: Store | null, private readonly token: string | undefined, readonly repo: string = STORED_REPO) {}

  /**
   * Cut and publish `names` (`<chainId>/<address>`), or every watched
   * collection when none are named. With `dryRun` the files go to
   * ./publish-dry instead and the Hub is only read, anonymously. Returns the
   * commit's URL, or the folder a dry run wrote.
   */
  async run(names: string[], { dryRun }: { dryRun: boolean }): Promise<string> {
    // Publish never migrates: a store left at an old schema would cut from tables it half understands.
    if ((await this.cutStore().schemaVersion()) !== MIGRATIONS.length) {
      throw new Error("Run scripts/publish-prep.sh first: this store's schema is not current, and publish never migrates.");
    }
    if (!dryRun && !this.token) throw new Error('HF_TOKEN is not set: publishing needs a Hugging Face token that can write to the dataset.');
    if (!dryRun) await this.ensureRepo();
    // A repo with no manifest is empty; one that cannot be read must not be published over, or the others would be dropped.
    // A dry run publishes nothing, so it may go on when the dataset does not exist yet: the Hub answers an
    // anonymous read of one with 401, not 404. Only that; any other error aborts, as it does a real publish.
    const remote = await this.remote().catch((err: unknown) => {
      if (!dryRun || (err as { status?: number }).status !== 401) throw err;
      console.warn('[publish] %s has no public dataset yet; the dry run covers only the collections named', this.repo);
      return null;
    });
    // Only this folder is removed below: a folder `runFrom` was given is never run()'s to delete.
    this.dir = await mkdtemp(join(tmpdir(), 'washtrace-publish-'));
    try {
      const cut = await this.cut(names);
      if (cut.length === 0) throw new Error('No collection to publish.');
      const merged = mergeManifest(remote, cut);
      const ops = await this.operations(cut, merged);
      const message = `Publish ${cut.map((e) => e.name).join(', ')} through block ${Math.max(...cut.map((e) => e.throughBlock))}`;
      if (dryRun) return await this.write(ops);
      return await this.commit(ops, message);
    } finally {
      await rm(this.dir, { recursive: true, force: true });
    }
  }

  /**
   * Publish a dry run's folder as it stands, instead of cutting again.
   * Everything the folder's manifest lists is read row by row first (see
   * `fromDir`), then, unless `check`, committed in one commit with the
   * manifest merged into the Hub's and the card regenerated. The folder is
   * only read. With `check` nothing touches the network or needs a token.
   */
  async runFrom(dir: string, { check }: { check: boolean }): Promise<string> {
    if (!check && !this.token) throw new Error('HF_TOKEN is not set: publishing needs a Hugging Face token that can write to the dataset.');
    const entries = await this.fromDir(dir);
    if (check) return `${dir} matches its manifest: ${entries.map((e) => e.name).join(', ')}`;
    await this.ensureRepo();
    // Only a missing dataset (404, which fetchManifest answers with null) is empty: any error aborts, a 401 included.
    const remote = await this.remote();
    for (const e of entries) {
      const theirs = remote ? entryFor(remote, e.chainId, e.address) : null;
      if (theirs && theirs.throughBlock > e.throughBlock) {
        throw new Error(`the Hub has a newer cut of ${e.name} (block ${theirs.throughBlock}) than ${dir} (block ${e.throughBlock})`);
      }
    }
    const merged = mergeManifest(remote, entries);
    this.dir = dir;
    const message = `Publish ${entries.map((e) => e.name).join(', ')} through block ${Math.max(...entries.map((e) => e.throughBlock))}`;
    return await this.commit(await this.operations(entries, merged), message);
  }

  /**
   * The folder's manifest entries, each file checked against them before any
   * network call: the size, the sha256, every header and field count (the
   * readers do those), and the row counts. A file the manifest does not list
   * is never opened. Any mismatch refuses the whole folder.
   */
  async fromDir(dir: string): Promise<StoredEntry[]> {
    const refuse = (file: string, what: string): never => { throw new Error(`${file} in ${dir} does not match its manifest: ${what}`); };
    let manifest: Manifest;
    try {
      manifest = parseManifest(await readFile(join(dir, 'manifest.json'), 'utf8'));
    } catch (err) {
      return refuse('manifest.json', messageOf(err));
    }
    if (manifest.collections.length === 0) throw new Error('No collection to publish.');
    for (const e of manifest.collections) {
      const trail = e.trail;
      const parts = [{ ...e.transfers, wallets: null as number | null }, ...(trail ? [{ file: storedFile(e.chainId, e.address, 'trail'), ...trail }] : [])];
      for (const { file, bytes, sha256, rows: want, wallets: wantWallets } of parts) {
        const size = await stat(join(dir, file)).then((s) => s.size, () => null);
        if (size === null) refuse(file, 'the file is missing');
        if (size !== bytes) refuse(file, `it is ${size} bytes, the manifest says ${bytes}`);
        let rows = 0;
        let wallets = 0;
        try {
          if (wantWallets === null) for await (const batch of readTransfers(join(dir, file), sha256)) rows += batch.length;
          else for await (const batch of readTrail(join(dir, file), sha256)) { wallets += batch.checked.length; rows += batch.flows.length; }
        } catch (err) {
          refuse(file, messageOf(err));
        }
        if (rows !== want) refuse(file, `it has ${rows} rows, the manifest says ${want}`);
        if (wantWallets !== null && wallets !== wantWallets) refuse(file, `it has ${wallets} checked wallets, the manifest says ${wantWallets}`);
      }
    }
    return manifest.collections;
  }

  /** The store a cut reads. A publisher made for `runFrom` has none. */
  private cutStore(): Store {
    if (!this.store) throw new Error('No store: this publisher can only publish a folder (runFrom).');
    return this.store;
  }

  /** Each named collection (or every one not paused), with its transfers and trail written to the temp folder. */
  async cut(names: string[]): Promise<StoredEntry[]> {
    const targets = names.length > 0
      ? names.map((n) => parseTarget(n) ?? bad(n))
      : (await this.cutStore().collections()).filter((c) => c.pausedAt === null).map((c) => ({ chainId: c.chainId, address: c.address }));
    const out: StoredEntry[] = [];
    for (const { chainId, address } of targets) out.push(await cutCollection(this.cutStore(), this.dir, chainId, address, { trail: true }));
    return out;
  }

  /** What the commit adds: the cut files (read from disk as they upload), the merged manifest and the card. */
  async operations(cut: StoredEntry[], merged: Manifest): Promise<CommitFile[]> {
    const files = cut.flatMap((e) => [e.transfers.file, ...(e.trail ? [storedFile(e.chainId, e.address, 'trail')] : [])]);
    return [
      ...files.map((path): CommitFile => ({ operation: 'addOrUpdate', path, content: pathToFileURL(join(this.dir, path)) })),
      { operation: 'addOrUpdate', path: 'manifest.json', content: new Blob([`${JSON.stringify(merged, null, 2)}\n`]) },
      { operation: 'addOrUpdate', path: 'README.md', content: new Blob([datasetCard(merged)]) },
    ];
  }

  /** The repo's manifest, anonymously: null when there is none yet, a throw when the Hub cannot be read. */
  async remote(): Promise<Manifest | null> {
    return fetchManifest(this.repo);
  }

  /** The name the token belongs to. Tests override it on the instance. */
  async whoAmI(): Promise<string> {
    return (await whoAmI({ accessToken: this.accessToken() })).name;
  }

  /**
   * Whoever the token is, and the public dataset created if it is not there
   * yet. A token that is not the repo's owner is refused before anything is
   * created: createRepo would make the repo under the token's own name or fail
   * late, and the publish would go somewhere unintended. The message names
   * the account, never the token.
   */
  async ensureRepo(): Promise<void> {
    const name = await this.whoAmI();
    const owner = this.repo.split('/')[0]!;
    if (name !== owner) {
      throw new Error(`HF_TOKEN belongs to ${name}, but the target repo is ${this.repo}: set WASHTRACE_STORED_REPO or use a token for ${owner}.`);
    }
    console.info('[publish] publishing to %s as %s', this.repo, name);
    try {
      await createRepo({ repo: { type: 'dataset', name: this.repo }, visibility: 'public', accessToken: this.accessToken() });
      console.info('[publish] created %s', this.repo);
    } catch (err) {
      // 409: it exists already, which is the usual case.
      if ((err as { statusCode?: number }).statusCode !== 409) throw err;
    }
  }

  /** The token, for a call that writes. A dry run never gets here. */
  private accessToken(): string {
    if (!this.token) throw new Error('HF_TOKEN is not set');
    return this.token;
  }

  /** The one commit. The only place a file or the token goes to the Hub. */
  async commit(operations: CommitFile[], title: string): Promise<string> {
    const out = await commit({ repo: { type: 'dataset', name: this.repo }, operations, title, accessToken: this.accessToken(), fetch: uploadFetch() });
    return out?.commit.url ?? `https://huggingface.co/datasets/${this.repo}`;
  }

  /** A dry run's output: the same files, in ./publish-dry, replacing what was there. */
  private async write(ops: CommitFile[]): Promise<string> {
    const out = join(process.cwd(), 'publish-dry');
    await rm(out, { recursive: true, force: true });
    await mkdir(out, { recursive: true });
    for (const op of ops) {
      const dest = join(out, op.path);
      if (op.content instanceof URL) await copyFile(fileURLToPath(op.content), dest);
      else await writeFile(dest, Buffer.from(await op.content.arrayBuffer()));
    }
    return out;
  }
}
