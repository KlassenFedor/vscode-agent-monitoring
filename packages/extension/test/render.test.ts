import { describe, expect, it } from 'vitest';

import { openKindFor } from '../src/core/artifacts.js';
import type { SessionView } from '../src/core/model.js';
import { planNotification } from '../src/core/notify.js';
import { escapeHtml, renderSession, renderUpdate } from '../src/core/render.js';

function view(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: 'sess-1',
    meta: null,
    events: [],
    comments: [],
    cursorSeq: 0,
    unread: [],
    lastActivityAt: null,
    stale: false,
    waitingQuestion: null,
    status: 'working',
    ...overrides,
  };
}

const options = { nonce: 'test-nonce', cspSource: 'vscode-webview://x' };

describe('EXT-20: a panel is written once and patched afterwards', () => {
  const withEvent = view({
    events: [
      {
        seq: 1,
        ts: '2026-08-13T10:00:00.000Z',
        type: 'progress',
        title: 'Parser split into three modules',
      },
    ],
  });

  it('offers every changing part of the page as a fragment', () => {
    const update = renderUpdate(withEvent);

    expect(update.timeline).toContain('Parser split into three modules');
    expect(update.meta).toContain('working');
    expect(update.question).toBe('');
  });

  it('puts those fragments behind the ids the update targets', () => {
    // The two halves have to agree: a renamed id would leave the panel frozen on its
    // first render, and nothing else in the suite would notice.
    const html = renderSession(withEvent, options);
    const update = renderUpdate(withEvent);

    for (const id of ['session-title', 'session-meta', 'question-slot', 'timeline']) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain(update.timeline);
    expect(html).toContain(update.meta);
  });

  it('keeps the composer out of what gets replaced', () => {
    // The bug this exists for: rewriting the document once a second closed the kind
    // dropdown and emptied the comment box while the human was still using them.
    const update = renderUpdate(withEvent);

    for (const fragment of [update.timeline, update.meta, update.question]) {
      expect(fragment).not.toContain('id="comment"');
      expect(fragment).not.toContain('id="kind"');
    }
  });

  it('escapes agent output in the fragments too, not only in the document', () => {
    const update = renderUpdate(
      view({
        events: [
          {
            seq: 1,
            ts: '2026-08-13T10:00:00.000Z',
            type: 'question',
            title: '<img src=x onerror=alert(1)>',
            options: ['" onclick="alert(2)'],
            needs_answer: true,
          },
        ],
        waitingQuestion: {
          seq: 1,
          ts: '2026-08-13T10:00:00.000Z',
          type: 'question',
          title: '<img src=x onerror=alert(1)>',
          options: ['" onclick="alert(2)'],
          needs_answer: true,
        },
      }),
    );

    expect(update.timeline).not.toContain('<img src=x');
    expect(update.question).not.toContain('<img src=x');
    expect(update.question).not.toContain('" onclick="alert(2)"');
    expect(update.question).toContain('&quot; onclick=&quot;alert(2)');
  });
});

describe('EXT-13: the webview never executes agent output', () => {
  it('escapes markup in titles, summaries and comments', () => {
    const html = renderSession(
      view({
        events: [
          {
            seq: 1,
            ts: '2026-08-13T10:00:00.000Z',
            type: 'progress',
            title: '<img src=x onerror=alert(1)>',
            summary: '</pre><script>alert(2)</script>',
          },
        ],
        comments: [
          {
            seq: 1,
            ts: '2026-08-13T10:00:00.000Z',
            kind: 'steer',
            text: '"><script>alert(3)</script>',
            reply_to: 1,
          },
        ],
      }),
      options,
    );

    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;script&gt;alert(2)&lt;/script&gt;');
  });

  it('escapes attributes that carry agent-chosen values', () => {
    const html = renderSession(
      view({
        waitingQuestion: {
          seq: 1,
          ts: '2026-08-13T10:00:00.000Z',
          type: 'question',
          title: 'which one?',
          needs_answer: true,
          options: ['" onclick="alert(1)'],
        },
        status: 'blocked',
      }),
      options,
    );

    expect(html).not.toContain('onclick="alert(1)"');
    expect(html).toContain('&quot; onclick=&quot;alert(1)');
  });

  it('locks the page down with a nonce-based policy', () => {
    const html = renderSession(view(), options);

    expect(html).toContain("default-src 'none'");
    expect(html).toContain("script-src 'nonce-test-nonce'");
    expect(html).toContain('<script nonce="test-nonce">');
  });

  it('escapes the five characters that matter and nothing else', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
    expect(escapeHtml('plain text — no change')).toBe('plain text — no change');
  });
});

