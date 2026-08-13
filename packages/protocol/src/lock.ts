import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { LockTimeoutError } from './errors.js';
import { ensureDir, isErrno, removeIfExists, sleep, statOrNull } from './fsutil.js';

export interface LockOptions {
  /** Give up and throw {@link LockTimeoutError} after this long. */
  timeoutMs?: number;
  /** A lock file older than this is assumed to belong to a dead process. */
  staleMs?: number;
  /** Base delay between acquisition attempts; jitter is added on top. */
  retryMs?: number;
}

const DEFAULTS = { timeoutMs: 5_000, staleMs: 30_000, retryMs: 8 } as const;

/**
 * Tail of the in-process queue for each lock path.
 *
 * Two callers inside one process would otherwise fight over the same lock file
 * through the filesystem, burning retries on contention they can settle in memory.
 */
const inProcessQueues = new Map<string, Promise<unknown>>();

/**
 * Run `fn` while holding an exclusive lock, serialising both across processes (via
 * an `O_EXCL` lock file) and inside this one (via a promise queue).
 *
 * Timing note: staleness is measured against real wall-clock time, because it is
 * compared with the lock file's mtime, which no injected clock controls.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T> | T,
  options: LockOptions = {},
): Promise<T> {
  const key = path.resolve(lockPath);
  const previous = inProcessQueues.get(key) ?? Promise.resolve();

  let releaseQueue!: () => void;
  const queued = previous
    .catch(() => undefined)
    .then(() => new Promise<void>((resolve) => { releaseQueue = resolve; }));
  inProcessQueues.set(key, queued);

  await previous.catch(() => undefined);
  try {
    return await withCrossProcessLock(key, fn, options);
  } finally {
    releaseQueue();
    if (inProcessQueues.get(key) === queued) inProcessQueues.delete(key);
  }
}

async function withCrossProcessLock<T>(
  lockPath: string,
  fn: () => Promise<T> | T,
  options: LockOptions,
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const staleMs = options.staleMs ?? DEFAULTS.staleMs;
  const retryMs = options.retryMs ?? DEFAULTS.retryMs;
  const deadline = Date.now() + timeoutMs;

  await acquire(lockPath, { deadline, staleMs, retryMs, timeoutMs });
  try {
    return await fn();
  } finally {
    await removeIfExists(lockPath);
  }
}

async function acquire(
  lockPath: string,
  ctx: { deadline: number; staleMs: number; retryMs: number; timeoutMs: number },
): Promise<void> {
  for (;;) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      try {
        await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`, 'utf8');
      } finally {
        await handle.close();
      }
      return;
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        // Parent directory does not exist yet; create it and try again.
        await ensureDir(path.dirname(lockPath));
        continue;
      }
      if (!isErrno(error, 'EEXIST')) throw error;

      const held = await statOrNull(lockPath);
      if (held && Date.now() - held.mtimeMs > ctx.staleMs) {
        // The holder is gone (crashed, killed). Break the lock and retry; if another
        // waiter breaks it first, our next `open` simply loses the race and retries.
        await removeIfExists(lockPath);
        continue;
      }
      if (Date.now() >= ctx.deadline) throw new LockTimeoutError(lockPath, ctx.timeoutMs);
      await sleep(ctx.retryMs + Math.floor(Math.random() * ctx.retryMs));
    }
  }
}
