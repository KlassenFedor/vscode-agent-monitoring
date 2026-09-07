import { describe, expect, it } from 'vitest';

import type { SessionView } from '../src/core/model.js';
import type { PassiveSessionView } from '../src/core/passive/tracker.js';
import { residualSessions } from '../src/core/residual.js';

const STARTED = '2026-09-04T04:10:10.000Z';

/** A session directory holding nothing but `meta.json`, gone quiet. */
function abandoned(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: 'sess-1',
    meta: {
      id: 'sess-1',
      agent: 'claude',
      cwd: '/work',
      status: 'working',
      started_at: STARTED,
      updated_at: STARTED,
      protocol_version: 1,
    },
    events: [],
    comments: [],
    cursorSeq: 0,
    unread: [],
    lastActivityAt: STARTED,
    stale: true,
    waitingQuestion: null,
    status: 'working',
    archived: false,
    ...overrides,
  };
}

function pulse(overrides: Partial<PassiveSessionView> = {}): PassiveSessionView {
  return {
    agent: 'claude',
    sessionId: 'sess-1',
    cwd: '/work',
    branch: 'main',
    lastActivityAt: STARTED,
    lastMessage: null,
    currentTool: 'Read',
    changedFiles: [],
    entries: [],
    subagentOf: null,
    transcriptPath: '/home/u/.claude/projects/-work/sess-1.jsonl',
    stale: false,
    ...overrides,
  };
}

const nothing = { current: new Set<string>(), pulses: new Map<string, PassiveSessionView>() };

describe('EXT-43: session directories a slash command left behind', () => {
  it('hides one that never held anything and has gone quiet', () => {
    expect([...residualSessions([abandoned()], nothing)]).toEqual(['sess-1']);
  });

  it('keeps one that published something', () => {
    const withReport = abandoned({
      events: [{ seq: 1, ts: STARTED, type: 'progress', title: 'Parser split' }],
    });

    expect([...residualSessions([withReport], nothing)]).toEqual([]);
  });

  it('keeps one the human has written to, delivered or not', () => {
    const commented = abandoned({
      comments: [{ seq: 1, ts: STARTED, kind: 'steer', text: 'not there' }],
    });

    expect([...residualSessions([commented], nothing)]).toEqual([]);
  });

  it('keeps one that has a name', () => {
    const named = abandoned({
      meta: { ...(abandoned().meta as NonNullable<SessionView['meta']>), title: 'Looked at the parser' },
    });

    expect([...residualSessions([named], nothing)]).toEqual([]);
  });

  it('keeps one that has only just started', () => {
    // The MCP server registers a session at process start precisely so Codex has
    // something to open before it calls a tool (DESIGN.md §3); hiding it would undo that.
    expect([...residualSessions([abandoned({ stale: false })], nothing)]).toEqual([]);
  });

  it('keeps one whose transcript says the agent is working', () => {
    const options = { current: new Set<string>(), pulses: new Map([['sess-1', pulse()]]) };

    expect([...residualSessions([abandoned()], options)]).toEqual([]);
  });

  it('hides one whose transcript has gone quiet too', () => {
    const options = { current: new Set<string>(), pulses: new Map([['sess-1', pulse({ stale: true })]]) };

    expect([...residualSessions([abandoned()], options)]).toEqual(['sess-1']);
  });

  it('never hides the session an agent is pointed at', () => {
    const options = { current: new Set(['sess-1']), pulses: new Map<string, PassiveSessionView>() };

    expect([...residualSessions([abandoned()], options)]).toEqual([]);
  });

  it('leaves an archived session where the human filed it', () => {
    // Archiving already answers the question this asks, and it answers it out loud.
    expect([...residualSessions([abandoned({ archived: true })], nothing)]).toEqual([]);
  });
});
