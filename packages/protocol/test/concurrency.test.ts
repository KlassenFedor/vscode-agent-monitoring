import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { LockTimeoutError } from '../src/errors.js';
import { readJsonl } from '../src/jsonl.js';
import { withFileLock } from '../src/lock.js';
import { makeRoot, readText } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const worker = path.join(here, 'workers', 'append-worker.ts');

function runWorker(filePath: string, count: number, tag: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // `--import tsx` lets the child run the TypeScript sources directly, so the test
    // does not depend on a build step having run first.
    const child = spawn(process.execPath, ['--import', 'tsx', worker, filePath, String(count), tag], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`worker ${tag} exited with ${code}\n${stderr}`));
    });
  });
}

describe('concurrent appends', () => {
  it('PROTO-30: four processes append without tearing lines or losing records', async () => {
    const file = path.join(await makeRoot(), 'events.jsonl');
    const workers = 4;
    const perWorker = 250;

    await Promise.all(
      Array.from({ length: workers }, (_, index) => runWorker(file, perWorker, `w${index}`)),
    );

    const raw = await readText(file);
    const lines = raw.trimEnd().split('\n');
    expect(lines).toHaveLength(workers * perWorker);

    const chunk = await readJsonl(file, 0, (value) => value as { seq: number; tag: string });
    expect(chunk.skipped).toBe(0);
    expect(chunk.records).toHaveLength(workers * perWorker);

    // Every sequence number was handed out exactly once: no gaps, no duplicates.
    const seqs = chunk.records.map((r) => r.seq).sort((a, b) => a - b);
    expect(seqs[0]).toBe(1);
    expect(seqs.at(-1)).toBe(workers * perWorker);
    expect(new Set(seqs).size).toBe(workers * perWorker);

    // Each worker really did write its full share.
    for (let index = 0; index < workers; index += 1) {
      expect(chunk.records.filter((r) => r.tag === `w${index}`)).toHaveLength(perWorker);
    }
  }, 60_000);
});

describe('withFileLock', () => {
  it('serialises overlapping critical sections in one process', async () => {
    const lock = path.join(await makeRoot(), 'x.lock');
    let active = 0;
    let maxActive = 0;

    await Promise.all(
      Array.from({ length: 8 }, () =>
        withFileLock(lock, async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
        }),
      ),
    );

    expect(maxActive).toBe(1);
  });

  it('releases the lock file even when the critical section throws', async () => {
    const lock = path.join(await makeRoot(), 'x.lock');

    await expect(
      withFileLock(lock, () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    await expect(fs.stat(lock)).rejects.toThrow();
    await expect(withFileLock(lock, () => 'ok')).resolves.toBe('ok');
  });

  it('gives up with LockTimeoutError when the holder never releases', async () => {
    const root = await makeRoot();
    const lock = path.join(root, 'x.lock');
    await fs.writeFile(lock, 'other-process\n', 'utf8');

    await expect(
      withFileLock(lock, () => 'unreachable', { timeoutMs: 80, retryMs: 5, staleMs: 60_000 }),
    ).rejects.toThrow(LockTimeoutError);
  });

  it('breaks a lock left behind by a dead process', async () => {
    const root = await makeRoot();
    const lock = path.join(root, 'x.lock');
    await fs.writeFile(lock, 'dead-process\n', 'utf8');
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(lock, old, old);

    await expect(
      withFileLock(lock, () => 'recovered', { timeoutMs: 500, retryMs: 5, staleMs: 1_000 }),
    ).resolves.toBe('recovered');
  });
});

describe('a lock left behind by a crash', () => {
  it('PROTO-47: is taken over at once when its holder is gone', async () => {
    const lock = path.join(await makeRoot(), 'x.lock');

    // A process that existed and then died, exactly like an agent under SIGKILL.
    const victim = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
    await new Promise((resolve) => victim.once('spawn', resolve));
    const deadPid = victim.pid as number;
    victim.kill('SIGKILL');
    await new Promise((resolve) => victim.once('exit', resolve));

    await fs.writeFile(lock, `${deadPid} ${new Date().toISOString()}\n`, 'utf8');

    const started = Date.now();
    // Waiting out the staleness timeout would stall the next writer for half a minute.
    await expect(
      withFileLock(lock, () => 'recovered', { timeoutMs: 2_000, staleMs: 60_000 }),
    ).resolves.toBe('recovered');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('PROTO-47: waits for a holder that is still alive', async () => {
    const lock = path.join(await makeRoot(), 'x.lock');
    await fs.writeFile(lock, `${process.pid} ${new Date().toISOString()}\n`, 'utf8');

    await expect(
      withFileLock(lock, () => 'unreachable', { timeoutMs: 100, retryMs: 5, staleMs: 60_000 }),
    ).rejects.toThrow(LockTimeoutError);
  });

  it('PROTO-48: takes over an empty lock file left by a kill between two syscalls', async () => {
    const lock = path.join(await makeRoot(), 'x.lock');
    // Creating the lock and naming its owner are two syscalls. A process killed
    // between them leaves this, and honouring it would stall the next writer.
    await fs.writeFile(lock, '', 'utf8');
    const justOld = new Date(Date.now() - 2_000);
    await fs.utimes(lock, justOld, justOld);

    await expect(
      withFileLock(lock, () => 'recovered', { timeoutMs: 2_000, staleMs: 60_000 }),
    ).resolves.toBe('recovered');
  });

  it('PROTO-48: still respects a lock that was created a moment ago', async () => {
    const lock = path.join(await makeRoot(), 'x.lock');
    await fs.writeFile(lock, '', 'utf8');

    await expect(
      withFileLock(lock, () => 'unreachable', { timeoutMs: 100, retryMs: 5, staleMs: 60_000 }),
    ).rejects.toThrow(LockTimeoutError);
  });

  it('PROTO-47: falls back to the staleness timeout when there is no usable pid', async () => {
    const lock = path.join(await makeRoot(), 'x.lock');
    await fs.writeFile(lock, 'written by something else\n', 'utf8');
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(lock, old, old);

    await expect(
      withFileLock(lock, () => 'recovered', { timeoutMs: 500, retryMs: 5, staleMs: 1_000 }),
    ).resolves.toBe('recovered');
  });
});
