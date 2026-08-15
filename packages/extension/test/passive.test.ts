import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createManualClock } from '@agent-monitor/protocol';
import { makeWorkspace } from '@agent-monitor/testkit';
import { describe, expect, it } from 'vitest';

import { ClaudeTranscriptParser } from '../src/core/passive/claude.js';
import { CodexTranscriptParser } from '../src/core/passive/codex.js';
import { claudeProjectSlug } from '../src/core/passive/slug.js';
import { mergePassive } from '../src/core/passive/merge.js';
import { PassiveTracker, type PassiveSessionView } from '../src/core/passive/tracker.js';
import type { SessionView } from '../src/core/model.js';
import { trackTemp } from './helpers.js';

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'transcripts');

/**
 * Put a real workspace path into a fixture.
 *
 * The placeholders sit inside JSON strings, and on Windows a path is full of
 * backslashes: pasted in raw it produces `"C:\Users\..."`, which is not valid JSON, and
 * the parser under test then correctly skips every record — a green-looking fixture
 * that tests nothing, and eight red tests on the first Windows CI run.
 *
 * `__CWD_JSON__` marks the deeper case: Codex passes tool arguments as JSON inside
 * JSON, so that text is parsed twice and has to survive being escaped twice.
 */
export function renderFixture(content: string, root: string): string {
  const escaped = JSON.stringify(root).slice(1, -1);
  const escapedTwice = JSON.stringify(escaped).slice(1, -1);
  return content.replaceAll('__CWD_JSON__', escapedTwice).replaceAll('__CWD__', escaped);
}
const NOW = Date.parse('2026-08-13T10:05:00.000Z');

interface PassiveHarness {
  root: string;
  home: string;
  clock: ReturnType<typeof createManualClock>;
  installClaude(fixture: string, name?: string): Promise<string>;
  installCodex(fixture: string, name?: string): Promise<string>;
  tracker(options?: { maxFailures?: number; onDisabled?: (reason: string) => void }): PassiveTracker;
}

async function makePassiveHarness(): Promise<PassiveHarness> {
  const workspace = await makeWorkspace('agent-monitor-passive-');
  const homeWorkspace = await makeWorkspace('agent-monitor-home-');
  trackTemp(workspace.cleanup);
  trackTemp(homeWorkspace.cleanup);

  const root = workspace.root;
  const home = homeWorkspace.root;
  const clock = createManualClock(NOW);

  const install = async (source: string, target: string): Promise<string> => {
    const content = renderFixture(await fs.readFile(source, 'utf8'), root);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
    return target;
  };

  return {
    root,
    home,
    clock,
    installClaude: (fixture, name = 'session.jsonl') =>
      install(
        path.join(fixtures, 'claude', fixture),
        path.join(home, '.claude', 'projects', claudeProjectSlug(root), name),
      ),
    installCodex: (fixture, name = 'rollout.jsonl') =>
      install(
        path.join(fixtures, 'codex', fixture),
        path.join(home, '.codex', 'sessions', '2026', '08', '13', name),
      ),
    tracker: (options = {}) =>
      new PassiveTracker(root, {
        homeDir: home,
        clock,
        staleAfterMs: 10 * 60_000,
        ...options,
      }),
  };
}

describe('the fixtures themselves', () => {
  it('stay valid JSON for a workspace path with backslashes in it', async () => {
    // Runs on every platform on purpose: this is the check that would have caught the
    // Windows breakage without waiting for a Windows CI run (TESTS.md §7).
    const windowsRoot = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\agent-monitor-x';
    const files = [
      path.join(fixtures, 'claude', '2026-08-basic.jsonl'),
      path.join(fixtures, 'codex', '2026-08-basic.jsonl'),
    ];

    for (const file of files) {
      const rendered = renderFixture(await fs.readFile(file, 'utf8'), windowsRoot);
      for (const line of rendered.split('\n').filter((text) => text.trim() !== '')) {
        const record = JSON.parse(line) as { payload?: { arguments?: unknown } };
        expect(line).toContain(':');

        // Codex tool arguments are JSON inside JSON; the inner document has to parse too.
        const args = record.payload?.arguments;
        if (typeof args === 'string') expect(() => JSON.parse(args)).not.toThrow();
      }
      expect(rendered).toContain(windowsRoot.replaceAll('\\', '\\\\'));
    }
  });
});

