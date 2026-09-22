import { promises as fs } from 'node:fs';

import { claimCurrentSession, createManualClock, sessionDir, SessionStore } from '@agent-monitor/protocol';
import { makeWorkspace } from '@agent-monitor/testkit';
import { describe, expect, it } from 'vitest';

import { archiveSession, unarchiveSession } from '../src/core/manage.js';
import { archiveSessions, lastTouchedMs, rotateSessions } from '../src/core/rotate.js';
import { trackTemp } from './helpers.js';

const NOW = Date.parse('2026-08-14T12:00:00.000Z');
const DAY = 24 * 60 * 60_000;
const KEEP_MS = 14 * DAY;

async function makeRoot(): Promise<string> {
  const workspace = await makeWorkspace('agent-monitor-rotate-');
  trackTemp(workspace.cleanup);
  return workspace.root;
}

/** A session whose last write was `ageMs` ago. */
async function makeSession(root: string, id: string, ageMs: number): Promise<void> {
  const clock = createManualClock(NOW - ageMs);
  const store = SessionStore.open(root, id, { clock });
  await store.init({ agent: 'claude', cwd: root });
  await store.appendEvent({ type: 'progress', title: 'something', phase: 'work', summary: 'done' });
}

/**
 * What a Claude Code slash command leaves behind: the `SessionStart` hook registered a
 * session, the conversation moved to a new id a second later, and nothing was ever
 * written here.
 */
async function makeEmptySession(root: string, id: string, ageMs: number): Promise<void> {
  const clock = createManualClock(NOW - ageMs);
  await SessionStore.open(root, id, { clock }).init({ agent: 'claude', cwd: root });
}

async function exists(path: string): Promise<boolean> {
  return fs
    .stat(path)
    .then(() => true)
    .catch(() => false);
}

describe('EXT-19: rotating old sessions', () => {
  it('removes what has gone quiet and keeps what has not', async () => {
    const root = await makeRoot();
    await makeSession(root, 'old-one', 30 * DAY);
    await makeSession(root, 'fresh-one', 1 * DAY);

    const report = await rotateSessions(root, { keepMs: KEEP_MS, clock: createManualClock(NOW) });

    expect(report.removed).toEqual(['old-one']);
    expect(await exists(sessionDir(root, 'old-one'))).toBe(false);
    expect(await exists(sessionDir(root, 'fresh-one'))).toBe(true);
  });

  it('removes a session that never held anything long before the retention period', async () => {
    const root = await makeRoot();
    await makeEmptySession(root, 'slash-command-residue', 8 * 60 * 60_000);
    await makeEmptySession(root, 'started-an-hour-ago', 60 * 60_000);
    await makeSession(root, 'has-a-report', 8 * 60 * 60_000);

    const report = await rotateSessions(root, { keepMs: KEEP_MS, clock: createManualClock(NOW) });

    expect(report.removed).toEqual(['slash-command-residue']);
    expect(await exists(sessionDir(root, 'started-an-hour-ago'))).toBe(true);
    expect(await exists(sessionDir(root, 'has-a-report'))).toBe(true);
  });

  it('keeps an empty session somebody named: a name is something to recognise it by', async () => {
    const root = await makeRoot();
    const clock = createManualClock(NOW - 8 * 60 * 60_000);
    const store = SessionStore.open(root, 'named-but-empty', { clock });
    await store.init({ agent: 'claude', cwd: root });
    await store.patchMeta({ title: 'Looked at the parser' });

    const report = await rotateSessions(root, { keepMs: KEEP_MS, clock: createManualClock(NOW) });

    expect(report.removed).toEqual([]);
  });

  it('never removes the session an agent is pointed at, however old', async () => {
    const root = await makeRoot();
    await makeSession(root, 'old-but-current', 90 * DAY);
    await claimCurrentSession(root, 'claude', 'old-but-current', { authoritative: true });

    const report = await rotateSessions(root, { keepMs: KEEP_MS, clock: createManualClock(NOW) });

    expect(report.removed).toEqual([]);
    expect(await exists(sessionDir(root, 'old-but-current'))).toBe(true);
  });

  it('keeps a session whose metadata cannot be read rather than destroying evidence', async () => {
    const root = await makeRoot();
    await makeSession(root, 'broken', 30 * DAY);
    await fs.writeFile(`${sessionDir(root, 'broken')}/meta.json`, '{ not json', 'utf8');

    const report = await rotateSessions(root, { keepMs: KEEP_MS, clock: createManualClock(NOW) });

    expect(report.removed).toEqual([]);
    expect(await exists(sessionDir(root, 'broken'))).toBe(true);
  });

  it('does nothing at all when rotation is switched off', async () => {
    const root = await makeRoot();
    await makeSession(root, 'ancient', 400 * DAY);

    const report = await rotateSessions(root, { keepMs: 0, clock: createManualClock(NOW) });

    expect(report).toEqual({ removed: [], kept: 0 });
    expect(await exists(sessionDir(root, 'ancient'))).toBe(true);
  });
});

describe('EXT-19: rotation, as seen from the settings menu', () => {
  it('names what it would remove in a dry run without removing it', async () => {
    const root = await makeRoot();
    await makeSession(root, 'old-one', 30 * DAY);
    await makeSession(root, 'fresh-one', 1 * DAY);

    const report = await rotateSessions(root, {
      keepMs: KEEP_MS,
      clock: createManualClock(NOW),
      dryRun: true,
    });

    expect(report.removed).toEqual(['old-one']);
    expect(await exists(sessionDir(root, 'old-one'))).toBe(true);
  });

  it('gives a session restored by hand a fresh start', async () => {
    const root = await makeRoot();
    await makeSession(root, 'brought-back', 30 * DAY);
    await archiveSession(root, 'brought-back', { clock: createManualClock(NOW - 20 * DAY) });
    await unarchiveSession(root, 'brought-back', { clock: createManualClock(NOW - 1 * DAY) });

    const report = await rotateSessions(root, { keepMs: KEEP_MS, clock: createManualClock(NOW) });

    expect(report.removed).toEqual([]);
  });
});

