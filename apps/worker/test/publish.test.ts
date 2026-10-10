import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATIONS, STORED_REPO, storedFile, writeTransfers, writeTrail, type Manifest, type StoredEntry, type Store } from '@washtrace/detect';
import { Publisher, parsePublishArgs } from '../src/publish.js';

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

describe('publish --from', () => {
  const rowsOf = (n: number) => Array.from({ length: n }, (_, i) => ({
    txHash: `0xtx${i}`, logIndex: 0, blockNumber: i + 1, blockTime: null, tokenId: '1', from: addr('a'), to: addr('b'),
    marketplace: null, priceWei: null, currency: null,
  }));

  /** A dry-run folder as publish:hub writes one: a real transfers and trail file, their manifest and a card of its own. */
  async function folder(over: Partial<StoredEntry> = {}): Promise<{ dir: string; entry: StoredEntry }> {
    const dir = await mkdtemp(join(work, 'from-'));
    const address = addr('b2');
    const file = storedFile(1, address, 'transfers');
    const t = await writeTransfers(join(dir, file), rowsOf(3));
    async function* checked() { yield addr('a'); yield addr('b'); }
    async function* flows() { yield { txHash: '0xf', kind: 'native' as const, from: addr('a'), to: addr('b'), valueWei: '1', token: '', blockNumber: 1, blockTime: 1 }; }
    const tr = await writeTrail(join(dir, storedFile(1, address, 'trail')), { checked: checked(), flows: flows() });
    const e = entry(address, {
      name: 'Contract', transfers: { file, ...t },
      trail: { rows: tr.rows, wallets: tr.wallets, checked: tr.wallets, of: tr.wallets, bytes: tr.bytes, sha256: tr.sha256 }, ...over,
    });
    await writeFile(join(dir, 'manifest.json'), `${JSON.stringify({ version: 2, collections: [e] }, null, 2)}\n`);
    await writeFile(join(dir, 'README.md'), 'the dry run card, never uploaded\n');
    return { dir, entry: e };
  }

  /** Every file's name, size and hash: the folder's whole state. */
  async function snapshot(dir: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const f of (await readdir(dir)).sort()) out[f] = `${(await stat(join(dir, f))).size}:${createHash('sha256').update(await readFile(join(dir, f))).digest('hex')}`;
    return out;
  }

  /** A publisher with no store, whose Hub calls are fakes. */
  function fromPublisher(remote: Manifest | null) {
    const p = new Publisher(null, TOKEN, 'someone/data');
    p.remote = vi.fn(async () => remote);
    p.ensureRepo = vi.fn(async () => {});
    p.commit = vi.fn(async () => 'https://huggingface.co/datasets/someone/data/commit/abc');
    return p;
  }

  it('uploads the folder\'s files with a regenerated card in one commit, and leaves the folder as it was', async () => {
    const { dir } = await folder();
    const before = await snapshot(dir);
    const other = entry(addr('a1'), { name: 'Other' });
    const p = fromPublisher({ version: 2, revision: 'c'.repeat(40), collections: [other] });
    const seen = new Map<string, string>();
    p.commit = vi.fn(async (ops: { path: string; content: Blob | URL }[]) => {
      for (const op of ops) seen.set(op.path, op.content instanceof Blob ? await op.content.text() : fileURLToPath(op.content));
      return 'url';
    });
    await p.runFrom(dir, { check: false });
    expect(p.ensureRepo).toHaveBeenCalledTimes(1);
    expect(p.commit).toHaveBeenCalledTimes(1);
    const [, message] = (p.commit as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(message).toBe('Publish Contract through block 100');
    expect([...seen.keys()].sort()).toEqual(['README.md', 'manifest.json', storedFile(1, addr('b2'), 'trail'), storedFile(1, addr('b2'), 'transfers')].sort());
    expect(seen.get(storedFile(1, addr('b2'), 'transfers'))).toBe(join(dir, storedFile(1, addr('b2'), 'transfers')));
    expect(seen.get('README.md')).toContain('# washtrace data');
    expect(seen.get('README.md')).toContain(addr('a1'));
    expect(seen.get('README.md')).not.toContain('never uploaded');
    expect((JSON.parse(seen.get('manifest.json')!) as Manifest).collections.map((e) => e.address)).toEqual([addr('a1'), addr('b2')]);
    expect(await snapshot(dir)).toEqual(before);

    // A refusal leaves it as it was too.
    await writeFile(join(dir, storedFile(1, addr('b2'), 'transfers')), 'x', { flag: 'a' });
    const after = await snapshot(dir);
    await expect(p.runFrom(dir, { check: false })).rejects.toThrow('does not match its manifest');
    expect(await snapshot(dir)).toEqual(after);
  });

  it('--check verifies and uploads nothing', async () => {
    const { dir } = await folder();
    const p = new Publisher(null, undefined, 'someone/data');
    p.remote = vi.fn(async () => null);
    p.ensureRepo = vi.fn(async () => {});
    p.commit = vi.fn(async () => 'url');
    await expect(p.runFrom(dir, { check: true })).resolves.toContain('matches its manifest');
    expect(p.remote).not.toHaveBeenCalled();
    expect(p.ensureRepo).not.toHaveBeenCalled();
    expect(p.commit).not.toHaveBeenCalled();
  });

  it('refuses a file whose sha256 or row count does not match, before any network call', async () => {
    const { dir } = await folder();
    const p = fromPublisher(null);
    const name = storedFile(1, addr('b2'), 'transfers');
    // The same size with one byte flipped: the sha256 catches it.
    const bytes = await readFile(join(dir, name));
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    await writeFile(join(dir, name), bytes);
    await expect(p.runFrom(dir, { check: false })).rejects.toThrow(`${name} in ${dir} does not match its manifest`);

    // The real hash and size, but the wrong number of rows.
    const rows = await folder();
    const manifest = JSON.parse(await readFile(join(rows.dir, 'manifest.json'), 'utf8')) as Manifest;
    manifest.collections[0]!.transfers.rows = 4;
    await writeFile(join(rows.dir, 'manifest.json'), JSON.stringify(manifest));
    await expect(p.runFrom(rows.dir, { check: false })).rejects.toThrow('it has 3 rows, the manifest says 4');

    expect(p.ensureRepo).not.toHaveBeenCalled();
    expect(p.remote).not.toHaveBeenCalled();
    expect(p.commit).not.toHaveBeenCalled();
  });

  it('refuses a missing file, a wrong size and a wrong checked-wallet count', async () => {
    const p = fromPublisher(null);
    const { dir } = await folder();
    const trail = storedFile(1, addr('b2'), 'trail');
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as Manifest;
    manifest.collections[0]!.trail!.wallets = 5;
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
    await expect(p.fromDir(dir)).rejects.toThrow(`${trail} in ${dir} does not match its manifest: it has 2 checked wallets, the manifest says 5`);
    manifest.collections[0]!.trail!.bytes += 1;
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
    await expect(p.fromDir(dir)).rejects.toThrow('the manifest says');
    await rm(join(dir, trail));
    await expect(p.fromDir(dir)).rejects.toThrow(`${trail} in ${dir} does not match its manifest: the file is missing`);
  });

  it('never uploads a file the manifest does not list', async () => {
    const { dir } = await folder();
    await writeFile(join(dir, 'stray.csv.zst'), 'not zstd, would fail if read');
    const p = fromPublisher(null);
    await p.runFrom(dir, { check: false });
    const ops = (p.commit as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { path: string }[];
    expect(ops.map((o) => o.path)).not.toContain('stray.csv.zst');
    expect(ops).toHaveLength(4);
  });

  it('refuses a folder older than the Hub\'s cut', async () => {
    const { dir } = await folder();
    const p = fromPublisher({ version: 2, revision: 'c'.repeat(40), collections: [entry(addr('b2'), { name: 'Contract', throughBlock: 250 })] });
    await expect(p.runFrom(dir, { check: false })).rejects.toThrow(`the Hub has a newer cut of Contract (block 250) than ${dir} (block 100)`);
    expect(p.commit).not.toHaveBeenCalled();
    // The same block is not older.
    p.remote = vi.fn(async () => ({ version: 2, collections: [entry(addr('b2'), { throughBlock: 100 })] }) as Manifest);
    await p.runFrom(dir, { check: false });
    expect(p.commit).toHaveBeenCalledTimes(1);
  });

  it('aborts when the remote cannot be read, a 401 included', async () => {
    const { dir } = await folder();
    const p = fromPublisher(null);
    p.remote = vi.fn(async () => { throw Object.assign(new Error('Hugging Face answered 401 for someone/data'), { status: 401 }); });
    await expect(p.runFrom(dir, { check: false })).rejects.toThrow('401');
    expect(p.commit).not.toHaveBeenCalled();
  });

  it('refuses --store, --dry-run or collection names beside it', () => {
    expect(parsePublishArgs(['--from', '/d'])).toMatchObject({ from: '/d', check: false });
    expect(parsePublishArgs(['--from', '/d', '--check'])).toMatchObject({ from: '/d', check: true });
    expect(parsePublishArgs(['--from', '/d', '--store', 'postgres://x'])).toBeNull();
    expect(parsePublishArgs(['--from', '/d', '--dry-run'])).toBeNull();
    expect(parsePublishArgs(['--from', '/d', `1/${addr('b2')}`])).toBeNull();
    expect(parsePublishArgs(['--from'])).toBeNull();
    expect(parsePublishArgs(['--check'])).toBeNull();
    expect(parsePublishArgs(['--store', 'postgres://x', '--check'])).toBeNull();
    expect(parsePublishArgs(['--store', 'postgres://x', '--dry-run'])).toMatchObject({ url: 'postgres://x', dryRun: true });
  });

  it('run() leaves a folder it did not create alone', async () => {
    const { dir } = await folder();
    const before = await snapshot(dir);
    const p = publisher(null);
    p.dir = dir;
    await p.run([], { dryRun: false });
    expect(await snapshot(dir)).toEqual(before);
  });
});