describe('PASV-01: locating Claude Code transcripts', () => {
  it('reproduces the directory name Claude Code derives from a path', () => {
    expect(claudeProjectSlug('/home/user_f/projects/vscode-agent-monitoring')).toBe(
      '-home-user-f-projects-vscode-agent-monitoring',
    );
    expect(claudeProjectSlug('/home/u/my.project')).toBe('-home-u-my-project');
    expect(claudeProjectSlug('C:\\work\\repo')).toBe('C--work-repo');
  });
});

describe('PASV-02: reading a Claude Code session', () => {
  it('extracts the pulse without the agent cooperating', async () => {
    const harness = await makePassiveHarness();
    await harness.installClaude('2026-08-basic.jsonl');

    const [session] = await harness.tracker().refresh();

    expect(session).toBeDefined();
    expect(session?.agent).toBe('claude');
    expect(session?.sessionId).toBe('claude-session-1');
    expect(session?.branch).toBe('main');
    expect(session?.lastActivityAt).toBe('2026-08-13T10:02:00.000Z');
    expect(session?.lastMessage).toBe('Extracted the lexer and the reader. Running the tests next.');
    expect(session?.currentTool).toBe('Write');
    expect(session?.changedFiles).toEqual([`${harness.root}/src/lexer.ts`, `${harness.root}/src/reader.ts`]);
    expect(session?.stale).toBe(false);
  });

  it('keeps the camelCase session id when the record also carries a snake_case one', async () => {
    const harness = await makePassiveHarness();
    const file = await harness.installClaude('2026-08-basic.jsonl');

    // A real transcript carries both: `sessionId` is this session, `session_id` is the
    // one it was resumed from (measured — docs-local/live/FINDINGS.md §6). Reading the
    // snake_case field would silently attribute the work to the previous session.
    await fs.appendFile(
      file,
      `${JSON.stringify({
        type: 'assistant',
        cwd: harness.root,
        sessionId: 'claude-session-1',
        session_id: 'claude-session-before-clear',
        timestamp: '2026-08-13T10:03:00.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Still the same session.' }] },
      })}\n`,
    );

    const [session] = await harness.tracker().refresh();

    expect(session?.sessionId).toBe('claude-session-1');
  });

  it('PASV-11: reads a transcript the agent named, even where the derived path is wrong', async () => {
    const harness = await makePassiveHarness();
    // Somewhere the naming rule would never look: this is the case where Claude Code
    // changes how it names project directories and the slug stops matching.
    const elsewhere = path.join(harness.home, 'elsewhere', 'moved-session.jsonl');
    const source = await harness.installClaude('2026-08-basic.jsonl');
    await fs.mkdir(path.dirname(elsewhere), { recursive: true });
    await fs.rename(source, elsewhere);

    const withoutHint = await harness.tracker().refresh();
    const withHint = await harness.tracker().refresh([{ path: elsewhere, agent: 'claude' }]);

    expect(withoutHint).toEqual([]);
    expect(withHint).toHaveLength(1);
    expect(withHint[0]?.transcriptPath).toBe(elsewhere);
    expect(withHint[0]?.currentTool).toBe('Write');
  });

  it('PASV-08: calls a session stale once it has been quiet for long enough', async () => {
    const harness = await makePassiveHarness();
    await harness.installClaude('2026-08-basic.jsonl');

    harness.clock.advance(20 * 60_000);
    const [session] = await harness.tracker().refresh();

    expect(session?.stale).toBe(true);
  });

  it('PASV-05: reads only what was appended since the last refresh', async () => {
    const harness = await makePassiveHarness();
    const file = await harness.installClaude('2026-08-basic.jsonl');
    const tracker = harness.tracker();
    await tracker.refresh();

    await fs.appendFile(
      file,
      `${JSON.stringify({
        type: 'assistant',
        cwd: harness.root,
        sessionId: 'claude-session-1',
        timestamp: '2026-08-13T10:03:00.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Tests are green.' }] },
      })}\n`,
      'utf8',
    );

    const [session] = await tracker.refresh();

    expect(session?.lastMessage).toBe('Tests are green.');
    expect(session?.lastActivityAt).toBe('2026-08-13T10:03:00.000Z');
    // State from the first read survived: it was not re-parsed from the top.
    expect(session?.changedFiles).toHaveLength(2);
  });
});

