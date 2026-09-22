import { promises as fs } from 'node:fs';

import {
  listSessionIds,
  sessionDir,
  SessionStore,
  systemClock,
  type Clock,
  type SessionMeta,
} from '@agent-monitor/protocol';

import { archiveSession, currentSessionIds } from './manage.js';

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
  /** Report what would be removed without removing it, for a confirmation. */
  dryRun?: boolean;
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
 * Age is measured by `lastTouchedMs`, and the session each agent's pointer names is kept
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
    const updated = meta ? lastTouchedMs(meta) : Number.NaN;
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

    if (options.dryRun) {
      report.removed.push(id);
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

export interface ArchiveOptions {
  /** Sessions untouched for longer than this are archived. `0` disables it. */
  archiveAfterMs: number;
  clock?: Clock;
}

export interface ArchiveReport {
  archived: string[];
}

/**
 * File away sessions nobody has looked at for a while.
 *
 * The gentle half of rotation: the list stops leading with a week-old run, and nothing
 * is lost — the row is one click away in the Archived folder, with every report intact.
 * Written the same way the archive button writes it (`archiveSession`), so there is one
 * kind of archived session, not two.
 *
 * Skipped, each for its own reason:
 *
 * - the session an agent's pointer names — it is about to be written to;
 * - one already archived — its `archived_at` is the human's, and stays theirs;
 * - unreadable metadata — the same caution as rotation;
 * - an empty one (`isEmptySession`) — the list hides it already (`residualSessions`),
 *   and archiving would bring it back as a row in the Archived folder.
 */
export async function archiveSessions(root: string, options: ArchiveOptions): Promise<ArchiveReport> {
  const report: ArchiveReport = { archived: [] };
  if (options.archiveAfterMs <= 0) return report;

  const clock = options.clock ?? systemClock;
  const deadline = clock.now() - options.archiveAfterMs;
  const current = await currentSessionIds(root);

  for (const id of await listSessionIds(root)) {
    if (current.has(id)) continue;

    const meta = await SessionStore.open(root, id)
      .readMeta()
      .catch(() => null);
    if (!meta || typeof meta.archived_at === 'string') continue;

    const touched = lastTouchedMs(meta);
    if (!Number.isFinite(touched) || touched >= deadline) continue;
    if (await isEmptySession(root, id, meta)) continue;

    try {
      await archiveSession(root, id, { clock });
      report.archived.push(id);
    } catch {
      // Busy or gone since the listing: the next pass will see it again.
    }
  }

  return report;
}

/**
 * The last moment anyone cared about a session: the agent's last write, or the human
 * bringing it back from the archive, whichever is later. `NaN` when neither parses.
 *
 * `restored_at` is in here because a session restored by hand would otherwise go
 * straight back to the archive — or to the bin — on the next pass, being exactly as
 * old as it was when it was put away.
 */
export function lastTouchedMs(meta: Pick<SessionMeta, 'updated_at' | 'restored_at'>): number {
  const updated = Date.parse(meta.updated_at);
  const restored = meta.restored_at === undefined ? Number.NaN : Date.parse(meta.restored_at);
  if (!Number.isFinite(restored)) return updated;
  return Number.isFinite(updated) ? Math.max(updated, restored) : restored;
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
