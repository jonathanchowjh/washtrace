import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { zstdDecompressSync } from 'node:zlib';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHECKED_COLUMNS, FLOW_COLUMNS, TRANSFER_COLUMNS, StoredDataError, datasetCard, parseTarget, entryFor, mergeManifest, parseManifest, readManifest, writeManifest, readTransfers, readTrail, sha256File, storedFile, storedKey, trailPaths, trailSha, upsertEntry, writeTransfers, writeTrail,
  type Manifest, type StoredEntry,
} from '../src/stored.js';
import { formatBytes } from '../src/bytes.js';
import type { Flow, Transfer } from '../src/types.js';
import { flow, transfer, w } from './fixtures.js';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'washtrace-stored-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const a = w('a'), b = w('b'), c = w('c');

/** Every batch a read yields, in order. */
async function collect<T>(batches: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const batch of batches) out.push(batch);
  return out;
}

function entry(more: Partial<StoredEntry> = {}): StoredEntry {
  return {
    chainId: 1, address: w('c011'), name: 'Test', startBlock: 1, throughBlock: 100, throughTime: 1_700_000_000_000,
    transfers: { file: '1-x.transfers.csv.zst', rows: 0, bytes: 0, sha256: '' }, trail: null, ...more,
  };
}

describe('stored transfers', () => {
  const rows: Transfer[] = [
    // A mint: no sale, no price, no currency.
    transfer('1', w('0'), a, { blockTime: 1_700_000_000 }),
    // A sale paid in the native token: the currency is '', not null.
    transfer('1', a, b, { blockTime: 1_700_000_012, marketplace: 'seaport-1.6', priceWei: '1000000000000000000', currency: '' }),
    // A sale whose price could not be read, and a uint256 token id past 2^53.
    transfer('115792089237316195423570985008687907853269984665640564039457584007913129639935', b, c,
      { blockTime: null, logIndex: 7, marketplace: 'blur', priceWei: null, currency: null }),
  ];

  it('round-trips transfers, nulls included', async () => {
    const path = join(dir, 'round.transfers.csv.zst');
    const written = await writeTransfers(path, rows);
    expect(written.rows).toBe(3);
    expect(written.bytes).toBe((await readFile(path)).length);
    expect(written.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await collect(readTransfers(path, written.sha256))).toEqual([rows]);
  });

  it('takes rows from an async source and reads them back in batches of 5,000', async () => {
    const path = join(dir, 'many.transfers.csv.zst');
    async function* many(): AsyncIterable<Transfer> {
      for (let i = 0; i < 5_001; i++) yield transfer(String(i), a, b, { blockTime: 1_700_000_000 + i });
    }
    const written = await writeTransfers(path, many());
    expect(written.rows).toBe(5_001);
    expect((await collect(readTransfers(path, written.sha256))).map((batch) => batch.length)).toEqual([5_000, 1]);
  });

  it('throws StoredDataError on a changed byte, before yielding anything', async () => {
    const path = join(dir, 'changed.transfers.csv.zst');
    const written = await writeTransfers(path, rows);
    const bytes = await readFile(path);
    const mid = bytes.length >> 1;
    bytes[mid] = bytes[mid]! ^ 0xff;
    await writeFile(path, bytes);
    const seen: Transfer[][] = [];
    await expect((async () => { for await (const batch of readTransfers(path, written.sha256)) seen.push(batch); })())
      .rejects.toMatchObject({ constructor: StoredDataError, kind: 'mismatch' });
    expect(seen).toEqual([]);
  });

  it('throws StoredDataError for a missing file', async () => {
    await expect(collect(readTransfers(join(dir, 'missing.transfers.csv.zst'), 'ab'.repeat(32))))
      .rejects.toMatchObject({ constructor: StoredDataError, kind: 'missing' });
  });

  it('calls a file it may not read, or a directory where the file should be, unreadable', async () => {
    const locked = join(dir, 'locked.transfers.csv.zst');
    await writeFile(locked, 'x');
    await chmod(locked, 0o000);
    try {
      await expect(sha256File(locked)).rejects.toMatchObject({ constructor: StoredDataError, kind: 'unreadable' });
    } finally {
      await chmod(locked, 0o644);
    }
    const folder = join(dir, 'folder.transfers.csv.zst');
    await mkdir(folder);
    await expect(sha256File(folder)).rejects.toMatchObject({ constructor: StoredDataError, kind: 'unreadable' });
    await expect(collect(readTransfers(folder, 'ab'.repeat(32)))).rejects.toMatchObject({ constructor: StoredDataError, kind: 'unreadable' });
  });

  it('leaves a fault of the process, not the file (out of descriptors or memory), as it is, so the load backs off instead of being noted', async () => {
    const path = join(dir, 'busy.transfers.csv.zst');
    const written = await writeTransfers(path, rows);
    for (const code of ['EMFILE', 'ENFILE', 'EAGAIN', 'ENOMEM']) {
      // Open fails at the `fail`th read: 1 is the hash, 2 the read after it.
      for (const fail of [1, 2]) {
        let opened = 0;
        vi.resetModules();
        vi.doMock('node:fs', async (original) => {
          const fs = await original<typeof import('node:fs')>();
          const { PassThrough } = await import('node:stream');
          return {
            ...fs,
            createReadStream: (p: string) => {
              if (++opened !== fail) return fs.createReadStream(p);
              const s = new PassThrough();
              queueMicrotask(() => s.destroy(Object.assign(new Error(`${code}: too many open files, open '${p}'`), { code })));
              return s;
            },
          };
        });
        try {
          const fresh = await import('../src/stored.js');
          const err = await collect(fresh.readTransfers(path, written.sha256)).then(() => null, (e: unknown) => e);
          expect(err).toMatchObject({ code });
          expect(err).not.toBeInstanceOf(fresh.StoredDataError);
        } finally {
          vi.doUnmock('node:fs');
          vi.resetModules();
        }
      }
    }
  });

  it('calls a file that matches its checksum but will not parse unreadable', async () => {
    const path = join(dir, 'garbled.transfers.csv.zst');
    await writeFile(path, 'not zstd');
    await expect(collect(readTransfers(path, await sha256File(path)))).rejects.toMatchObject({ constructor: StoredDataError, kind: 'unreadable' });
  });

  it('refuses a value with a comma rather than quoting it, and leaves no file behind', async () => {
    const path = join(dir, 'comma.transfers.csv.zst');
    await expect(writeTransfers(path, [transfer('1', a, b, { marketplace: 'sea,port' })])).rejects.toBeInstanceOf(StoredDataError);
    expect((await readdir(dir)).filter((f) => f.startsWith('comma.'))).toEqual([]);
  });

  it('refuses a currency without a price: an empty field would read back wrong', async () => {
    const path = join(dir, 'currency.transfers.csv.zst');
    await expect(writeTransfers(path, [transfer('1', a, b, { priceWei: null, currency: '' })])).rejects.toBeInstanceOf(StoredDataError);
  });
});

