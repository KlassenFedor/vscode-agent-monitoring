import { promises as fs, type Stats } from 'node:fs';

/** Narrow an unknown throw to a Node filesystem error, optionally matching its code. */
export function isErrno(error: unknown, ...codes: string[]): error is NodeJS.ErrnoException {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as NodeJS.ErrnoException).code;
  if (typeof code !== 'string') return false;
  return codes.length === 0 || codes.includes(code);
}

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

/**
 * `fs.stat` that answers `null` instead of throwing when the file cannot be seen.
 *
 * Absent is the ordinary case. EPERM is the Windows one: a file being deleted while
 * another handle is open is neither there nor gone, and callers here — staleness
 * checks on a lock — want the same answer for both, which is "no information, wait".
 */
export async function statOrNull(filePath: string): Promise<Stats | null> {
  try {
    return await fs.stat(filePath);
  } catch (error) {
    if (isErrno(error, 'ENOENT', 'ENOTDIR', 'EPERM', 'EACCES')) return null;
    throw error;
  }
}

/**
 * Delete a file if it is there, waiting out a reader that is holding it.
 *
 * The retry is for Windows, and the caller that needs it is lock release: unlinking a
 * file somebody has open fails with EPERM there, and a lock this process cannot
 * release is a lock every other process must then wait thirty seconds to declare
 * stale. The competing handle is a single short read, so a few attempts settle it.
 */
export async function removeIfExists(filePath: string, attempts = 10): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.unlink(filePath);
      return;
    } catch (error) {
      if (isErrno(error, 'ENOENT', 'ENOTDIR')) return;
      if (attempt >= attempts || !isErrno(error, 'EPERM', 'EACCES', 'EBUSY')) throw error;
      await sleep(Math.min(attempt * 20, 100));
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
