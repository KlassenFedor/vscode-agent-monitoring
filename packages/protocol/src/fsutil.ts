import { promises as fs } from 'node:fs';

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

/** `fs.stat` that answers `null` instead of throwing when the path is absent. */
export async function statOrNull(filePath: string): Promise<import('node:fs').Stats | null> {
  try {
    return await fs.stat(filePath);
  } catch (error) {
    if (isErrno(error, 'ENOENT', 'ENOTDIR')) return null;
    throw error;
  }
}

export async function removeIfExists(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (!isErrno(error, 'ENOENT', 'ENOTDIR')) throw error;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
