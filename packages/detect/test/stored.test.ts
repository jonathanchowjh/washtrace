import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  StoredDataError, entryFor, readManifest, readTransfers, readTrail, sha256File, storedFile, trailPath, upsertEntry, writeTransfers, writeTrail,
  type Manifest, type StoredEntry, type WalletRow,
} from '../src/stored.js';
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
  const wallets: WalletRow[] = [
    { address: a, transfers: 12, status: 'done', truncated: false, depth: 0, fetchedAt: 1_700_000_000_000 },
    { address: b, transfers: 0, status: 'done', truncated: true, depth: 1, fetchedAt: 1_700_000_100_000 },
    { address: c, transfers: 3, status: 'failed', truncated: false, depth: 0, fetchedAt: null },
  ];
  const flows: Flow[] = [
    flow(a, b),
    flow(b, c, { kind: 'token', token: w('e2c0'), valueWei: '340282366920938463463374607431768211455' }),
    flow(c, a, { kind: 'internal' }),
  ];

  it('round-trips wallets and flows in one file', async () => {
    const path = join(dir, 'round.trail.csv.zst');
    const written = await writeTrail(path, { wallets, flows });
    expect(written).toMatchObject({ wallets: 3, rows: 3, bytes: (await readFile(path)).length });
    const batches = await collect(readTrail(path, written.sha256));
    expect({ wallets: batches.flatMap((x) => x.wallets), flows: batches.flatMap((x) => x.flows) }).toEqual({ wallets, flows });
  });

  it('throws StoredDataError on a changed byte', async () => {
    const path = join(dir, 'changed.trail.csv.zst');
    const written = await writeTrail(path, { wallets, flows });
    await expect(collect(readTrail(path, written.sha256.replace(/^./, (ch) => (ch === '0' ? '1' : '0'))))).rejects.toBeInstanceOf(StoredDataError);
  });

  it('refuses a value with a comma on write', async () => {
    const path = join(dir, 'comma.trail.csv.zst');
    await expect(writeTrail(path, { wallets, flows: [flow(a, b, { token: 'x,y' })] })).rejects.toBeInstanceOf(StoredDataError);
    expect((await readdir(dir)).filter((f) => f.startsWith('comma.trail'))).toEqual([]);
  });
});

describe('the manifest', () => {
  it('finds an entry whatever the case of the address', () => {
    const m: Manifest = { version: 1, collections: [entry({ address: '0xabcdef0000000000000000000000000000000001' })] };
    expect(entryFor(m, 1, '0xABCDEF0000000000000000000000000000000001')?.name).toBe('Test');
    expect(entryFor(m, 8453, '0xabcdef0000000000000000000000000000000001')).toBeNull();
    expect(entryFor(m, 1, w('d1ff'))).toBeNull();
  });

  it('replaces an entry for the same collection, and keeps the list in order', () => {
    let m: Manifest = { version: 1, collections: [] };
    m = upsertEntry(m, entry({ address: w('b'), name: 'B' }));
    m = upsertEntry(m, entry({ address: w('a'), name: 'A' }));
    m = upsertEntry(m, entry({ address: w('B').toUpperCase().replace('0X', '0x'), name: 'B again' }));
    expect(m.collections.map((e) => e.name)).toEqual(['A', 'B again']);
  });

  it('reads a missing manifest as empty', async () => {
    expect(await readManifest(join(dir, 'none.json'))).toEqual({ version: 1, collections: [] });
  });

  it('names files by chain and lowercase address', () => {
    expect(storedFile(1, '0xABC', 'transfers')).toBe('1-0xabc.transfers.csv.zst');
    expect(storedFile(1, '0xabc', 'trail')).toBe('1-0xabc.trail.csv.zst');
    // The money trail sits beside the manifest, never named by it.
    expect(trailPath('/app/data/stored', { chainId: 1, address: '0xABC' } as StoredEntry)).toBe('/app/data/stored/1-0xabc.trail.csv.zst');
  });
});