describe('panel content', () => {
  it('says so when there is nothing to show yet', () => {
    expect(renderSession(view(), options)).toContain('No reports yet');
  });

  it('offers artifact chips and a reply button per report', () => {
    const html = renderSession(
      view({
        events: [
          {
            seq: 7,
            ts: '2026-08-13T10:00:00.000Z',
            type: 'artifact',
            title: 'proposed change',
            artifacts: ['artifacts/0007-plan.diff'],
          },
        ],
      }),
      options,
    );

    expect(html).toContain('data-ref="artifacts/0007-plan.diff"');
    expect(html).toContain('0007-plan.diff</button>');
    expect(html).toContain('data-reply-to="7"');
  });
});

describe('EXT-05: choosing a viewer for an artifact', () => {
  it('routes by file name first, declared kind second', () => {
    expect(openKindFor('artifacts/0001-plan.diff')).toBe('diff');
    expect(openKindFor('artifacts/0001-plan.patch')).toBe('diff');
    expect(openKindFor('artifacts/0002-report.md')).toBe('markdown');
    expect(openKindFor('artifacts/0003-shot.png')).toBe('image');
    expect(openKindFor('artifacts/0004-notes', 'markdown')).toBe('markdown');
    expect(openKindFor('artifacts/0005-data', 'json')).toBe('text');
    expect(openKindFor('artifacts/0006-thing')).toBe('text');
  });

  it('trusts the extension over a mislabelled kind', () => {
    expect(openKindFor('artifacts/0001-plan.diff', 'markdown')).toBe('diff');
  });
});

describe('EXT-06: when to interrupt the human', () => {
  const question = {
    seq: 4,
    ts: '2026-08-13T10:00:00.000Z',
    type: 'question' as const,
    title: 'Postgres or SQLite?',
    needs_answer: true,
    options: ['postgres', 'sqlite'],
  };

  it('notifies about a question, offering the agent options as buttons', () => {
    const plan = planNotification(view({ waitingQuestion: question, status: 'blocked' }));

    expect(plan.level).toBe('info');
    expect(plan.message).toContain('Postgres or SQLite?');
    expect(plan.actions).toEqual(['postgres', 'sqlite']);
  });

  it('does not notify twice about the same question', () => {
    const previous = view({ waitingQuestion: question, status: 'blocked' });
    const plan = planNotification(previous, previous);

    expect(plan.level).toBe('none');
  });

  it('stays silent for ordinary progress', () => {
    const events = [
      { seq: 1, ts: '2026-08-13T10:00:00.000Z', type: 'progress' as const, title: 'a milestone' },
    ];
    expect(planNotification(view({ events })).level).toBe('none');
  });

  it('reports an error the agent has just published', () => {
    const previous = view({
      events: [{ seq: 1, ts: '2026-08-13T10:00:00.000Z', type: 'progress', title: 'fine so far' }],
    });
    const next = view({
      events: [
        ...previous.events,
        { seq: 2, ts: '2026-08-13T10:00:01.000Z', type: 'error', title: 'the build will not link' },
      ],
    });

    const plan = planNotification(next, previous);

    expect(plan.level).toBe('error');
    expect(plan.message).toContain('the build will not link');
  });

  it('does not re-report an error that was already on screen', () => {
    const events = [{ seq: 1, ts: '2026-08-13T10:00:00.000Z', type: 'error' as const, title: 'old news' }];
    const previous = view({ events });

    expect(planNotification(view({ events }), previous).level).toBe('none');
  });
});