describe('EXT-44: archiving old sessions automatically', () => {
  const ARCHIVE_MS = 7 * DAY;

  async function archivedAt(root: string, id: string): Promise<string | undefined> {
    return (await SessionStore.open(root, id).readMeta())?.archived_at;
  }

  it('archives what has gone quiet and leaves the rest', async () => {
    const root = await makeRoot();
    await makeSession(root, 'quiet', 10 * DAY);
    await makeSession(root, 'recent', 2 * DAY);

    const report = await archiveSessions(root, { archiveAfterMs: ARCHIVE_MS, clock: createManualClock(NOW) });

    expect(report.archived).toEqual(['quiet']);
    expect(await archivedAt(root, 'quiet')).toBe(new Date(NOW).toISOString());
    expect(await archivedAt(root, 'recent')).toBeUndefined();
  });

  it('does not let archiving pass for activity', async () => {
    const root = await makeRoot();
    await makeSession(root, 'quiet', 10 * DAY);
    const before = (await SessionStore.open(root, 'quiet').readMeta())?.updated_at;

    await archiveSessions(root, { archiveAfterMs: ARCHIVE_MS, clock: createManualClock(NOW) });

    // Deletion counts from the same moment; archiving must not push it back.
    expect((await SessionStore.open(root, 'quiet').readMeta())?.updated_at).toBe(before);
  });

  it('leaves the archive date the human set alone', async () => {
    const root = await makeRoot();
    await makeSession(root, 'filed-by-hand', 10 * DAY);
    await archiveSession(root, 'filed-by-hand', { clock: createManualClock(NOW - 5 * DAY) });

    const report = await archiveSessions(root, { archiveAfterMs: ARCHIVE_MS, clock: createManualClock(NOW) });

    expect(report.archived).toEqual([]);
    expect(await archivedAt(root, 'filed-by-hand')).toBe(new Date(NOW - 5 * DAY).toISOString());
  });

  it('does not archive again a session the human restored', async () => {
    const root = await makeRoot();
    await makeSession(root, 'wanted-back', 10 * DAY);
    await archiveSessions(root, { archiveAfterMs: ARCHIVE_MS, clock: createManualClock(NOW) });
    await unarchiveSession(root, 'wanted-back', { clock: createManualClock(NOW + 60_000) });

    const report = await archiveSessions(root, {
      archiveAfterMs: ARCHIVE_MS,
      clock: createManualClock(NOW + 2 * 60_000),
    });

    expect(report.archived).toEqual([]);
  });

  it('archives a restored session once it has been left alone for the full term again', async () => {
    const root = await makeRoot();
    await makeSession(root, 'restored-then-forgotten', 30 * DAY);
    await unarchiveSession(root, 'restored-then-forgotten', { clock: createManualClock(NOW - 8 * DAY) });

    const report = await archiveSessions(root, { archiveAfterMs: ARCHIVE_MS, clock: createManualClock(NOW) });

    expect(report.archived).toEqual(['restored-then-forgotten']);
  });

  it('never archives the session an agent is pointed at', async () => {
    const root = await makeRoot();
    await makeSession(root, 'old-but-current', 90 * DAY);
    await claimCurrentSession(root, 'claude', 'old-but-current', { authoritative: true });

    const report = await archiveSessions(root, { archiveAfterMs: ARCHIVE_MS, clock: createManualClock(NOW) });

    expect(report.archived).toEqual([]);
  });

  it('leaves an empty session hidden rather than filing it where it would be seen', async () => {
    // The list hides residue already (EXT-43); an archived row is shown in the Archived
    // folder, so archiving it would bring back the very row that was hidden.
    const root = await makeRoot();
    await makeEmptySession(root, 'slash-command-residue', 10 * DAY);

    const report = await archiveSessions(root, { archiveAfterMs: ARCHIVE_MS, clock: createManualClock(NOW) });

    expect(report.archived).toEqual([]);
  });

  it('skips a session whose metadata cannot be read', async () => {
    const root = await makeRoot();
    await makeSession(root, 'broken', 30 * DAY);
    await fs.writeFile(`${sessionDir(root, 'broken')}/meta.json`, '{ not json', 'utf8');

    const report = await archiveSessions(root, { archiveAfterMs: ARCHIVE_MS, clock: createManualClock(NOW) });

    expect(report.archived).toEqual([]);
  });

  it('does nothing when switched off', async () => {
    const root = await makeRoot();
    await makeSession(root, 'ancient', 400 * DAY);

    const report = await archiveSessions(root, { archiveAfterMs: 0, clock: createManualClock(NOW) });

    expect(report.archived).toEqual([]);
    expect(await archivedAt(root, 'ancient')).toBeUndefined();
  });

  it('counts age from the later of the last write and the last restore', () => {
    const updated_at = '2026-08-01T00:00:00.000Z';
    expect(lastTouchedMs({ updated_at })).toBe(Date.parse(updated_at));
    expect(lastTouchedMs({ updated_at, restored_at: '2026-08-05T00:00:00.000Z' })).toBe(
      Date.parse('2026-08-05T00:00:00.000Z'),
    );
    expect(lastTouchedMs({ updated_at, restored_at: '2026-07-01T00:00:00.000Z' })).toBe(
      Date.parse(updated_at),
    );
  });
});
