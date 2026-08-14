import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { CorruptFileError } from './errors.js';
import { ensureDir, isErrno, removeIfExists, sleep } from './fsutil.js';

/**
 * Write JSON so that every concurrent reader sees either the previous content or the
 * new content, never a half-written file (TESTS.md PROTO-04).
 *
 * Write to a temporary file in the same directory, flush it, then rename over the
 * target: rename is atomic within a filesystem, which is why the temporary file must
 * be a sibling rather than live in the system temp directory.
 */
export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

/** Same guarantee as {@link writeJsonAtomic}, for arbitrary file contents. */
export async function writeFileAtomic(filePath: string, payload: string | Uint8Array): Promise<void> {
  const dir = path.dirname(filePath);
  await ensureDir(dir);

  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`,
  );

  const handle = await fs.open(tmpPath, 'wx');
  try {
    await handle.writeFile(payload);
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await renameWithRetry(tmpPath, filePath);
  } catch (error) {
    await removeIfExists(tmpPath);
    throw error;
  }
}

/** Read a JSON file. Absent file answers `null`; unparsable file throws. */
export async function readJsonFile(filePath: string): Promise<unknown | null> {
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT', 'ENOTDIR')) return null;
    throw error;
  }

  try {
    return JSON.parse(stripBom(text)) as unknown;
  } catch (error) {
    throw new CorruptFileError(filePath, error);
  }
}

/**
 * On Windows, renaming over a file somebody has open fails with EPERM or EBUSY —
 * there is no atomic replace-while-open the way POSIX has one. Our own readers are
 * exactly that somebody: the extension re-reads `meta.json` on every refresh, and a
 * scanner or indexer can hold a freshly closed file for a few milliseconds too.
 *
 * So the retry window has to outlast a reader, not just a scanner. Reads are short;
 * a second of retries covers a busy poller, and the caller is holding the file lock
 * throughout, so nothing else is queueing behind this write (measured against CI:
 * five attempts over 100ms lost the race, TESTS.md §7).
 */
async function renameWithRetry(from: string, to: string, attempts = 12): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      if (attempt >= attempts || !isErrno(error, 'EPERM', 'EACCES', 'EBUSY')) throw error;
      await sleep(Math.min(attempt * 25, 200));
    }
  }
}

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