describe('EXT-21: an agent that publishes nothing still gets a timeline', () => {
  const pulse = {
    currentTool: 'shell',
    stale: false,
    entries: [
      { ts: '2026-08-13T10:00:00.000Z', kind: 'message' as const, text: 'Reading the parser tests' },
      { ts: '2026-08-13T10:00:05.000Z', kind: 'tool' as const, text: 'shell: pytest -q' },
      { ts: '2026-08-13T10:00:20.000Z', kind: 'message' as const, text: 'Three tests are red, fixing' },
    ],
  };

  it('draws every transcript line as its own row, oldest first', () => {
    const timeline = renderUpdate(view(), pulse).timeline;

    expect(timeline).toContain('Reading the parser tests');
    expect(timeline).toContain('shell: pytest -q');
    expect(timeline).toContain('Three tests are red, fixing');
    expect(timeline.indexOf('Reading the parser tests')).toBeLessThan(
      timeline.indexOf('Three tests are red, fixing'),
    );
  });

  it('offers a comment button on what the agent said, but not on a tool call', () => {
    const timeline = renderUpdate(view(), pulse).timeline;

    expect(timeline.match(/class="reply-after"/g)).toHaveLength(2);
    expect(timeline).not.toContain('data-after="shell: pytest -q"');
  });

  it('keeps the heading as the session name, not a copy of the newest line', () => {
    // The heading and the top row said the same thing when the pulse was one field.
    const update = renderUpdate(view(), pulse);

    expect(update.title).toBe('agent session sess-1');
    expect(update.meta).toContain('running shell');
  });

  it('takes staleness from the transcript, which is the one that knows', () => {
    // Session metadata stops changing the moment the agent stops reporting, so a
    // working agent would otherwise be marked stale ten minutes in.
    const quiet = view({ stale: true });

    expect(renderUpdate(quiet, pulse).meta).not.toContain('no activity');
    expect(renderUpdate(quiet, { ...pulse, stale: true }).meta).toContain('no activity');
  });

  it('EXT-13: escapes the transcript like everything else the agent wrote', () => {
    const hostile = {
      currentTool: '<img src=x>',
      stale: false,
      entries: [{ ts: null, kind: 'message' as const, text: '<script>alert(1)</script>' }],
    };
    const update = renderUpdate(view(), hostile);

    expect(update.meta).not.toContain('<img');
    expect(update.timeline).not.toContain('<script>');
    expect(renderSession(view(), options, hostile)).not.toContain('<script>alert(1)</script>');
  });

  it('stands down once real reports arrive rather than doubling them', () => {
    const reported = view({
      events: [{ seq: 1, ts: '2026-08-13T10:00:00.000Z', type: 'progress', title: 'first milestone' }],
    });
    const update = renderUpdate(reported, pulse);

    expect(update.meta).not.toContain('running shell');
    expect(update.timeline).not.toContain('Reading the parser tests');
    expect(update.timeline).toContain('first milestone');
  });
});

describe('EXT-22: a comment addressed to nothing is still visible', () => {
  const comment = (overrides = {}) => ({
    seq: 1,
    ts: '2026-08-13T10:00:10.000Z',
    kind: 'steer' as const,
    text: 'do not touch legacy/',
    ...overrides,
  });

  it('gives it a row of its own, in the order it was written', () => {
    // Written into the box at the bottom, it has no report to sit under, and used to
    // be visible nowhere at all: "what have I already told it" was unanswerable.
    const update = renderUpdate(
      view({
        events: [
          { seq: 1, ts: '2026-08-13T10:00:00.000Z', type: 'progress', title: 'first milestone' },
          { seq: 2, ts: '2026-08-13T10:00:20.000Z', type: 'progress', title: 'second milestone' },
        ],
        comments: [comment()],
      }),
    );

    expect(update.timeline).toContain('comment-standalone');
    expect(update.timeline.indexOf('do not touch legacy/')).toBeGreaterThan(
      update.timeline.indexOf('first milestone'),
    );
    expect(update.timeline.indexOf('do not touch legacy/')).toBeLessThan(
      update.timeline.indexOf('second milestone'),
    );
  });

  it('leaves a comment addressed to a report inside that report', () => {
    const update = renderUpdate(
      view({
        events: [{ seq: 1, ts: '2026-08-13T10:00:00.000Z', type: 'progress', title: 'first milestone' }],
        comments: [comment({ reply_to: 1 })],
      }),
    );

    expect(update.timeline).not.toContain('comment-standalone');
    expect(update.timeline).toContain('do not touch legacy/');
  });

  it('sits between the transcript lines it was written between', () => {
    const update = renderUpdate(view({ comments: [comment()] }), {
      currentTool: null,
      stale: false,
      entries: [
        { ts: '2026-08-13T10:00:00.000Z', kind: 'message' as const, text: 'starting on the parser' },
        { ts: '2026-08-13T10:00:20.000Z', kind: 'message' as const, text: 'parser done' },
      ],
    });

    expect(update.timeline.indexOf('starting on the parser')).toBeLessThan(
      update.timeline.indexOf('do not touch legacy/'),
    );
    expect(update.timeline.indexOf('do not touch legacy/')).toBeLessThan(
      update.timeline.indexOf('parser done'),
    );
  });
});