describe('PASV-03: reading a Codex rollout', () => {
  it('extracts the pulse and the workspace it belongs to', async () => {
    const harness = await makePassiveHarness();
    await harness.installCodex('2026-08-basic.jsonl');

    const [session] = await harness.tracker().refresh();

    expect(session?.agent).toBe('codex');
    expect(session?.sessionId).toBe('codex-session-1');
    expect(session?.cwd).toBe(harness.root);
    expect(session?.branch).toBe('main');
    expect(session?.lastMessage).toBe('Extracted the lexer. Tests are green.');
    expect(session?.currentTool).toBe('apply_patch');
    expect(session?.changedFiles).toEqual([`${harness.root}/src/lexer.ts`]);
  });

  it('ignores rollouts belonging to another project', async () => {
    const harness = await makePassiveHarness();
    await harness.installCodex('2026-08-basic.jsonl', 'mine.jsonl');
    await harness.installCodex('2026-08-other-project.jsonl', 'theirs.jsonl');

    const sessions = await harness.tracker().refresh();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionId).toBe('codex-session-1');
  });

  it('shows both agents at once, most recent first', async () => {
    const harness = await makePassiveHarness();
    await harness.installClaude('2026-08-basic.jsonl');
    await harness.installCodex('2026-08-basic.jsonl');

    const sessions = await harness.tracker().refresh();

    expect(sessions.map((session) => session.agent).sort()).toEqual(['claude', 'codex']);
  });
});

describe('PASV-04: records the parser was never taught', () => {
  it('skips unknown shapes and keeps reading the rest', async () => {
    const harness = await makePassiveHarness();
    await harness.installClaude('2026-08-unknown-shapes.jsonl');

    const [session] = await harness.tracker().refresh();

    expect(session?.lastMessage).toBe('still readable');
    expect(session?.currentTool).toBe('Write');
    expect(session?.changedFiles).toEqual([`${harness.root}/src/kept.ts`]);
    expect(session?.lastActivityAt).toBe('2026-08-13T10:00:04.000Z');
  });

  it('PASV-06: survives arbitrarily mutilated records', async () => {
    const parsers = [new ClaudeTranscriptParser(), new CodexTranscriptParser()];
    const junk: unknown[] = [
      null,
      42,
      'a string',
      [],
      {},
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 42, input: 'nope' }] } },
      { type: 'assistant', timestamp: {}, message: { content: {} } },
      { type: 'response_item', payload: { type: 'function_call', arguments: '{invalid json' } },
      { type: 'session_meta', payload: { git: 'not an object', cwd: 12 } },
      { type: 'event_msg', payload: { type: 'agent_message', message: null } },
    ];

    for (const parser of parsers) {
      expect(() => parser.applyAll(junk)).not.toThrow();
      expect(parser.result().lastActivityAt).toBeNull();
    }
  });
});