describe('stored money trail', () => {
  const checked = [a, b];
  const flows: Flow[] = [
    flow(a, b),
    flow(b, c, { kind: 'token', token: w('e2c0'), valueWei: '340282366920938463463374607431768211455' }),
    flow(c, a, { kind: 'internal' }),
  ];
  /** The two files of a trail named for `name`. */
  const pathsOf = (name: string) => ({ wallets: join(dir, `${name}.wallets.csv.zst`), flows: join(dir, `${name}.flows.csv.zst`) });
  const textOf = async (path: string) => zstdDecompressSync(await readFile(path)).toString('utf8');

  it('writeTrail writes the checked wallets and the flows as two plain CSV files', async () => {
    const paths = pathsOf('plain');
    const written = await writeTrail(paths, { checked, flows: [flows[0]!] });
    const wallets = await textOf(paths.wallets);
    const flowsText = await textOf(paths.flows);
    expect(wallets).toBe(`address\n${checked.join('\n')}\n`);
    expect(flowsText.split('\n')[0]).toBe(FLOW_COLUMNS.join(','));
    expect(flowsText.trimEnd().split('\n')[1]).toBe(`${flows[0]!.txHash},${flows[0]!.kind},${a},${b},${flows[0]!.valueWei},${flows[0]!.token},${flows[0]!.blockNumber},${flows[0]!.blockTime}`);
    for (const text of [wallets, flowsText]) {
      expect(text.split('\n').some((l) => l.startsWith('#'))).toBe(false);
      for (const bookkeeping of ['status', 'truncated', 'fetched_at', 'depth', 'transfers']) expect(text).not.toContain(bookkeeping);
    }
    expect(written.files.wallets.sha256).toBe(await sha256File(paths.wallets));
    expect(written.files.flows.sha256).toBe(await sha256File(paths.flows));
    expect(written.files.wallets.bytes).toBe((await readFile(paths.wallets)).length);
    expect(written.files.flows.bytes).toBe((await readFile(paths.flows)).length);
    expect(written.wallets).toBe(checked.length);
    expect(written.rows).toBe(1);
  });

  it('readTrail gives back what writeTrail wrote', async () => {
    const paths = pathsOf('round');
    const written = await writeTrail(paths, { checked, flows });
    expect(written).toMatchObject({ wallets: 2, rows: 3 });
    const batches = await collect(readTrail(paths, written.files));
    expect({ checked: batches.flatMap((x) => x.checked), flows: batches.flatMap((x) => x.flows) }).toEqual({ checked, flows });
  });

  it('readTrail gives the wallet batches first, then the flows', async () => {
    const paths = pathsOf('batched');
    const many = Array.from({ length: 6_000 }, (_, i) => w(i.toString(16).padStart(4, '0')));
    const seven = Array.from({ length: 7 }, (_, i) => flow(a, b, { txHash: `0x${i.toString(16).padStart(64, '0')}` }));
    const written = await writeTrail(paths, { checked: many, flows: seven });
    const batches = await collect(readTrail(paths, written.files));
    expect(batches.map((x) => x.checked.length)).toEqual([5000, 1000, 0]);
    expect(batches.map((x) => x.flows.length)).toEqual([0, 0, 7]);
    expect({ checked: batches.flatMap((x) => x.checked), flows: batches.flatMap((x) => x.flows) }).toEqual({ checked: many, flows: seven });
  });

  it('throws StoredDataError on a changed byte', async () => {
    const paths = pathsOf('changed');
    const written = await writeTrail(paths, { checked, flows });
    const wrong = { ...written.files, wallets: { ...written.files.wallets, sha256: written.files.wallets.sha256.replace(/^./, (ch) => (ch === '0' ? '1' : '0')) } };
    await expect(collect(readTrail(paths, wrong))).rejects.toMatchObject({ kind: 'mismatch', message: expect.stringContaining(paths.wallets) });
  });

  it('readTrail checks both files before the first batch', async () => {
    const paths = pathsOf('both');
    const written = await writeTrail(paths, { checked, flows });
    const wrong = { ...written.files, flows: { ...written.files.flows, sha256: written.files.flows.sha256.replace(/^./, (ch) => (ch === '0' ? '1' : '0')) } };
    const batches = readTrail(paths, wrong)[Symbol.asyncIterator]();
    // The wallets file matches, and its batch would be the first: nothing comes before the flows file is checked.
    const err = await batches.next().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoredDataError);
    expect(err).toMatchObject({ kind: 'mismatch', message: expect.stringContaining(paths.flows) });
  });

  it('readTrail told the files were checked already reads them without their sha256', async () => {
    const paths = pathsOf('checked');
    await writeTrail(paths, { checked, flows });
    const none = { wallets: { bytes: 0, sha256: 'f'.repeat(64) }, flows: { bytes: 0, sha256: 'f'.repeat(64) } };
    const batches = await collect(readTrail(paths, none, false));
    expect(batches.flatMap((x) => x.checked)).toEqual(checked);
    expect(batches.flatMap((x) => x.flows)).toEqual(flows);
  });

  it('a trail with no checked wallets or no flows round-trips', async () => {
    const noWallets = pathsOf('no-wallets');
    const first = await writeTrail(noWallets, { checked: [], flows });
    expect(first.files.wallets.bytes).toBeGreaterThan(0);
    const readFirst = await collect(readTrail(noWallets, first.files));
    expect(readFirst.flatMap((x) => x.checked)).toEqual([]);
    expect(readFirst.flatMap((x) => x.flows)).toEqual(flows);

    const noFlows = pathsOf('no-flows');
    const second = await writeTrail(noFlows, { checked, flows: [] });
    expect(second.files.flows.bytes).toBeGreaterThan(0);
    const readSecond = await collect(readTrail(noFlows, second.files));
    expect(readSecond.flatMap((x) => x.checked)).toEqual(checked);
    expect(readSecond.flatMap((x) => x.flows)).toEqual([]);
  });

  it('trailSha is the sha256 of the two file shas joined by a colon', () => {
    const sha = trailSha({ wallets: { bytes: 1, sha256: 'a'.repeat(64) }, flows: { bytes: 1, sha256: 'b'.repeat(64) } });
    expect(sha).toBe(createHash('sha256').update('a'.repeat(64) + ':' + 'b'.repeat(64)).digest('hex'));
  });

  it('refuses a value with a comma on write', async () => {
    const paths = pathsOf('comma');
    await expect(writeTrail(paths, { checked, flows: [flow(a, b, { token: 'x,y' })] })).rejects.toBeInstanceOf(StoredDataError);
    expect((await readdir(dir)).filter((f) => f.startsWith('comma.'))).toEqual([]);
  });
});

