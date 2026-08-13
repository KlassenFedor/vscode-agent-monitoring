import { watch, type FSWatcher } from 'node:fs';

import { monitorDir } from '@agent-monitor/protocol';

import { statOrNull } from './fsutil.js';

export interface WatcherOptions {
  /** How often to re-check when the operating system's watcher misses a change. */
  pollIntervalMs?: number;
  /** Collapse a burst of file events into one refresh. */
  debounceMs?: number;
  /** Turn off `fs.watch`, leaving only polling. Used to prove the fallback works. */
  useFsWatch?: boolean;
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_DEBOUNCE_MS = 40;

/**
 * Tells the model when to look at the disk again.
 *
 * Two mechanisms on purpose. `fs.watch` gives the sub-100ms reaction the UI needs;
 * polling is the safety net, because watchers drop events on network shares, on some
 * container filesystems, and whenever a directory is replaced rather than modified
 * (TESTS.md EXT-12).
 *
 * Polling only runs once the monitor directory exists, so a workspace where no agent
 * has ever run costs nothing while idle (NFR-04).
 */
export class SessionWatcher {
  readonly #root: string;
  readonly #onChange: () => void;
  readonly #pollIntervalMs: number;
  readonly #debounceMs: number;
  readonly #useFsWatch: boolean;

  #watcher: FSWatcher | null = null;
  #timer: NodeJS.Timeout | null = null;
  #debounce: NodeJS.Timeout | null = null;
  #started = false;

  constructor(root: string, onChange: () => void, options: WatcherOptions = {}) {
    this.#root = root;
    this.#onChange = onChange;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.#useFsWatch = options.useFsWatch ?? true;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;

    await this.#attach();
    this.#timer = setInterval(() => {
      void this.#tick();
    }, this.#pollIntervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    this.#started = false;
    this.#watcher?.close();
    this.#watcher = null;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    if (this.#debounce) clearTimeout(this.#debounce);
    this.#debounce = null;
  }

  /** Ask for a refresh right now, e.g. from a manual command. */
  poke(): void {
    this.#schedule();
  }

  async #tick(): Promise<void> {
    if (!this.#started) return;
    // Nothing has ever been written here: stay idle rather than polling an absent
    // directory, but keep trying to attach in case an agent starts.
    if (!(await this.#exists())) return;

    if (!this.#watcher) await this.#attach();
    this.#schedule();
  }

  async #attach(): Promise<void> {
    if (!this.#useFsWatch || this.#watcher) return;
    if (!(await this.#exists())) return;

    try {
      this.#watcher = watch(monitorDir(this.#root), { recursive: true }, () => {
        this.#schedule();
      });
      this.#watcher.on('error', () => {
        // A dead watcher is not worth reporting: polling already covers us.
        this.#watcher?.close();
        this.#watcher = null;
      });
    } catch {
      this.#watcher = null;
    }
  }

  async #exists(): Promise<boolean> {
    return (await statOrNull(monitorDir(this.#root))) !== null;
  }

  #schedule(): void {
    if (this.#debounce) clearTimeout(this.#debounce);
    this.#debounce = setTimeout(() => {
      this.#debounce = null;
      if (this.#started) this.#onChange();
    }, this.#debounceMs);
    this.#debounce.unref?.();
  }
}
