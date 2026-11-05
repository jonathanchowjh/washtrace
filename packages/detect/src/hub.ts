import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseManifest, sha256File, storedFile, StoredDataError, type Manifest } from './stored.js';

/**
 * Hugging Face as the place stored data is downloaded from: the manifest, then
 * the files it names, from one commit of a public dataset. Nothing here sends
 * a token: reading is anonymous, and publishing (the other direction) is a
 * script run by the owner, not the worker.
 */

export const HUB = 'https://huggingface.co';
/** The dataset the project publishes to; a deployment may point `stored.repo` elsewhere. */
export const STORED_REPO = 'jonathanmiro97/washtrace-data';

/** A file of a dataset at one commit. Pinned to a revision, so a publish in the middle of a download cannot mix two. */
export function hubUrl(repo: string, revision: string, file: string, endpoint = HUB): string {
  return `${endpoint}/datasets/${repo}/resolve/${revision}/${file}`;
}

/**
 * The repo's manifest as of its latest commit, with `revision` set to that
 * commit (the Hub names it in `x-repo-commit`), so the files are fetched from
 * the same publish as the manifest. Null when the repo or its manifest does
 * not exist. (An anonymous read of a dataset that does not exist, or is private, is answered 401, not 404: it
 * is thrown with `status` set, and the callers that take it as "no such public dataset" say so.) An answer without a commit sha is refused, not fetched
 * unpinned: the revision goes into URLs, so it must be a sha, never a name.
 * `signal` gives up on a Hub that never answers.
 */
export async function fetchManifest(repo: string, endpoint = HUB, signal?: AbortSignal): Promise<Manifest | null> {
  const res = await fetch(hubUrl(repo, 'main', 'manifest.json', endpoint), { signal });
  if (res.status === 404) return null;
  // The status rides on the error so a caller can tell a missing public dataset (401) from a Hub that is down.
  if (!res.ok) throw Object.assign(new Error(`Hugging Face answered ${res.status} for ${repo}`), { status: res.status });
  const revision = res.headers.get('x-repo-commit');
  if (revision === null || !/^[0-9a-f]{40}$/.test(revision)) throw new Error(`Hugging Face gave no revision for ${repo}`);
  return { ...parseManifest(await res.text()), revision };
}

/** Where a download is written until it is whole. Named for the checksum, so the part of another publish of the file is never resumed. */
export function partPath(dest: string, sha256: string): string {
  return `${dest}.${sha256.slice(0, 16)}.part`;
}

/** A download's part, as partPath names it: never the manifest's own write, nor a local cut's (`<file>.part`). */
const PART = /\.csv\.zst\.[0-9a-f]{16}\.part$/;

/**
 * Delete the download parts in `dir` that `manifest` names no file for: one
 * whose file was published again with other content, or whose collection (or
 * dataset) is gone. Each is kept to resume only while its checksum is the
 * manifest's, so these would never be resumed, and a trail's is a gigabyte.
 * Says which went. The caller holds the download lock, so no part removed is
 * one a download is writing.
 */
export async function removeStaleParts(dir: string, manifest: Manifest): Promise<string[]> {
  const wanted = new Set<string>();
  for (const e of manifest.collections) {
    wanted.add(basename(partPath(storedFile(e.chainId, e.address, 'transfers'), e.transfers.sha256)));
    if (e.trail !== null) wanted.add(basename(partPath(storedFile(e.chainId, e.address, 'trail'), e.trail.sha256)));
  }
  const names = await readdir(dir).catch((err) => { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []; throw err; });
  const stale = names.filter((n) => PART.test(n) && !wanted.has(n));
  for (const n of stale) await rm(join(dir, n), { force: true });
  return stale;
}

/**
 * Download `url` to `dest`, checked against `sha256`. It streams into a part
 * file and resumes it with a Range request after a restart or an abort. A
 * server that ignores Range (200) is started over, never appended to, and a
 * part the server calls out of range (416: longer than the file, or already
 * whole) is deleted and started over once. `onProgress` gets the share on
 * disk, at most once per 1%, and 1 at the end. The part is kept when aborted
 * or cut off, and deleted when it is wrong or the disk is full. With the
 * file's expected `bytes`, a part of exactly that size is checked without a
 * request.
 */
export async function download(url: string, dest: string, sha256: string, onProgress: (share: number) => void, signal?: AbortSignal, bytes?: number): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  const part = partPath(dest, sha256);
  const offset = await stat(part).then((s) => s.size, () => 0);
  // A part already as long as the file is whole (a restart between the last byte and the rename): asking would only get a 416, and a second copy.
  if (bytes === undefined || offset !== bytes) await fetchPart(url, dest, part, offset, onProgress, signal);
  const actual = await sha256File(part);
  if (actual !== sha256) {
    await rm(part, { force: true });
    throw new StoredDataError(`${basename(dest)} does not match its checksum (sha256 ${actual}, expected ${sha256})`, 'mismatch');
  }
  await rename(part, dest);
  onProgress(1);
}

/** Stream `url` into `part` from `offset` on (see download). */
async function fetchPart(url: string, dest: string, part: string, offset: number, onProgress: (share: number) => void, signal?: AbortSignal): Promise<void> {
  let res = await fetch(url, { headers: offset > 0 ? { range: `bytes=${offset}-` } : {}, signal });
  if (res.status === 416) {
    await res.body?.cancel();
    await rm(part, { force: true });
    offset = 0;
    res = await fetch(url, { signal });
  }
  if (!res.ok || res.body === null) throw new Error(`Hugging Face answered ${res.status} for ${basename(dest)}`);
  if (res.status !== 206) offset = 0;
  const length = Number(res.headers.get('content-length'));
  const total = Number(/\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1]) || (length > 0 ? length + offset : 0);

  let have = offset;
  let said = -1;
  async function* counted(chunks: AsyncIterable<Buffer>): AsyncIterable<Buffer> {
    for await (const c of chunks) {
      have += c.length;
      const percent = total > 0 ? Math.floor((have / total) * 100) : -1;
      if (percent > said && percent < 100) {
        said = percent;
        onProgress(have / total);
      }
      yield c;
    }
  }
  try {
    await pipeline(Readable.fromWeb(res.body as never), counted, createWriteStream(part, { flags: offset > 0 ? 'a' : 'w' }), { signal });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOSPC') {
      await rm(part, { force: true });
      throw new StoredDataError(`not enough disk space for ${basename(dest)}`, 'disk');
    }
    throw err;
  }
}
