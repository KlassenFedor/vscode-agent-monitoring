import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeHarness } from './helpers.js';

describe('report_progress', () => {
  it('MCP-02: creates the session on first use and records the milestone', async () => {
    const { runtime, store, root } = await makeHarness();

    const result = await runtime.reportProgress({
      phase: 'Refactoring the parser',
      title: 'parser split into three modules',
      summary: 'Extracted lexer, reader and validator.',
      next: 'Run the test suite',
    });

    expect(result.isError).toBeUndefined();
    expect(result.text).toContain('Published as report #1');

    const meta = await store.readMeta();
    expect(meta).toMatchObject({ id: 'sess-1', agent: 'claude', cwd: root, status: 'working' });

    const [event] = await store.listEvents();
    expect(event).toMatchObject({
      seq: 1,
      type: 'progress',
      phase: 'Refactoring the parser',
      title: 'parser split into three modules',
      next: 'Run the test suite',
    });
  });

  it('MCP-03: returns unread comments and marks them delivered', async () => {
    const { runtime, human, store } = await makeHarness();
    await human.comment('do not touch legacy/, it has its own release cycle');
    await human.comment('CI is red for unrelated reasons', 'fyi');

    const result = await runtime.reportProgress({ title: 'first milestone' });

    expect(result.text).toContain('2 new comments');
    expect(result.text).toContain('[steer] do not touch legacy/');
    expect(result.text).toContain('[fyi] CI is red');
    expect(result.text).toContain('overrides the earlier plan');
    expect((await store.readCursor()).inbox_seq).toBe(2);
  });

  it('MCP-04: does not repeat comments that were already delivered', async () => {
    const { runtime, human } = await makeHarness();
    await human.comment('skip legacy/');
    await runtime.reportProgress({ title: 'first' });

    const second = await runtime.reportProgress({ title: 'second' });

    expect(second.text).not.toContain('skip legacy/');
    expect(second.text).toContain('Published as report #2');
  });

  it('shows which report a comment replies to', async () => {
    const { runtime, human } = await makeHarness();
    await runtime.reportProgress({ title: 'first' });
    await human.comment('this table is wrong', 'steer', 1);

    const result = await runtime.reportProgress({ title: 'second' });

    expect(result.text).toContain('(on report #1)');
  });

  it('MCP-12: marks reports that arrive faster than the milestone interval', async () => {
    const harness = await makeHarness({ minReportIntervalMs: 60_000 });
    const { runtime, store, setNow } = harness;

    setNow(1_000_000);
    await runtime.reportProgress({ title: 'first' });
    setNow(1_003_000);
    const second = await runtime.reportProgress({ title: 'second' });
    setNow(1_100_000);
    await runtime.reportProgress({ title: 'third, well after the interval' });

    expect(second.text).toContain('marked as throttled');
    expect(second.text).toContain('Report on milestones');

    const events = await store.listEvents();
    expect(events.map((event) => event.throttled)).toEqual([undefined, true, undefined]);
  });

  it('rejects a call without a title instead of writing a useless event', async () => {
    const { runtime, store } = await makeHarness();

    const result = await runtime.reportProgress({ summary: 'lots of words, no headline' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('title is required');
    expect(await store.listEvents()).toEqual([]);
  });
});

describe('publish_artifact', () => {
  it('MCP-05: stores inline content and references it from the event', async () => {
    const { runtime, store } = await makeHarness();

    const result = await runtime.publishArtifact({
      name: 'plan.diff',
      content: '--- a/x\n+++ b/x\n',
      kind: 'diff',
      title: 'proposed change',
    });

    expect(result.text).toContain('artifacts/0001-plan.diff');
    expect(await store.listArtifacts()).toEqual(['0001-plan.diff']);
    expect((await store.readArtifact('0001-plan.diff'))?.toString('utf8')).toBe('--- a/x\n+++ b/x\n');

    const [event] = await store.listEvents();
    expect(event).toMatchObject({
      type: 'artifact',
      title: 'proposed change',
      kind: 'diff',
      artifacts: ['artifacts/0001-plan.diff'],
    });
  });

  it('MCP-05: copies a file the agent already wrote in the workspace', async () => {
    const { runtime, store, root } = await makeHarness();
    await fs.writeFile(path.join(root, 'report.md'), '# findings\n', 'utf8');

    await runtime.publishArtifact({ name: 'report.md', path: 'report.md', kind: 'markdown' });

    expect((await store.readArtifact('0001-report.md'))?.toString('utf8')).toBe('# findings\n');
  });

  it('MCP-06: refuses every attempt to escape the artifacts directory', async () => {
    const { runtime, root, store } = await makeHarness();

    for (const name of ['../../../etc/passwd', '/etc/passwd', 'sub/dir.md', '..\\evil.md', 'x\0.md']) {
      const result = await runtime.publishArtifact({ name, content: 'x' });
      expect(result.isError, name).toBe(true);
    }

    expect(await store.listArtifacts()).toEqual([]);
    expect(await fs.readdir(path.dirname(root))).not.toContain('passwd');
  });

  it('MCP-06: refuses to read a source file from outside the workspace', async () => {
    const { runtime } = await makeHarness();

    const result = await runtime.publishArtifact({ name: 'stolen.md', path: '../../../etc/hosts' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('inside the workspace');
  });

  it('MCP-07: keeps both artifacts when the same name is published twice', async () => {
    const { runtime, store } = await makeHarness();

    await runtime.publishArtifact({ name: 'report.md', content: 'first' });
    await runtime.publishArtifact({ name: 'report.md', content: 'second' });

    expect(await store.listArtifacts()).toEqual(['0001-report.md', '0002-report.md']);
    expect((await store.readArtifact('0001-report.md'))?.toString('utf8')).toBe('first');
  });

  it('insists on exactly one source of content', async () => {
    const { runtime } = await makeHarness();

    const neither = await runtime.publishArtifact({ name: 'x.md' });
    const both = await runtime.publishArtifact({ name: 'x.md', content: 'a', path: 'b' });

    expect(neither.isError).toBe(true);
    expect(both.isError).toBe(true);
    expect(neither.text).toContain('exactly one of content or path');
  });
});

describe('check_feedback', () => {
  it('MCP-08: says nothing is new and leaves the cursor alone', async () => {
    const { runtime, store } = await makeHarness();

    const result = await runtime.checkFeedback({});

    expect(result.text).toBe('No new comments from the human.');
    expect((await store.readCursor()).inbox_seq).toBe(0);
  });

  it('MCP-08: returns new comments and marks them delivered', async () => {
    const { runtime, human, store } = await makeHarness();
    await human.comment('use the existing helper');

    const result = await runtime.checkFeedback({});

    expect(result.text).toContain('[steer] use the existing helper');
    expect((await store.readCursor()).inbox_seq).toBe(1);
    expect((await runtime.checkFeedback({})).text).toBe('No new comments from the human.');
  });

  it('honours an explicit since parameter', async () => {
    const { runtime, human } = await makeHarness();
    await human.comment('one');
    await human.comment('two');

    const result = await runtime.checkFeedback({ since: 1 });

    expect(result.text).toContain('two');
    expect(result.text).not.toContain('one');
  });
});

describe('ask_user', () => {
  it('MCP-09: blocks until the human answers, then resumes work', async () => {
    const { runtime, human, store } = await makeHarness();

    const pending = runtime.askUser({ question: 'Postgres or SQLite?', options: ['postgres', 'sqlite'] });
    await human.answer('postgres, the fixtures already assume it');
    const result = await pending;

    expect(result.text).toContain('Answer to question #1');
    expect(result.text).toContain('postgres, the fixtures already assume it');

    const [question] = await store.listEvents();
    expect(question).toMatchObject({
      type: 'question',
      needs_answer: true,
      options: ['postgres', 'sqlite'],
    });
    expect((await store.readMeta())?.status).toBe('working');
    expect((await store.readCursor()).inbox_seq).toBe(1);
  });

  it('marks the session blocked while it waits', async () => {
    const { runtime, human, store } = await makeHarness();

    const pending = runtime.askUser({ question: 'which one?' });
    try {
      await waitFor(async () => (await store.readMeta())?.status === 'blocked');
    } finally {
      await human.answer('the first one');
      await pending;
    }
  });

  it('MCP-10: gives up after the timeout and tells the agent to decide', async () => {
    const { runtime, store } = await makeHarness();

    const result = await runtime.askUser({ question: 'which one?', timeout_ms: 5_000 });

    expect(result.text).toContain('No answer within 5s');
    expect(result.text).toContain('state the assumption');
    expect((await store.readMeta())?.status).toBe('working');
  });

  it('E2E-04: a stop comment ends the wait and leaves the session blocked', async () => {
    const { runtime, human, store } = await makeHarness();

    const pending = runtime.askUser({ question: 'which one?' });
    await human.stop('hold on, I am rewriting the ticket');
    const result = await pending;

    expect(result.text).toContain('asked you to stop');
    expect((await store.readMeta())?.status).toBe('blocked');
  });

  it('delivers comments that arrived before the answer', async () => {
    const { runtime, human } = await makeHarness();
    await human.comment('by the way, the schema changed', 'fyi');

    const pending = runtime.askUser({ question: 'which one?' });
    await human.answer('the second');
    const result = await pending;

    expect(result.text).toContain('the schema changed');
    expect(result.text).toContain('the second');
  });
});

describe('set_status', () => {
  it('MCP-11: updates the metadata and records a timeline entry', async () => {
    const { runtime, store } = await makeHarness();

    const result = await runtime.setStatus({ status: 'waiting_review', title: 'parser refactor' });

    expect(result.text).toContain('Session marked waiting_review');
    expect(await store.readMeta()).toMatchObject({ status: 'waiting_review', title: 'parser refactor' });
    expect((await store.listEvents())[0]).toMatchObject({ type: 'status', status: 'waiting_review' });
  });

  it('MCP-11: stamps the end time when the session is done', async () => {
    const { runtime, store } = await makeHarness();

    await runtime.setStatus({ status: 'done' });

    const meta = await store.readMeta();
    expect(meta?.ended_at).toBeTypeOf('string');
    expect(meta?.status).toBe('done');
  });

  it('rejects a status outside the documented set', async () => {
    const { runtime } = await makeHarness();
    const result = await runtime.setStatus({ status: 'napping' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('must be one of');
  });
});

describe('failure handling', () => {
  // POSIX only: `chmod` on Windows moves one read-only bit and does not stop writes
  // inside a directory, so there is no failure to report and the test would assert
  // nothing. The behaviour under test is platform-independent; the way of provoking
  // it is not (TESTS.md §7).
  it.skipIf(process.platform === 'win32')(
    'MCP-13: reports a write failure as a tool result instead of throwing',
    async () => {
      const { runtime, root } = await makeHarness();
      await fs.mkdir(path.join(root, '.agent-monitor'), { recursive: true });
      await fs.chmod(path.join(root, '.agent-monitor'), 0o500);

      try {
        const result = await runtime.reportProgress({ title: 'milestone' });

        expect(result.isError).toBe(true);
        expect(result.text).toContain('Continue with your task');
      } finally {
        await fs.chmod(path.join(root, '.agent-monitor'), 0o700);
      }
    },
  );

  it('MCP-14: two sessions in one workspace do not see each other', async () => {
    const first = await makeHarness();
    const second = await makeHarness({ root: first.root, sessionId: 'sess-2' });

    await first.human.comment('meant for the first session');
    await second.runtime.reportProgress({ title: 'from the second session' });
    const firstReport = await first.runtime.reportProgress({ title: 'from the first session' });

    expect(firstReport.text).toContain('meant for the first session');
    expect((await second.store.listEvents()).map((event) => event.title)).toEqual([
      'from the second session',
    ]);
  });
});

/**
 * Wait for a condition the blocking tool sets on another turn of the event loop.
 * Polls rather than sleeping a fixed amount, so a slow machine does not turn this
 * into a flake.
 */
async function waitFor(condition: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) throw new Error('condition was never met');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
