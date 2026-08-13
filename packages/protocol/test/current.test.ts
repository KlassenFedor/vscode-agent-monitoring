import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { writeJsonAtomic } from '../src/atomic.js';
import { createManualClock } from '../src/clock.js';
import { claimCurrentSession, currentSessionPath, readCurrentSession } from '../src/current.js';
import { SessionStore, findLatestSession, listSessionIds } from '../src/session.js';
import { makeRoot, writeText } from './helpers.js';

describe('current session pointer', () => {
  it('PROTO-50: the first claimant wins and is readable afterwards', async () => {
    const root = await makeRoot();

    const claim = await claimCurrentSession(root, 'claude', 'sess-1');

    expect(claim).toMatchObject({ session_id: 'sess-1', agent: 'claude', authoritative: false });
    expect(await readCurrentSession(root, 'claude')).toMatchObject({ session_id: 'sess-1' });
  });

  it('PROTO-51: a later claimant adopts the existing session instead of forking one', async () => {
    const root = await makeRoot();
    await claimCurrentSession(root, 'claude', 'sess-1');

    const second = await claimCurrentSession(root, 'claude', 'sess-2');

    expect(second.session_id).toBe('sess-1');
  });

  it('PROTO-52: a real session id displaces a generated one, but not the reverse', async () => {
    const root = await makeRoot();
    await claimCurrentSession(root, 'claude', 'generated-1', { authoritative: false });

    const real = await claimCurrentSession(root, 'claude', 'real-1', { authoritative: true });
    const laterGenerated = await claimCurrentSession(root, 'claude', 'generated-2', { authoritative: false });

    expect(real.session_id).toBe('real-1');
    expect(laterGenerated.session_id).toBe('real-1');
  });

  it('PROTO-53: a stale pointer from an old session is replaced', async () => {
    const root = await makeRoot();
    const clock = createManualClock('2026-08-13T10:00:00.000Z');
    await claimCurrentSession(root, 'claude', 'yesterday', { clock });

    clock.advance(13 * 60 * 60 * 1000);
    const fresh = await claimCurrentSession(root, 'claude', 'today', { clock });

    expect(fresh.session_id).toBe('today');
  });

  it('PROTO-54: agents keep separate pointers in one workspace', async () => {
    const root = await makeRoot();

    await claimCurrentSession(root, 'claude', 'claude-1');
    await claimCurrentSession(root, 'codex', 'codex-1');

    expect((await readCurrentSession(root, 'claude'))?.session_id).toBe('claude-1');
    expect((await readCurrentSession(root, 'codex'))?.session_id).toBe('codex-1');
  });

  it('PROTO-55: a corrupt or unsafe pointer is treated as absent, not obeyed', async () => {
    const root = await makeRoot();

    await writeText(currentSessionPath(root, 'claude'), '{ truncated');
    expect(await readCurrentSession(root, 'claude')).toBeNull();

    await writeJsonAtomic(currentSessionPath(root, 'claude'), {
      session_id: '../../escape',
      agent: 'claude',
      updated_at: '2026-08-13T10:00:00.000Z',
    });
    expect(await readCurrentSession(root, 'claude')).toBeNull();

    const claim = await claimCurrentSession(root, 'claude', 'sess-1');
    expect(claim.session_id).toBe('sess-1');
  });

  it('answers null when nothing has ever claimed the slot', async () => {
    expect(await readCurrentSession(await makeRoot(), 'claude')).toBeNull();
  });
});

describe('workspace session listing', () => {
  it('lists session directories and ignores stray files', async () => {
    const root = await makeRoot();
    await SessionStore.open(root, 'sess-1').init({ agent: 'claude', cwd: root });
    await SessionStore.open(root, 'sess-2').init({ agent: 'codex', cwd: root });
    await writeText(path.join(root, '.agent-monitor', 'sessions', 'stray.txt'), 'not a session');

    expect((await listSessionIds(root)).sort()).toEqual(['sess-1', 'sess-2']);
  });

  it('picks the most recently updated unfinished session', async () => {
    const root = await makeRoot();
    const clock = createManualClock('2026-08-13T10:00:00.000Z', { tickMs: 1000 });

    const older = SessionStore.open(root, 'older', { clock });
    await older.init({ agent: 'claude', cwd: root });
    const newer = SessionStore.open(root, 'newer', { clock });
    await newer.init({ agent: 'claude', cwd: root });
    await newer.patchMeta({ status: 'working' });

    expect((await findLatestSession(root))?.id).toBe('newer');

    await newer.patchMeta({ status: 'done' });
    expect((await findLatestSession(root))?.id).toBe('older');
    expect((await findLatestSession(root, { includeDone: true }))?.id).toBe('newer');
  });

  it('answers empty for a workspace that has never been monitored', async () => {
    const root = await makeRoot();
    expect(await listSessionIds(root)).toEqual([]);
    expect(await findLatestSession(root)).toBeNull();
  });
});
