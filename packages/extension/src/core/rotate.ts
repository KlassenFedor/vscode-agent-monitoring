import { promises as fs } from 'node:fs';

import {
  listSessionIds,
  sessionDir,
  SessionStore,
  systemClock,
  type Clock,
  type SessionMeta,
} from '@agent-monitor/protocol';

import { currentSessionIds } from './manage.js';

export interface RotateOptions {
  /** Sessions untouched for longer than this are removed. `0` disables rotation. */
  keepMs: number;
  /**
   * Shorter deadline for a session that never held anything: no report, no comment, no
   * artifact, no title.
   *
   * These are ours, not the human's. Every Claude Code slash command that ends a session
   * — `/clear`, `/model`, `/effort`, `/login`, `/resume` — starts a new one, and the
   * `SessionStart` hook registers it before anyone knows it will be abandoned a second
   * later. Keeping that for the full retention period means keeping a directory whose
   * entire content is the fact that an agent once started here (TESTS.md EXT-19).
   *
   * Six hours by default, which is also how far back the passive layer looks: past it
   * the transcript behind such a session is out of sight too, so there is nothing left
   * to be curious about.
   */
  keepEmptyMs?: number;
  clock?: Clock;
}

const DEFAULT_KEEP_EMPTY_MS = 6 * 60 * 60_000;

export interface RotateReport {
  removed: string[];
  kept: number;
}

/**
 * Delete session directories nobody will look at again.
 *
 * `.agent-monitor/sessions/` otherwise grows for the life of the project — every run of
 * every agent, with its artefacts. The extension does this rather than the hook or the
 * server: it is the only participant that is not on an agent's critical path, and a
 * monitoring tool must never spend an agent's time on housekeeping.
 *
 * Age is measured from `updated_at`, and the session each agent's pointer names is kept
 * whatever its age — that is the session a running agent is about to write to.
 */
export async function rotateSessions(root: string, options: RotateOptions): Promise<RotateReport> {
  const report: RotateReport = { removed: [], kept: 0 };
  if (options.keepMs <= 0) return report;

  const clock = options.clock ?? systemClock;
  const deadline = clock.now() - options.keepMs;
  const emptyDeadline = clock.now() - Math.min(options.keepEmptyMs ?? DEFAULT_KEEP_EMPTY_MS, options.keepMs);
  const current = await currentSessionIds(root);

  for (const id of await listSessionIds(root)) {
    if (current.has(id)) {
      report.kept += 1;
      continue;
    }

    // A directory without readable metadata is left alone: it is either being written
    // right now or already broken, and deleting it would destroy the evidence. A
    // corrupt one must also not stop the rotation of every session after it.
    const meta = await SessionStore.open(root, id)
      .readMeta()
      .catch(() => null);
    const updated = meta ? Date.parse(meta.updated_at) : Number.NaN;
    if (!Number.isFinite(updated)) {
      report.kept += 1;
      continue;
    }

    // Emptiness costs three directory reads, so it is only asked about in the window
    // where the answer changes anything: past the ordinary deadline the session goes
    // either way, and before the empty one it stays either way.
    const expired = updated < deadline || (updated < emptyDeadline && (await isEmptySession(root, id, meta)));
    if (!expired) {
      report.kept += 1;
      continue;
    }

    try {
      await fs.rm(sessionDir(root, id), { recursive: true, force: true });
      report.removed.push(id);
    } catch {
      // Busy or read-only: it will come round again on the next start.
      report.kept += 1;
    }
  }

  return report;
}

/** Nothing was ever published here, nobody said anything, and nobody named it. */
async function isEmptySession(root: string, id: string, meta: SessionMeta | null): Promise<boolean> {
  if (typeof meta?.title === 'string' && meta.title.trim() !== '') return false;

  const store = SessionStore.open(root, id);
  try {
    const [events, comments, artifacts] = await Promise.all([
      store.listEvents(),
      store.listComments(),
      store.listArtifacts(),
    ]);
    return events.length === 0 && comments.length === 0 && artifacts.length === 0;
  } catch {
    // An unreadable directory reads as non-empty on purpose: the one thing worse than
    // keeping residue is deleting a session whose contents we failed to list.
    return false;
  }
}
