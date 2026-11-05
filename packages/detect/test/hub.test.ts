import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { download, fetchManifest, hubUrl, partPath, removeStaleParts } from '../src/hub.js';
import { storedFile, type StoredEntry } from '../src/stored.js';

const body = Buffer.from(Array.from({ length: 5_000 }, (_, i) => i % 251));
const sha = createHash('sha256').update(body).digest('hex');
const REV = 'c0ffee'.padEnd(40, '0');
const MANIFEST = '{"version":2,"collections":[]}';

let server: Server;
let base: string;
let dir: string;
/** What the next request does, and what the last one asked. */
let handler: (req: IncomingMessage, res: ServerResponse) => void;
let lastRange: string | undefined;

/** Serves `body`, honouring Range with a 206. */
function serveBody(req: IncomingMessage, res: ServerResponse): void {
  lastRange = req.headers.range;
  const m = /^bytes=(\d+)-$/.exec(lastRange ?? '');
  if (m) {
    const from = Number(m[1]);
    if (from >= body.length) return void res.writeHead(416).end();
    res.writeHead(206, { 'content-range': `bytes ${from}-${body.length - 1}/${body.length}`, 'content-length': body.length - from });
    return void res.end(body.subarray(from));
  }
  res.writeHead(200, { 'content-length': body.length });
  res.end(body);
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'washtrace-hub-'));
  server = createServer((req, res) => handler(req, res));
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((ok) => server.close(ok));
  await rm(dir, { recursive: true, force: true });
});

const exists = (p: string) => access(p).then(() => true, () => false);

describe('hubUrl', () => {
  it('builds the resolve URL', () => {
    expect(hubUrl('u/d', 'abc', 'x.csv.zst', 'http://h')).toBe('http://h/datasets/u/d/resolve/abc/x.csv.zst');
  });
});

describe('fetchManifest', () => {
  it('pins the revision the Hub answered with, and sends no token', async () => {
    let seen: IncomingMessage['headers'] = {};
    handler = (req, res) => {
      seen = req.headers;
      expect(req.url).toBe('/datasets/u/d/resolve/main/manifest.json');
      res.writeHead(200, { 'x-repo-commit': REV }).end(MANIFEST);
    };
    expect(await fetchManifest('u/d', base)).toEqual({ version: 2, revision: REV, collections: [] });
    expect(seen.authorization).toBeUndefined();
  });

  it('is null for a repo with no manifest, and throws on a 500', async () => {
    handler = (_req, res) => void res.writeHead(404).end();
    expect(await fetchManifest('u/d', base)).toBeNull();
    handler = (_req, res) => void res.writeHead(500).end();
    await expect(fetchManifest('u/d', base)).rejects.toThrow('Hugging Face answered 500 for u/d');
  });

  it('exposes the HTTP status on the error it throws, for a 401 as for a 500', async () => {
    handler = (_req, res) => void res.writeHead(401, { 'x-error-code': 'RepoNotFound' }).end();
    await expect(fetchManifest('u/d', base)).rejects.toMatchObject({ status: 401, message: 'Hugging Face answered 401 for u/d' });
    handler = (_req, res) => void res.writeHead(503).end();
    await expect(fetchManifest('u/d', base)).rejects.toMatchObject({ status: 503 });
  });

  it('refuses an answer with no revision, or one that is not a commit sha', async () => {
    handler = (_req, res) => void res.writeHead(200).end(MANIFEST);
    await expect(fetchManifest('u/d', base)).rejects.toThrow('Hugging Face gave no revision for u/d');
    handler = (_req, res) => void res.writeHead(200, { 'x-repo-commit': '../main' }).end(MANIFEST);
    await expect(fetchManifest('u/d', base)).rejects.toThrow('Hugging Face gave no revision for u/d');
  });

  it('gives up when its signal aborts, though the Hub never answers', async () => {
    handler = () => {};
    const ac = new AbortController();
    const run = fetchManifest('u/d', base, ac.signal);
    ac.abort();
    await expect(run).rejects.toThrow();
  });
});

