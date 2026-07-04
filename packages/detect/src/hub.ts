import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseManifest, sha256File, StoredDataError, type Manifest } from './stored.js';

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
 * not exist. An answer without a commit sha is refused, not fetched
 * unpinned: the revision goes into URLs, so it must be a sha, never a name.
 */
export async function fetchManifest(repo: string, endpoint = HUB): Promise<Manifest | null> {
  const res = await fetch(hubUrl(repo, 'main', 'manifest.json', endpoint));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Hugging Face answered ${res.status} for ${repo}`);
  const revision = res.headers.get('x-repo-commit');
  if (revision === null || !/^[0-9a-f]{40}$/.test(revision)) throw new Error(`Hugging Face gave no revision for ${repo}`);
  return { ...parseManifest(await res.text()), revision };
}

/** Where a download is written until it is whole. Named for the checksum, so the part of another publish of the file is never resumed. */
export function partPath(dest: string, sha256: string): string {
  return `${dest}.${sha256.slice(0, 16)}.part`;
}

/**
 * Download `url` to `dest`, checked against `sha256`. It streams into a part
 * file and resumes it with a Range request after a restart or an abort. A
 * server that ignores Range (200) is started over, never appended to, and a
 * part the server calls out of range (416: longer than the file, or already
 * whole) is deleted and started over once. `onProgress` gets the share on
 * disk, at most once per 1%, and 1 at the end. The part is kept when aborted
 * or cut off, and deleted when it is wrong or the disk is full.
 */
export async function download(url: string, dest: string, sha256: string, onProgress: (share: number) => void, signal?: AbortSignal): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  const part = partPath(dest, sha256);
  let offset = await stat(part).then((s) => s.size, () => 0);
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
  const actual = await sha256File(part);
  if (actual !== sha256) {
    await rm(part, { force: true });
    throw new StoredDataError(`${basename(dest)} does not match its checksum (sha256 ${actual}, expected ${sha256})`, 'mismatch');
  }
  await rename(part, dest);
  onProgress(1);
}
