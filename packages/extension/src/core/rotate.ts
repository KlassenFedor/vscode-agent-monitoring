import { promises as fs } from 'node:fs';

import {
  AGENT_KINDS,
  listSessionIds,
  readCurrentSession,
  sessionDir,
  SessionStore,
  systemClock,
  type Clock,
} from '@agent-monitor/protocol';

export interface RotateOptions {
  /** Sessions untouched for longer than this are removed. `0` disables rotation. */
  keepMs: number;
  clock?: Clock;
}

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
    if (!Number.isFinite(updated) || updated >= deadline) {
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

async function currentSessionIds(root: string): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const agent of AGENT_KINDS) {
    const pointer = await readCurrentSession(root, agent);
    if (pointer) ids.add(pointer.session_id);
  }
  return ids;
}