describe('PASV-07: switching itself off', () => {
  it('gives up after repeated unreadable reads and says so exactly once', async () => {
    const harness = await makePassiveHarness();
    const file = await harness.installClaude('2026-08-basic.jsonl');
    await fs.writeFile(file, 'not json at all\nstill not json\n', 'utf8');

    const reasons: string[] = [];
    const tracker = harness.tracker({ maxFailures: 2, onDisabled: (reason) => reasons.push(reason) });

    await tracker.refresh();
    expect(tracker.disabled).toBe(false);

    // A read that finds nothing new is not a failure — only newly written records the
    // parser cannot make sense of count, which is what a changed format looks like.
    await fs.appendFile(file, 'a third line of nonsense\n', 'utf8');
    expect(await tracker.refresh()).toEqual([]);
    expect(tracker.disabled).toBe(true);

    await tracker.refresh();
    await tracker.refresh();
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('passive session tracking');
    expect(reasons[0]).toContain('Reports published through the monitoring tools are unaffected');
  });

  it('a run of good records clears the failure count', async () => {
    const harness = await makePassiveHarness();
    const file = await harness.installClaude('2026-08-basic.jsonl');
    const tracker = harness.tracker({ maxFailures: 2 });

    await fs.appendFile(file, 'garbage line\n', 'utf8');
    await tracker.refresh();

    await fs.appendFile(
      file,
      `${JSON.stringify({ type: 'assistant', timestamp: '2026-08-13T10:04:00.000Z', message: { content: [{ type: 'text', text: 'fine' }] } })}\n`,
      'utf8',
    );
    await tracker.refresh();
    await fs.appendFile(file, 'garbage again\n', 'utf8');
    await tracker.refresh();

    expect(tracker.disabled).toBe(false);
  });

  it('leaves finished sessions out of the sidebar', async () => {
    const harness = await makePassiveHarness();
    await harness.installClaude('2026-08-basic.jsonl');

    expect(await harness.tracker().refresh()).toHaveLength(1);

    // A project accumulates hundreds of transcripts; only a live one is a pulse.
    harness.clock.advance(8 * 60 * 60_000);
    expect(await harness.tracker().refresh()).toEqual([]);
  });

  it('stays quiet in a workspace no agent has ever worked in', async () => {
    const harness = await makePassiveHarness();
    expect(await harness.tracker().refresh()).toEqual([]);
  });
});

