import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { zstdDecompressSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATIONS, STORED_REPO, storedFile, writeTransfers, type Manifest, type StoredEntry, type Store } from '@washtrace/detect';
import { Publisher } from '../src/publish.js';

/** An operation's bytes as text: a Blob's text, or the file a URL names (decompressed, as a reader of the dataset sees it). */
async function contentOf(op: { path: string; content: Blob | URL }): Promise<string> {
  if (op.content instanceof Blob) return op.content.text();
  const bytes = await readFile(fileURLToPath(op.content));
  return `${bytes.toString('latin1')}\n${zstdDecompressSync(bytes).toString('utf8')}`;
}

const TOKEN = 'hf_test_token_never_real';
const addr = (n: string): string => `0x${n.padStart(40, '0')}`;

function entry(address: string, more: Partial<StoredEntry> = {}): StoredEntry {
  return {
    chainId: 1, address, name: address, startBlock: 1, throughBlock: 100, throughTime: 1_700_000_000_000,
    transfers: { file: storedFile(1, address, 'transfers'), rows: 0, bytes: 0, sha256: '0'.repeat(64) }, trail: null, ...more,
  };
}

/** A store that knows only what these tests ask of it; the rest throws, so a stray call is noticed. */
function fakeStore(over: Record<string, unknown> = {}): Store & { migrate: ReturnType<typeof vi.fn> } {
  return { schemaVersion: async () => MIGRATIONS.length, migrate: vi.fn(), ...over } as never;
}

let work: string;
let cwd: string;
beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'washtrace-publish-test-'));
  cwd = process.cwd();
});
afterEach(async () => {
  process.chdir(cwd);
  await rm(work, { recursive: true, force: true });
});

/** A publisher whose cut writes a real transfers file for each address, and whose Hub calls are fakes. */
function publisher(remote: Manifest | null, over: { store?: Store; token?: string | undefined } = {}) {
  const p = new Publisher(over.store ?? fakeStore(), 'token' in over ? over.token : TOKEN, 'someone/data');
  p.remote = vi.fn(async () => remote);
  p.ensureRepo = vi.fn(async () => {});
  p.cut = vi.fn(async (names: string[]) => {
    const out: StoredEntry[] = [];
    for (const name of names.length > 0 ? names : [`1/${addr('b2')}`]) {
      const address = name.split('/')[1]!;
      const file = storedFile(1, address, 'transfers');
      const w = await writeTransfers(join(p.dir, file), []);
      out.push(entry(address, { name: 'Contract', transfers: { file, ...w } }));
    }
    return out;
  });
  p.commit = vi.fn(async () => 'https://huggingface.co/datasets/someone/data/commit/abc');
  return p;
}

