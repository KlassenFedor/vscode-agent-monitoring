import { promises as fs } from 'node:fs';

import { claimCurrentSession, createManualClock, sessionDir, SessionStore } from '@agent-monitor/protocol';
import { makeWorkspace } from '@agent-monitor/testkit';
import { describe, expect, it } from 'vitest';

import { rotateSessions } from '../src/core/rotate.js';
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