describe('PASV-09: the fixtures carry no real data', () => {
  it('contains no personal paths, addresses or tokens', async () => {
    const files = [
      ...(await fs.readdir(path.join(fixtures, 'claude'))).map((name) => path.join(fixtures, 'claude', name)),
      ...(await fs.readdir(path.join(fixtures, 'codex'))).map((name) => path.join(fixtures, 'codex', name)),
    ];

    for (const file of files) {
      const content = await fs.readFile(file, 'utf8');
      // Real transcripts are the user's conversations; nothing captured from one may
      // be committed. These patterns are what leaks first when someone forgets.
      expect(content, file).not.toMatch(/\/home\/(?!u\b)[a-z0-9_]+\//i);
      expect(content, file).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
      expect(content, file).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
      expect(content, file).not.toMatch(/toolu_01[A-Za-z0-9]{10,}/);
    }
  });
});

describe('showing passive sessions next to reporting ones', () => {
  const passive = (overrides: Partial<PassiveSessionView> = {}): PassiveSessionView => ({
    agent: 'claude',
    sessionId: 'claude-session-1',
    cwd: '/work',
    branch: 'main',
    lastActivityAt: '2026-08-13T10:00:00.000Z',
    lastMessage: 'working',
    currentTool: 'Read',
    changedFiles: [],
    entries: [],
    transcriptPath: '/home/u/.claude/projects/-work/session.jsonl',
    stale: false,
    ...overrides,
  });

  const reporting = (overrides: Partial<SessionView> = {}): SessionView => ({
    id: 'sess-1',
    meta: {
      id: 'sess-1',
      agent: 'claude',
      cwd: '/work',
      status: 'working',
      started_at: '2026-08-13T10:00:00.000Z',
      updated_at: '2026-08-13T10:00:00.000Z',
      protocol_version: 1,
    },
    events: [],
    comments: [],
    cursorSeq: 0,
    unread: [],
    lastActivityAt: '2026-08-13T10:00:00.000Z',
    stale: false,
    waitingQuestion: null,
    status: 'working',
    ...overrides,
  });

  it('shows a passive session when nothing is being published', () => {
    expect(mergePassive([], [passive()]).visible).toHaveLength(1);
  });

  it('hides it once the same agent starts reporting properly', () => {
    expect(mergePassive([reporting()], [passive()]).visible).toEqual([]);
  });

  it('shows it again after that session finishes', () => {
    const done = reporting({ status: 'done' });
    expect(mergePassive([done], [passive()]).visible).toHaveLength(1);
  });

  it('hides a passive view of a session that is reporting under the same id', () => {
    const same = reporting({ id: 'claude-session-1' });
    expect(mergePassive([same], [passive()]).visible).toEqual([]);
  });

  it('keeps the other agent visible', () => {
    const merged = mergePassive([reporting()], [passive({ agent: 'codex', sessionId: 'codex-1' })]);
    expect(merged.visible.map((view) => view.agent)).toEqual(['codex']);
  });

  it('PASV-11: hides a passive view of the transcript a session named as its own', () => {
    // Ids never match between the two sides, but the file does — and it is the same
    // work, so it must not appear twice even after that session reported `done`.
    const done = reporting({
      status: 'done',
      meta: {
        ...(reporting().meta as NonNullable<SessionView['meta']>),
        status: 'done',
        transcript_path: '/home/u/.claude/projects/-work/session.jsonl',
      },
    });

    expect(mergePassive([done], [passive()]).visible).toEqual([]);
  });

  it('PASV-12: hands the pulse to the live session it belongs to', () => {
    // The Codex case: the MCP server registered a session on start, the model has not
    // called a tool yet, and the rollout is the only thing that knows it is alive.
    const merged = mergePassive([reporting()], [passive({ currentTool: 'shell' })]);

    expect(merged.visible).toEqual([]);
    expect(merged.attached.get('sess-1')?.currentTool).toBe('shell');
  });

  it('PASV-12: hands it to the session that names that exact transcript, not to a sibling', () => {
    const named = reporting({
      id: 'named',
      meta: {
        ...(reporting().meta as NonNullable<SessionView['meta']>),
        id: 'named',
        transcript_path: '/home/u/.claude/projects/-work/session.jsonl',
      },
    });
    const merged = mergePassive([named, reporting()], [passive()]);

    expect(merged.attached.has('sess-1')).toBe(false);
    expect(merged.attached.get('named')?.transcriptPath).toBe('/home/u/.claude/projects/-work/session.jsonl');
  });

  it('PASV-12: gives a second transcript its own row rather than a session already spoken for', () => {
    // Two agents of the same kind, one registered session: guessing which is which
    // would hide real work, so only the first one is adopted.
    const merged = mergePassive(
      [reporting()],
      [passive(), passive({ sessionId: 'claude-session-2', transcriptPath: '/home/u/other.jsonl' })],
    );

    expect(merged.attached.size).toBe(1);
    expect(merged.visible.map((view) => view.transcriptPath)).toEqual(['/home/u/other.jsonl']);
  });
});

describe('PASV-13: the transcript as a timeline, not a single reading', () => {
  it('keeps what a Codex session said and did, in order', async () => {
    const harness = await makePassiveHarness();
    await harness.installCodex('2026-08-basic.jsonl');

    const [session] = await harness.tracker().refresh();

    expect(session?.entries.map((entry) => [entry.kind, entry.text])).toEqual([
      ['message', 'Reading the parser first.'],
      ['tool', 'shell: bash -lc cat src/parser.ts'],
      ['tool', `apply_patch: ${harness.root}/src/lexer.ts`],
      ['message', 'Extracted the lexer. Tests are green.'],
    ]);
    expect(session?.entries[0]?.ts).toBe('2026-08-13T10:00:04.000Z');
  });

  it('keeps the same for Claude Code', async () => {
    const harness = await makePassiveHarness();
    await harness.installClaude('2026-08-basic.jsonl');

    const [session] = await harness.tracker().refresh();
    const kinds = session?.entries.map((entry) => entry.kind) ?? [];

    expect(kinds).toContain('message');
    expect(kinds).toContain('tool');
    expect(session?.entries.at(-1)?.text).toBe('Extracted the lexer and the reader. Running the tests next.');
  });

  it('does not say the same thing twice when Codex announces it twice', () => {
    // A real rollout carries an assistant message as `event_msg` and again as
    // `response_item`; a timeline showing both reads as if the agent repeated itself.
    const parser = new CodexTranscriptParser();
    parser.applyAll([
      {
        timestamp: '2026-08-13T10:00:00.000Z',
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'Tests are green.' },
      },
      {
        timestamp: '2026-08-13T10:00:00.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ text: 'Tests are green.' }] },
      },
    ]);

    expect(parser.result().entries).toHaveLength(1);
  });

  it('keeps the timeline bounded, dropping the oldest', () => {
    const parser = new CodexTranscriptParser();
    parser.applyAll(
      Array.from({ length: 260 }, (_, index) => ({
        timestamp: '2026-08-13T10:00:00.000Z',
        type: 'event_msg',
        payload: { type: 'agent_message', message: `line ${index}` },
      })),
    );

    const entries = parser.result().entries;
    expect(entries).toHaveLength(200);
    expect(entries[0]?.text).toBe('line 60');
    expect(entries.at(-1)?.text).toBe('line 259');
  });

  it('PASV-05: keeps earlier entries when the transcript grows', async () => {
    const harness = await makePassiveHarness();
    const file = await harness.installCodex('2026-08-basic.jsonl');
    const tracker = harness.tracker();

    const before = (await tracker.refresh())[0]?.entries.length ?? 0;
    await fs.appendFile(
      file,
      `${JSON.stringify({
        timestamp: '2026-08-13T10:03:00.000Z',
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'One more thing.' },
      })}\n`,
      'utf8',
    );
    const after = (await tracker.refresh())[0]?.entries ?? [];

    expect(after).toHaveLength(before + 1);
    expect(after[0]?.text).toBe('Reading the parser first.');
    expect(after.at(-1)?.text).toBe('One more thing.');
  });
});