describe('download', () => {
  it('writes the file and reports progress to 1', async () => {
    handler = serveBody;
    const dest = join(dir, 'sub', 'whole.bin');
    const shares: number[] = [];
    await download(`${base}/f`, dest, sha, (s) => shares.push(s));
    expect(await readFile(dest)).toEqual(body);
    expect(await exists(partPath(dest, sha))).toBe(false);
    expect(shares.at(-1)).toBe(1);
    expect(shares.filter((s) => s === 1)).toHaveLength(1);
    expect(shares).toEqual([...shares].sort((a, b) => a - b));
  });

  it('resumes a part file with a Range request', async () => {
    handler = serveBody;
    const dest = join(dir, 'resume.bin');
    const half = body.length / 2;
    await writeFile(partPath(dest, sha), body.subarray(0, half));
    const shares: number[] = [];
    await download(`${base}/f`, dest, sha, (s) => shares.push(s));
    expect(lastRange).toBe(`bytes=${half}-`);
    expect(await readFile(dest)).toEqual(body);
    expect(shares[0]!).toBeGreaterThanOrEqual(0.5);
  });

  it('starts over when the server ignores Range', async () => {
    handler = (req, res) => {
      lastRange = req.headers.range;
      res.writeHead(200, { 'content-length': body.length }).end(body);
    };
    const dest = join(dir, 'ignored.bin');
    await writeFile(partPath(dest, sha), 'junk');
    await download(`${base}/f`, dest, sha, () => {});
    expect(lastRange).toBe('bytes=4-');
    expect(await readFile(dest)).toEqual(body);
  });

  it('starts over once when the part is longer than the file (416)', async () => {
    handler = serveBody;
    const dest = join(dir, 'long.bin');
    await writeFile(partPath(dest, sha), Buffer.alloc(body.length + 10));
    await download(`${base}/f`, dest, sha, () => {});
    expect(await readFile(dest)).toEqual(body);
  });

  it('never resumes a part of another file', async () => {
    handler = serveBody;
    const dest = join(dir, 'other.bin');
    const other = partPath(dest, 'f'.repeat(64));
    await writeFile(other, 'someone else');
    await download(`${base}/f`, dest, sha, () => {});
    expect(lastRange).toBeUndefined();
    expect(await readFile(dest)).toEqual(body);
    expect(await readFile(other, 'utf8')).toBe('someone else');
  });

  it('hashes a complete part without asking the server', async () => {
    let asked = 0;
    handler = (req, res) => { asked += 1; serveBody(req, res); };
    const dest = join(dir, 'complete.bin');
    await writeFile(partPath(dest, sha), body);
    const shares: number[] = [];
    await download(`${base}/f`, dest, sha, (s) => shares.push(s), undefined, body.length);
    expect(asked).toBe(0);
    expect(await readFile(dest)).toEqual(body);
    expect(await exists(partPath(dest, sha))).toBe(false);
    expect(shares).toEqual([1]);
    // A complete part that is wrong is deleted and refused, as a downloaded one is.
    const bad = join(dir, 'complete-bad.bin');
    await writeFile(partPath(bad, sha), Buffer.alloc(body.length));
    await expect(download(`${base}/f`, bad, sha, () => {}, undefined, body.length)).rejects.toMatchObject({ kind: 'mismatch' });
    expect(asked).toBe(0);
    expect(await exists(partPath(bad, sha))).toBe(false);
  });

  it('refuses a file whose sha256 is not the manifest\'s', async () => {
    handler = serveBody;
    const dest = join(dir, 'bad.bin');
    const wrong = '0'.repeat(64);
    await expect(download(`${base}/f`, dest, wrong, () => {})).rejects.toMatchObject({ kind: 'mismatch' });
    expect(await exists(dest)).toBe(false);
    expect(await exists(partPath(dest, wrong))).toBe(false);
  });

  it('stops when aborted, keeping the part file', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-length': body.length });
      res.write(body.subarray(0, 1_000));
      // The rest never comes.
    };
    const dest = join(dir, 'aborted.bin');
    const ac = new AbortController();
    const run = download(`${base}/f`, dest, sha, (s) => { if (s > 0) setTimeout(() => ac.abort(), 50); }, ac.signal);
    await expect(run).rejects.toThrow();
    expect(await exists(dest)).toBe(false);
    expect((await readFile(partPath(dest, sha))).length).toBeGreaterThan(0);
  });
});

describe('removeStaleParts', () => {
  const A = `0x${'a1'.repeat(20)}`, B = `0x${'b2'.repeat(20)}`;
  const entry = (address: string, t: string, r: string | null): StoredEntry => ({
    chainId: 1, address, name: 'X', startBlock: 1, throughBlock: 2, throughTime: 0,
    transfers: { file: storedFile(1, address, 'transfers'), rows: 1, bytes: 1, sha256: t.repeat(64) },
    trail: r === null ? null : { rows: 1, wallets: 1, checked: 1, of: 1, bytes: 1, sha256: r.repeat(64) },
  });

  it('removes the part of a file the manifest names no more, and keeps every other file', async () => {
    const d = join(dir, 'parts');
    await mkdir(d, { recursive: true });
    const at = (file: string) => join(d, file);
    const keep = [
      // The manifest's own, still to resume.
      partPath(at(storedFile(1, A, 'transfers')), 'a'.repeat(64)),
      partPath(at(storedFile(1, A, 'trail')), 'b'.repeat(64)),
      // Whole files, the manifest's write and a local cut's: none is a download's part.
      at(storedFile(1, A, 'transfers')), at('manifest.json.part'), at(`${storedFile(1, B, 'trail')}.part`),
    ];
    const stale = [
      // Its file published again with other content.
      partPath(at(storedFile(1, A, 'trail')), 'c'.repeat(64)),
      // A collection the manifest no longer has, or another dataset's.
      partPath(at(storedFile(1, B, 'transfers')), 'd'.repeat(64)),
    ];
    for (const f of [...keep, ...stale]) await writeFile(f, 'x');
    const removed = await removeStaleParts(d, { version: 2, collections: [entry(A, 'a', 'b')] });
    expect(removed.sort()).toEqual(stale.map((f) => f.slice(d.length + 1)).sort());
    expect((await readdir(d)).sort()).toEqual(keep.map((f) => f.slice(d.length + 1)).sort());
  });

  it('finds nothing to do in a folder that is not there yet', async () => {
    expect(await removeStaleParts(join(dir, 'none'), { version: 2, collections: [] })).toEqual([]);
  });
});