describe('storedKey', () => {
  it('names the manifest\'s sha256 and the file as it stands, so a new cut, a file put back or fixed permissions change it', async () => {
    const path = join(dir, 'keyed.transfers.csv.zst');
    expect(await storedKey(path, 'abc')).toBe('abc:absent');
    await writeFile(path, 'x');
    const first = await storedKey(path, 'abc');
    expect(first).toMatch(/^abc:1:[\d.]+:[\d.]+$/);
    expect(await storedKey(path, 'abc')).toBe(first);
    expect(await storedKey(path, 'def')).toBe(first.replace(/^abc/, 'def'));
    // A chmod changes only the file's ctime: the permissions were fixed, so it is worth reading again.
    await new Promise((r) => setTimeout(r, 10));
    await chmod(path, 0o600);
    expect(await storedKey(path, 'abc')).not.toBe(first);
  });
});

describe('the manifest', () => {
  it('finds an entry whatever the case of the address', () => {
    const m: Manifest = { version: 3, collections: [entry({ address: '0xabcdef0000000000000000000000000000000001' })] };
    expect(entryFor(m, 1, '0xABCDEF0000000000000000000000000000000001')?.name).toBe('Test');
    expect(entryFor(m, 8453, '0xabcdef0000000000000000000000000000000001')).toBeNull();
    expect(entryFor(m, 1, w('d1ff'))).toBeNull();
  });

  it('replaces an entry for the same collection, and keeps the list in order', () => {
    let m: Manifest = { version: 3, collections: [] };
    m = upsertEntry(m, entry({ address: w('b'), name: 'B' }));
    m = upsertEntry(m, entry({ address: w('a'), name: 'A' }));
    m = upsertEntry(m, entry({ address: w('B').toUpperCase().replace('0X', '0x'), name: 'B again' }));
    expect(m.collections.map((e) => e.name)).toEqual(['A', 'B again']);
  });

  it('reads a missing manifest as empty', async () => {
    expect(await readManifest(join(dir, 'none.json'))).toEqual({ version: 3, collections: [] });
  });

  it('parseManifest reads a version 3 manifest and refuses a version 2 one', async () => {
    expect(parseManifest('{"version":3,"collections":[]}')).toEqual({ version: 3, collections: [] });
    const v2 = '{"version":2,"collections":[]}';
    expect(() => parseManifest(v2)).toThrow(expect.objectContaining({ kind: 'unreadable', message: 'not a version 3 manifest: its version is not 3' }));
    const path = join(dir, 'v2.json');
    await writeFile(path, v2);
    await expect(readManifest(path)).rejects.toBeInstanceOf(StoredDataError);
    await expect(readManifest(path)).rejects.toThrow('not a version 3 manifest: its version is not 3');
  });

  it('a manifest of another version is unreadable', () => {
    expect(() => parseManifest('{"version":1,"collections":[]}')).toThrow(expect.objectContaining({ kind: 'unreadable' }));
    expect(() => parseManifest('not json')).toThrow(expect.objectContaining({ kind: 'unreadable' }));
  });

  it('a manifest whose file is not its own name is unreadable', () => {
    const sha = 'a'.repeat(64);
    const good = (more: object = {}, trail: object | null = null) => JSON.stringify({
      version: 3, collections: [{
        chainId: 1, address: w('c011'), name: 'T', startBlock: 1, throughBlock: 2, throughTime: 3,
        transfers: { file: storedFile(1, w('c011'), 'transfers'), rows: 1, bytes: 1, sha256: sha }, trail, ...more,
      }],
    });
    expect(parseManifest(good())).toMatchObject({ version: 3 });
    expect(() => parseManifest(good({ transfers: { file: '../../etc/x', rows: 1, bytes: 1, sha256: sha } }))).toThrow(expect.objectContaining({ kind: 'unreadable' }));
    expect(() => parseManifest(good({ address: '0xABC' }))).toThrow(expect.objectContaining({ kind: 'unreadable' }));
    expect(() => parseManifest(good({ chainId: 0 }))).toThrow(expect.objectContaining({ kind: 'unreadable' }));
    expect(() => parseManifest(good({ transfers: { file: storedFile(1, w('c011'), 'transfers'), rows: -1, bytes: 1, sha256: sha } }))).toThrow(expect.objectContaining({ kind: 'unreadable' }));
    expect(() => parseManifest(good({}, trailOf({ sha256: 'xyz' })))).toThrow(expect.objectContaining({ kind: 'unreadable' }));
    expect(parseManifest(good({}, trailOf()))).toMatchObject({ collections: [{ trail: { files: { wallets: { bytes: 2 } } } }] });
  });

  /** A manifest trail for two files of 2 and 3 bytes, with `more` changed. */
  function trailOf(more: object = {}): object {
    const files = { wallets: { bytes: 2, sha256: 'a'.repeat(64) }, flows: { bytes: 3, sha256: 'b'.repeat(64) } };
    return { rows: 1, wallets: 1, checked: 1, of: 1, bytes: 5, sha256: trailSha(files), files, ...more };
  }

  it('parseManifest refuses a trail whose sha256 is not its files\'', () => {
    const text = JSON.stringify({
      version: 3, collections: [{
        chainId: 1, address: w('c011'), name: 'T', startBlock: 1, throughBlock: 2, throughTime: 3,
        transfers: { file: storedFile(1, w('c011'), 'transfers'), rows: 1, bytes: 1, sha256: 'a'.repeat(64) }, trail: trailOf({ sha256: 'c'.repeat(64) }),
      }],
    });
    expect(() => parseManifest(text)).toThrow("a trail sha256 is not its files'");
  });

  it('parseManifest refuses a trail whose bytes are not its files\'', () => {
    const text = JSON.stringify({
      version: 3, collections: [{
        chainId: 1, address: w('c011'), name: 'T', startBlock: 1, throughBlock: 2, throughTime: 3,
        transfers: { file: storedFile(1, w('c011'), 'transfers'), rows: 1, bytes: 1, sha256: 'a'.repeat(64) }, trail: trailOf({ bytes: 6 }),
      }],
    });
    expect(() => parseManifest(text)).toThrow("a trail size is not its files'");
  });

  it('keeps the revision a manifest was fetched at, and refuses one that is not a commit sha', async () => {
    const rev = 'c0ffee'.padEnd(40, '0');
    expect(parseManifest(`{"version":3,"revision":"${rev}","collections":[]}`)).toEqual({ version: 3, revision: rev, collections: [] });
    const path = join(dir, 'revised.json');
    await writeManifest(path, { version: 3, revision: rev, collections: [] });
    expect(await readManifest(path)).toEqual({ version: 3, revision: rev, collections: [] });
    // The revision goes into download URLs, so a branch name or a path is no revision.
    for (const bad of ['', 'main', 'abc123', '../x', rev.toUpperCase(), `${rev}0`]) {
      expect(() => parseManifest(`{"version":3,"revision":"${bad}","collections":[]}`)).toThrow(expect.objectContaining({ kind: 'unreadable' }));
    }
  });

  it('names files by chain and lowercase address', () => {
    expect(storedFile(1, '0xABC', 'transfers')).toBe('1-0xabc.transfers.csv.zst');
    expect(storedFile(1, '0xabc', 'wallets')).toBe('1-0xabc.wallets.csv.zst');
    expect(storedFile(1, '0xabc', 'flows')).toBe('1-0xabc.flows.csv.zst');
  });

  it('trailPaths names the two files lowercase', () => {
    // The money trail sits beside the manifest, never named by it.
    expect(trailPaths('/app/data/stored', { chainId: 1, address: '0xABC' })).toEqual({
      wallets: '/app/data/stored/1-0xabc.wallets.csv.zst', flows: '/app/data/stored/1-0xabc.flows.csv.zst',
    });
  });
});