describe('PASV-14: a cut line says it was cut', () => {
  it('ends a long message with an ellipsis instead of mid-word', () => {
    // A hard slice made the agent look like it stopped mid-sentence, with nothing to
    // tell "it wrote that much" from "we cut it here".
    const parser = new CodexTranscriptParser();
    parser.applyAll([
      {
        timestamp: '2026-08-13T10:00:00.000Z',
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'x'.repeat(900) },
      },
    ]);

    const [entry] = parser.result().entries;
    expect(entry?.text).toHaveLength(400);
    expect(entry?.text.endsWith('…')).toBe(true);
  });

  it('leaves a message that fits exactly as it is', () => {
    const parser = new CodexTranscriptParser();
    parser.applyAll([
      {
        timestamp: '2026-08-13T10:00:00.000Z',
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'short enough' },
      },
    ]);

    expect(parser.result().entries[0]?.text).toBe('short enough');
  });

  it('numbers entries so a trimmed list keeps its identities', () => {
    // The ordinal is what a row on screen is keyed by: an index would shift under every
    // trim and repaint the whole timeline.
    const parser = new CodexTranscriptParser();
    parser.applyAll(
      Array.from({ length: 205 }, (_, index) => ({
        timestamp: '2026-08-13T10:00:00.000Z',
        type: 'event_msg',
        payload: { type: 'agent_message', message: `line ${index}` },
      })),
    );

    const entries = parser.result().entries;
    expect(entries[0]?.ordinal).toBe(6);
    expect(entries.at(-1)?.ordinal).toBe(205);
  });
});
