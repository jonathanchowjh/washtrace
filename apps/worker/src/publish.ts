import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { commit, createRepo, whoAmI, type CommitFile } from '@huggingface/hub';
import {
  MIGRATIONS, STORED_REPO, Store, datasetCard, fetchManifest, mergeManifest, storedFile, parseTarget, cutCollection,
  type Manifest, type StoredEntry,
} from '@washtrace/detect';

function bad(name: string): never {
  throw new Error(`${name} is not <chainId>/<address>`);
}

/**
 * Publishes stored data to the Hub dataset, for the maintainer. It reads a
 * store the prep script migrated, cuts each collection's transfers and trail
 * into a temp folder, and commits them with the merged manifest and the
 * dataset card in one commit. A class because every step needs the same
 * store, token, repo and folder.
 *
 * Nothing here parses arguments or exits: publish-main.ts does. Hub calls
 * are in `remote`, `ensureRepo` and `commit`, so a test replaces them on the
 * instance.
 */
export class Publisher {
  /** The temp folder a run cuts into. Set by `run`. */
  dir = '';

  constructor(readonly store: Store, private readonly token: string | undefined, readonly repo: string = STORED_REPO) {}

  /**
   * Cut and publish `names` (`<chainId>/<address>`), or every watched
   * collection when none are named. With `dryRun` the files go to
   * ./publish-dry instead and the Hub is only read, anonymously. Returns the
   * commit's URL, or the folder a dry run wrote.
   */
  async run(names: string[], { dryRun }: { dryRun: boolean }): Promise<string> {
    // Publish never migrates: a store left at an old schema would cut from tables it half understands.
    if ((await this.store.schemaVersion()) !== MIGRATIONS.length) {
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

  /** Each named collection (or every one not paused), with its transfers and trail written to the temp folder. */
  async cut(names: string[]): Promise<StoredEntry[]> {
    const targets = names.length > 0
      ? names.map((n) => parseTarget(n) ?? bad(n))
      : (await this.store.collections()).filter((c) => c.pausedAt === null).map((c) => ({ chainId: c.chainId, address: c.address }));
    const out: StoredEntry[] = [];
    for (const { chainId, address } of targets) out.push(await cutCollection(this.store, this.dir, chainId, address, { trail: true }));
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
    const out = await commit({ repo: { type: 'dataset', name: this.repo }, operations, title, accessToken: this.accessToken() });
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
