import { describe, expect, it } from 'vitest';

import { SessionWatcher } from '../src/core/watcher.js';
import { makeExtHarness } from './helpers.js';

/** Wait until `condition` holds, or fail after `timeoutMs`. */
async function waitFor(condition: () => boolean, timeoutMs: number): Promise<number> {
  const started = Date.now();
  for (;;) {
    if (condition()) return Date.now() - started;
    if (Date.now() - started > timeoutMs) throw new Error('watcher never fired');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('SessionWatcher', () => {
  it('EXT-01: reacts to a new event well under half a second', async () => {
    const harness = await makeExtHarness();
    const store = await harness.agent();

    let fired = 0;
    const watcher = new SessionWatcher(harness.root, () => {
      fired += 1;
    }, { pollIntervalMs: 5_000 });
    await watcher.start();

    try {
      await store.appendEvent({ type: 'progress', title: 'fresh milestone' });
      const elapsed = await waitFor(() => fired > 0, 2_000);
      expect(elapsed).toBeLessThan(500);
    } finally {
      watcher.stop();
    }
  });

  it('EXT-12: polling still notices the change when the OS watcher is out of the picture', async () => {
    const harness = await makeExtHarness();
    const store = await harness.agent();

    let fired = 0;
    const watcher = new SessionWatcher(harness.root, () => {
      fired += 1;
    }, { pollIntervalMs: 100, useFsWatch: false });
    await watcher.start();

    try {
      await store.appendEvent({ type: 'progress', title: 'fresh milestone' });
      await waitFor(() => fired > 0, 5_000);
    } finally {
      watcher.stop();
    }
  });

  it('NFR-04: stays completely idle in a workspace no agent has touched', async () => {
    const harness = await makeExtHarness();

    let fired = 0;
    const watcher = new SessionWatcher(harness.root, () => {
      fired += 1;
    }, { pollIntervalMs: 20 });
    await watcher.start();

    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(fired).toBe(0);
    } finally {
      watcher.stop();
    }
  });

  it('stops firing once it is stopped', async () => {
    const harness = await makeExtHarness();
    const store = await harness.agent();

    let fired = 0;
    const watcher = new SessionWatcher(harness.root, () => {
      fired += 1;
    }, { pollIntervalMs: 20, debounceMs: 5 });
    await watcher.start();
    await waitFor(() => fired > 0, 2_000);

    watcher.stop();
    const seen = fired;
    await store.appendEvent({ type: 'progress', title: 'after stop' });
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(fired).toBe(seen);
  });
});