describe('mergeManifest', () => {
  const A = entry({ address: w('a1'), name: 'A' });
  const B = entry({ address: w('b2'), name: 'B', throughBlock: 100 });
  const B2 = entry({ address: w('b2'), name: 'B', throughBlock: 200 });

  it('keeps the collections it was not given', () => {
    const merged = mergeManifest({ version: 3, revision: 'a'.repeat(40), collections: [B, A] }, [B2]);
    expect(merged).toEqual({ version: 3, collections: [A, B2] });
    expect('revision' in merged).toBe(false);
    expect(mergeManifest(null, [A])).toEqual({ version: 3, collections: [A] });
  });

  it('sorts by chain, then address', () => {
    const other = entry({ chainId: 137, address: w('01') });
    expect(mergeManifest({ version: 3, collections: [other, B] }, [A]).collections.map((e) => e.address)).toEqual([A.address, B.address, other.address]);
  });
});

describe('datasetCard', () => {
  const REPO = 'u/washtrace-data';
  const m: Manifest = {
    version: 3,
    collections: [
      entry({ address: w('a1'), name: 'Alpha | Club', throughBlock: 123456, throughTime: Date.UTC(2026, 9, 1), transfers: { file: 'x', rows: 5, bytes: 2_097_152, sha256: '' },
        trail: { rows: 9, wallets: 2, checked: 2, of: 3, bytes: 1_048_576, sha256: '', files: { wallets: { bytes: 524_288, sha256: '' }, flows: { bytes: 524_288, sha256: '' } } } }),
      entry({ address: w('b2'), name: w('b2') }),
    ],
  };

  it('lists every collection and the exact columns, and states the licence', () => {
    const card = datasetCard(m, REPO);
    expect(card.startsWith('---\n')).toBe(true);
    expect(card).toContain('license: cc-by-4.0');
    expect(card).toContain('pretty_name: washtrace data');
    expect(card).toContain('tags: [ethereum, nft, wash-trading]');
    expect(card).toContain('Alpha \\| Club');
    expect(card).toContain(w('a1'));
    expect(card).toContain(w('b2'));
    expect(card).toContain('123456');
    expect(card).toContain('2026-10-01');
    expect(card).toContain('2.1 MB');
    expect(card).toContain('1.0 MB');
    expect(card).toContain('tx_hash,log_index,block_number,block_time,token_id,from_address,to_address,marketplace,price_wei,currency');
    expect(card).toContain('tx_hash,kind,from_address,to_address,value_wei,token,block_number,block_time');
    expect(card).not.toContain('#checked');
    expect(card).toContain("compression='zstd'");
    expect(card).toContain('made for [washtrace](https://github.com/jonathanchowjh/washtrace), an NFT wash-trading detector');
    expect(card).toContain('(https://github.com/jonathanchowjh/washtrace#citing)');
  });

  it('says sizes as the console does, in decimal units', () => {
    const big = { ...m, collections: [entry({ address: w('c3'), transfers: { file: 'x', rows: 1, bytes: 3_400_000_000, sha256: '' }, trail: null })] };
    const card = datasetCard(big, REPO);
    expect(card).toContain(`| ${formatBytes(3_400_000_000)} | none |`);
    expect(card).toContain('3.4 GB');
  });

  it('describes the wallets file by what was read, and reads big numbers as text', () => {
    const card = datasetCard(m, REPO);
    expect(card).toContain('wallets whose payments were read to the end of\ntheir history when checked');
    expect(card).not.toContain('included in');
    expect(card).toContain("compression='zstd', dtype=str");
    expect(card).toContain('`dtype=str` keeps `price_wei`, `value_wei` and `token_id` at full precision');
  });

  it('labels the date as the last transfer, in UTC, not the through block\'s date', () => {
    const card = datasetCard(m, REPO);
    expect(card).toContain('| Name | Address | Chain id | Through block | Last transfer (UTC) | Checked wallets | Transfers file | Trail file |');
    expect(card).toContain(`| 123456 | 2026-10-01 |`);
    expect(card).not.toContain('Through block (date)');
    expect(card).toContain('Through block is where the read stops; last transfer is the date of the newest transfer at or below it.');
  });

  it('lists each collection\'s checked-wallet count', () => {
    const card = datasetCard(m, REPO);
    expect(card).toContain('| 2026-10-01 | 2 | 2.1 MB | 1.0 MB |');
    expect(card).toContain(`| ${w('b2')} | 1 | 100 | `);
    expect(card).toMatch(/\| — \| [^|]+ \| none \|/);
  });

  it('reads the three files directly, and the tables through datasets', () => {
    const card = datasetCard(m, REPO);
    expect(card).toContain('pip install pandas zstandard');
    expect(card).toContain("pd.read_csv(");
    expect(card).not.toContain('skiprows');
    expect(card).toContain('.wallets.csv.zst');
    expect(card).toContain('.flows.csv.zst');
    expect(card).toContain('pass `chunksize=` to read them in parts');
    expect(card).not.toContain('.read().decode()');
    expect(card).toContain('from datasets import load_dataset');
    expect(card).toContain(`load_dataset("${REPO}", "flows", split="alpha_club")`);
  });

  /** The card's front matter: the text between its first two `---` lines. */
  const frontOf = (card: string) => card.slice(4, card.indexOf('\n---\n', 4));
  type Front = {
    configs: { config_name: string; data_files: { split: string; path: string }[] }[];
    dataset_info: { config_name: string; features: { name: string; dtype: string }[] }[];
  };

  it('declares a config per table, a split per collection', () => {
    const argonauts = entry({
      address: w('a1'), name: 'Argonauts',
      trail: { rows: 9, wallets: 2, checked: 2, of: 3, bytes: 2, sha256: '', files: { wallets: { bytes: 1, sha256: '' }, flows: { bytes: 1, sha256: '' } } },
    });
    const meebits = entry({ address: w('b2'), name: 'Meebits', trail: null });
    const card = datasetCard({ version: 3, collections: [argonauts, meebits] }, REPO);
    const front = parse(frontOf(card)) as Front;
    expect(front.configs.map((c) => c.config_name)).toEqual(['transfers', 'wallets', 'flows']);
    const files = (name: string) => front.configs.find((c) => c.config_name === name)!.data_files;
    expect(files('transfers')).toEqual([
      { split: 'argonauts', path: storedFile(1, w('a1'), 'transfers') },
      { split: 'meebits', path: storedFile(1, w('b2'), 'transfers') },
    ]);
    expect(files('wallets')).toEqual([{ split: 'argonauts', path: storedFile(1, w('a1'), 'wallets') }]);
    expect(files('flows')).toEqual([{ split: 'argonauts', path: storedFile(1, w('a1'), 'flows') }]);
    for (const [name, columns] of [['transfers', TRANSFER_COLUMNS], ['wallets', CHECKED_COLUMNS], ['flows', FLOW_COLUMNS]] as const) {
      const features = front.dataset_info.find((c) => c.config_name === name)!.features;
      expect(features.map((f) => f.name)).toEqual([...columns]);
      expect(features.every((f) => f.dtype === 'string')).toBe(true);
    }
    expect(card).not.toContain('#checked');
  });

  it('quotes a split name, so a number or a YAML word stays a string', () => {
    const named = (name: string, address: string) => entry({ address, name });
    const card = datasetCard({ version: 3, collections: [named('888', w('a1')), named('On', w('b2'))] }, REPO);
    const front = parse(frontOf(card)) as Front;
    const splits = front.configs.flatMap((c) => c.data_files.map((f) => f.split));
    expect(splits).toEqual(['888', 'on']);
    for (const split of splits) expect(typeof split).toBe('string');
    // PyYAML reads YAML 1.1, where an unquoted on is a boolean: the line itself must be quoted.
    expect(frontOf(card)).toContain('  - split: "on"\n');
    expect(frontOf(card)).toContain('  - split: "888"\n');
  });

  it('names the transfers config in the example when no collection has a trail', () => {
    const card = datasetCard({ version: 3, collections: [entry({ address: w('a1'), name: 'Alone', trail: null })] }, REPO);
    expect(card).toContain(`load_dataset("${REPO}", "transfers", split="alone")`);
    expect(card).not.toContain('"flows", split=');
  });

  it('falls back to the address for a split name that is empty or taken', () => {
    const named = (name: string, address: string) => entry({ address, name });
    const taken = datasetCard({ version: 3, collections: [named('Foo!', w('a1')), named('foo', w('b2'))] }, REPO);
    expect(taken).toContain(`split: "c1_${w('a1')}"\n`);
    expect(taken).toContain(`split: "c1_${w('b2')}"\n`);
    expect(taken).not.toContain('split: "foo"\n');
    const empty = datasetCard({ version: 3, collections: [named('!!!', w('a1'))] }, REPO);
    expect(empty).toContain(`split: "c1_${w('a1')}"\n`);
  });

  it('leaves out a config with no files', () => {
    const card = datasetCard({ version: 3, collections: [entry({ address: w('a1'), name: 'Alone', trail: null })] }, REPO);
    expect(card).toContain('config_name: transfers');
    expect(card).not.toContain('config_name: wallets');
    expect(card).not.toContain('config_name: flows');
  });

  it('says only chain data is included', () => {
    expect(datasetCard(m, REPO)).toMatch(/only data that can be read from the chain/i);
  });
});

describe('parseTarget', () => {
  it('reads <chainId>/<address>, lowercased, and nothing else', () => {
    expect(parseTarget(`1/0x${'AB'.repeat(20)}`)).toEqual({ chainId: 1, address: `0x${'ab'.repeat(20)}` });
    expect(parseTarget('1/0x12')).toBeNull();
    expect(parseTarget(undefined)).toBeNull();
  });
});