describe('publish', () => {
  it('refuses a store whose schema is not current, and never migrates it', async () => {
    const store = fakeStore({ schemaVersion: async () => 3 });
    const p = publisher(null, { store });
    await expect(p.run([], { dryRun: false })).rejects.toThrow('Run scripts/publish-prep.sh first: this store\'s schema is not current, and publish never migrates.');
    expect(store.migrate).not.toHaveBeenCalled();
    expect(p.commit).not.toHaveBeenCalled();
  });

  it('refuses without a token unless it is a dry run', async () => {
    const p = new Publisher(fakeStore(), undefined, 'someone/data');
    await expect(p.run([], { dryRun: false })).rejects.toThrow('HF_TOKEN');
  });

  it('uploads the cut files, the manifest and the card in one commit, and never the token', async () => {
    // A real cut over a store whose console label holds the token: a leak from the store, the config or the label would show.
    const store = fakeStore({
      storedHeader: async () => ({ id: 7, name: `console label ${TOKEN}`, contractName: 'Contract', startBlock: 1, throughBlock: 100, throughTime: 1_700_000_000_000 }),
      storedTransfers: () => (async function* () {})(),
      trail: async () => ({ checked: 0, of: 0, addresses: (async function* () {})(), flows: (async function* () {})() }),
    });
    const p = new Publisher(store, TOKEN, 'someone/data');
    p.remote = async () => null;
    p.ensureRepo = vi.fn(async () => {});
    // Read inside the commit: the cut files are gone from the temp folder once the run ends.
    const seen = new Map<string, string>();
    p.commit = vi.fn(async (ops: { path: string; content: Blob | URL }[]) => {
      for (const op of ops) seen.set(op.path, await contentOf(op));
      return 'https://huggingface.co/datasets/someone/data/commit/abc';
    });
    await p.run([`1/${addr('b2')}`], { dryRun: false });
    expect(p.commit).toHaveBeenCalledTimes(1);
    const [, message] = (p.commit as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect([...seen.keys()].sort()).toEqual(
      ['README.md', 'manifest.json', storedFile(1, addr('b2'), 'trail'), storedFile(1, addr('b2'), 'transfers')].sort());
    expect(message).toBe('Publish Contract through block 100');
    expect(seen.get('manifest.json')).toContain('Contract');
    for (const [path, text] of seen) expect(text, path).not.toContain(TOKEN);
    expect(message).not.toContain(TOKEN);
    expect(seen.get('manifest.json')).not.toContain('console label');
  });

  it('of one collection leaves the others in the manifest', async () => {
    const other = entry(addr('a1'), { name: 'Other' });
    const p = publisher({ version: 2, revision: 'c'.repeat(40), collections: [other] });
    await p.run([`1/${addr('b2')}`], { dryRun: false });
    const ops = (p.commit as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { path: string; content: Blob }[];
    const manifest = JSON.parse(await ops.find((o) => o.path === 'manifest.json')!.content.text()) as Manifest;
    expect(manifest.collections.map((e) => e.address)).toEqual([addr('a1'), addr('b2')]);
    expect(manifest.revision).toBeUndefined();
    const card = await ops.find((o) => o.path === 'README.md')!.content.text();
    expect(card).toContain(addr('a1'));
  });

  it('stops when the remote manifest cannot be read', async () => {
    const p = publisher(null);
    p.remote = vi.fn(async () => { throw new Error('Hugging Face answered 503 for someone/data'); });
    await expect(p.run([], { dryRun: false })).rejects.toThrow('503');
    expect(p.commit).not.toHaveBeenCalled();
  });

  it('names a collection by its contract, not its console label', async () => {
    const header = { id: 7, name: 'My console label', contractName: 'Bored Apes', startBlock: 1, throughBlock: 50, throughTime: 1_700_000_000_000 };
    const store = fakeStore({
      storedHeader: async () => header,
      storedTransfers: () => (async function* () {})(),
      trail: async () => ({ checked: 0, of: 0, addresses: (async function* () {})(), flows: (async function* () {})() }),
    });
    const p = new Publisher(store, TOKEN, 'someone/data');
    p.dir = work;
    expect((await p.cut([`1/${addr('c0')}`]))[0]!.name).toBe('Bored Apes');
    header.contractName = null as never;
    expect((await p.cut([`1/${addr('c0')}`]))[0]!.name).toBe(addr('c0'));
    header.contractName = '' as never;
    expect((await p.cut([`1/${addr('c0')}`]))[0]!.name).toBe(addr('c0'));
    expect(await readdir(work)).toContain(storedFile(1, addr('c0'), 'trail'));
  });

  it('a dry run writes ./publish-dry, makes no Hub write, and needs no token', async () => {
    process.chdir(work);
    const p = publisher(null, { token: undefined });
    await p.run([], { dryRun: true });
    expect(p.commit).not.toHaveBeenCalled();
    expect(p.ensureRepo).not.toHaveBeenCalled();
    expect((await readdir(join(work, 'publish-dry'))).sort()).toEqual(['README.md', 'manifest.json', storedFile(1, addr('b2'), 'transfers')].sort());
    expect(await readFile(join(work, 'publish-dry', 'manifest.json'), 'utf8')).toContain(addr('b2'));
  });

  const hubError = (status: number) => Object.assign(new Error(`Hugging Face answered ${status} for someone/data`), { status });

  it('a dry run goes on when the dataset does not exist yet (401), and aborts on any other Hub error', async () => {
    process.chdir(work);
    const p = publisher(null, { token: undefined });
    p.remote = vi.fn(async () => { throw hubError(401); });
    await p.run([], { dryRun: true });
    expect(await readdir(join(work, 'publish-dry'))).toContain('manifest.json');
    p.remote = vi.fn(async () => { throw hubError(503); });
    await expect(p.run([], { dryRun: true })).rejects.toThrow('503');
  });

  it('a real publish aborts on a 401 from the remote', async () => {
    const p = publisher(null);
    p.remote = vi.fn(async () => { throw hubError(401); });
    await expect(p.run([], { dryRun: false })).rejects.toThrow('401');
    expect(p.commit).not.toHaveBeenCalled();
  });

  it('defaults to the project dataset', () => {
    expect(new Publisher(fakeStore(), TOKEN).repo).toBe(STORED_REPO);
  });
});

describe('Publisher.ensureRepo', () => {
  it('refuses a token that is not the repo\'s owner, naming both and never the token', async () => {
    const p = new Publisher(fakeStore(), TOKEN, 'someone/data');
    p.whoAmI = vi.fn(async () => 'else');
    const err = await p.ensureRepo().then(() => null, (e: Error) => e);
    expect(err?.message).toBe('HF_TOKEN belongs to else, but the target repo is someone/data: set WASHTRACE_STORED_REPO or use a token for someone.');
    expect(err?.message).not.toContain(TOKEN);
  });
});
