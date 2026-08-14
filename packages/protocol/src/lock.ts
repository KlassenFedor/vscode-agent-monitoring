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

/** How long a lock file with no pid in it is given the benefit of the doubt. */
const NAMELESS_GRACE_MS = 500;

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
    .then(
      () =>
        new Promise<void>((resolve) => {
          releaseQueue = resolve;
        }),
    );
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

      // A killed agent leaves its lock behind. Waiting out the staleness timeout
      // would stall the next writer — the restarted agent, or the human's comment —
      // for half a minute, so the holder is checked for a pulse first.
      if (await holderIsGone(lockPath)) {
        await removeIfExists(lockPath);
        continue;
      }

      const held = await statOrNull(lockPath);
      if (held && Date.now() - held.mtimeMs > ctx.staleMs) {
        // Fallback for a lock whose holder cannot be identified: written by another
        // machine, or by a version that did not record a pid.
        await removeIfExists(lockPath);
        continue;
      }
      if (Date.now() >= ctx.deadline) throw new LockTimeoutError(lockPath, ctx.timeoutMs);
      await sleep(ctx.retryMs + Math.floor(Math.random() * ctx.retryMs));
    }
  }
}

/**
 * Is the process that took this lock still running?
 *
 * Answers false only when the lock names a process that is definitely gone. Anything
 * unclear — an unreadable lock file, a pid from another machine, a process owned by
 * another user — answers true, leaving the staleness timeout as the safety net.
 *
 * Assumes lock holders are local, which they are: the extension host, the MCP server
 * and the hook all run on the machine that holds the files.
 */
async function holderIsGone(lockPath: string): Promise<boolean> {
  let contents: string;
  let stats: Awaited<ReturnType<typeof statOrNull>>;
  try {
    contents = await fs.readFile(lockPath, 'utf8');
    stats = await statOrNull(lockPath);
  } catch {
    return false;
  }

  const pid = Number.parseInt(contents.trim().split(/\s+/)[0] ?? '', 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    // The lock names nobody. Creating the file and writing the pid into it are two
    // syscalls, and a process killed between them leaves exactly this: an empty lock
    // that would otherwise be honoured until the staleness timeout. That gap is
    // microseconds wide, so anything still nameless after the grace period is debris.
    return stats !== null && Date.now() - stats.mtimeMs > NAMELESS_GRACE_MS;
  }
  if (pid === process.pid) return false;

  try {
    // Signal 0 performs the permission and existence checks without delivering it.
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return isErrno(error, 'ESRCH');
  }
}
