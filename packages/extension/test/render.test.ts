import { describe, expect, it } from 'vitest';

import { openKindFor } from '../src/core/artifacts.js';
import type { SessionView } from '../src/core/model.js';
import { planNotification, sessionChoices } from '../src/core/notify.js';
import {
  COMMENT_KIND_CHOICES,
  DEFAULT_STOP_REASON,
  STOP_CHOICE,
  commentKindLabel,
} from '../src/core/kinds.js';
import {
  diffRows,
  escapeHtml,
  formatTime,
  renderRows,
  renderSession,
  renderUpdate,
} from '../src/core/render.js';

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
    archived: false,
    ...overrides,
  };
}

const options = { nonce: 'test-nonce', cspSource: 'vscode-webview://x' };

/** The timeline as one string, for the assertions that only care about content. */
function timelineOf(update: ReturnType<typeof renderUpdate>): string {
  return renderRows(update.rows);
}

function pulseEntry(
  ordinal: number,
  ts: string | null,
  kind: 'message' | 'tool',
  text: string,
): { ordinal: number; ts: string | null; kind: 'message' | 'tool'; text: string } {
  return { ordinal, ts, kind, text };
}

const TRANSCRIPT = '/home/u/.claude/projects/-work/session.jsonl';

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

    expect(timelineOf(update)).toContain('Parser split into three modules');
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
    expect(html).toContain(timelineOf(update));
    expect(html).toContain(update.meta);
  });

  it('keeps the composer out of what gets replaced', () => {
    // The bug this exists for: rewriting the document once a second closed the kind
    // dropdown and emptied a comment the human was halfway through typing.
    const update = renderUpdate(withEvent);

    for (const fragment of [update.meta, update.question, timelineOf(update)]) {
      expect(fragment).not.toContain('id="comment"');
      expect(fragment).not.toContain('id="kind"');
      expect(fragment).not.toContain('id="send"');
    }
  });

  it('gives every row a key that survives a refresh', () => {
    const update = renderUpdate(
      view({
        events: withEvent.events,
        comments: [{ seq: 1, ts: '2026-08-13T10:00:05.000Z', kind: 'steer', text: 'careful' }],
      }),
    );

    expect(update.rows.map((row) => row.key)).toEqual(['event:1', 'comment:1']);
    expect(renderRows(update.rows)).toContain('data-key="event:1"');
  });
});

describe('EXT-25: a refresh redraws only what changed', () => {
  const first = renderUpdate(
    view({
      events: [{ seq: 1, ts: '2026-08-13T10:00:00.000Z', type: 'progress', title: 'first milestone' }],
    }),
  );

  it('leaves an untouched row out of the patch', () => {
    // This is what the human's text selection rides on: a row nobody touched keeps its
    // DOM node. Replacing the whole timeline once a second made copying anything out of
    // the panel impossible.
    const second = renderUpdate(
      view({
        events: [
          { seq: 1, ts: '2026-08-13T10:00:00.000Z', type: 'progress', title: 'first milestone' },
          { seq: 2, ts: '2026-08-13T10:00:20.000Z', type: 'progress', title: 'second milestone' },
        ],
      }),
    );

    const diff = diffRows(first.rows, second.rows);

    expect(diff.order).toEqual(['event:1', 'event:2']);
    expect(diff.changed.map((row) => row.key)).toEqual(['event:2']);
  });

  it('patches a row whose content moved', () => {
    // A delivered comment changes the report it hangs under, and that one row alone.
    const withReply = view({
      events: [{ seq: 1, ts: '2026-08-13T10:00:00.000Z', type: 'progress', title: 'first milestone' }],
      comments: [{ seq: 1, ts: '2026-08-13T10:00:05.000Z', kind: 'steer', text: 'careful', reply_to: 1 }],
    });

    const undelivered = renderUpdate(withReply);
    const delivered = renderUpdate({ ...withReply, cursorSeq: 1 });
    const diff = diffRows(undelivered.rows, delivered.rows);

    expect(diff.changed.map((row) => row.key)).toEqual(['event:1']);
  });

  it('reports nothing to change when nothing changed', () => {
    expect(diffRows(first.rows, first.rows).changed).toEqual([]);
  });

  it('drops a row that is gone from the order', () => {
    const empty = renderUpdate(view());
    const diff = diffRows(first.rows, empty.rows);

    expect(diff.order).toEqual(['empty']);
    expect(diff.order).not.toContain('event:1');
  });

  it('keys a transcript line by its ordinal, so trimming the list does not redraw it', () => {
    // The list is capped at 200 and drops entries off the front; an index into it would
    // shift under every trim and repaint the whole column.
    const pulse = {
      currentTool: null,
      stale: false,
      transcriptPath: TRANSCRIPT,
      entries: [
        pulseEntry(7, '2026-08-13T10:00:00.000Z', 'message', 'still here'),
        pulseEntry(8, '2026-08-13T10:00:10.000Z', 'message', 'newest'),
      ],
    };
    const before = renderUpdate(view(), { ...pulse, entries: [pulse.entries[0] as never] });
    const after = renderUpdate(view(), pulse);

    expect(diffRows(before.rows, after.rows).changed.map((row) => row.key)).toEqual(['pulse:8']);
  });
});

describe("EXT-26: times are the reader's own", () => {
  it('shifts a UTC record onto the local clock', () => {
    // It printed `toISOString()`, so every time in the panel was off by the reader's
    // offset, silently and with no way to tell.
    expect(formatTime('2026-08-13T22:30:05.000Z', 180)).toBe('01:30:05');
    expect(formatTime('2026-08-13T22:30:05.000Z', -300)).toBe('17:30:05');
    expect(formatTime('2026-08-13T22:30:05.000Z', 0)).toBe('22:30:05');
  });

  it('hands back an unparsable stamp untouched rather than inventing one', () => {
    expect(formatTime('not a time')).toBe('not a time');
  });

  it('stamps a reply inside a report, where the delay is visible', () => {
    const timeline = timelineOf(
      renderUpdate(
        view({
          events: [{ seq: 1, ts: '2026-08-13T10:00:00.000Z', type: 'progress', title: 'milestone' }],
          comments: [{ seq: 1, ts: '2026-08-13T10:04:00.000Z', kind: 'steer', text: 'careful', reply_to: 1 }],
        }),
      ),
    );

    expect(timeline).toContain('datetime="2026-08-13T10:04:00.000Z"');
  });
});

describe('EXT-27: a comment says whether the agent has seen it', () => {
  const commented = view({
    events: [{ seq: 1, ts: '2026-08-13T10:00:00.000Z', type: 'progress', title: 'milestone' }],
    comments: [
      { seq: 1, ts: '2026-08-13T10:00:05.000Z', kind: 'steer', text: 'read me', reply_to: 1 },
      { seq: 2, ts: '2026-08-13T10:00:06.000Z', kind: 'fyi', text: 'not yet' },
    ],
  });

  it('separates delivered from waiting', () => {
    // "The agent read it and ignored me" and "it never arrived" used to look identical,
    // and they are different problems fixed in different places (DESIGN.md §10).
    const timeline = timelineOf(renderUpdate({ ...commented, cursorSeq: 1 }));

    expect(timeline).toContain('>delivered<');
    expect(timeline).toContain('>not delivered yet<');
  });

  it('calls everything undelivered while the cursor is at zero', () => {
    const timeline = timelineOf(renderUpdate(commented));

    expect(timeline).not.toContain('>delivered<');
    expect(timeline.match(/>not delivered yet</g)).toHaveLength(2);
  });
});

describe('EXT-28: stopping the agent is an action, not a kind of remark', () => {
  it('keeps stop out of the list of what a comment is', () => {
    // The list answers "what am I telling you"; a button answers "what are you doing".
    const html = renderSession(view(), options);
    const select = html.slice(html.indexOf('<select id="kind"'), html.indexOf('</select>'));

    expect(select).toContain('value="steer"');
    expect(select).toContain('value="fyi"');
    expect(select).not.toContain('value="stop"');
    expect(html).toContain('id="stop"');
  });

  it('carries a reason for a stop sent with an empty box', () => {
    // The schema wants non-empty text, so stopping without typing anything was
    // impossible; an empty string tells the agent nothing anyway.
    const html = renderSession(view(), options);

    expect(DEFAULT_STOP_REASON).not.toBe('');
    expect(html).toContain(JSON.stringify(DEFAULT_STOP_REASON));
  });

  it('says on the button that carrying on happens elsewhere', () => {
    // A blocked agent ends its turn and waits on its own terminal; hooks stop running,
    // so nothing written to the session reaches it. There is no "carry on" button to
    // pair with this one (docs-local/live/FINDINGS.md §1).
    expect(renderSession(view(), options)).toContain('terminal it runs in');
  });

  it('says of each kind whether the agent has to obey it', () => {
    // The one thing the choice turns on. It leads the hint rather than trailing a
    // sentence about the plan, because it is what the human is deciding.
    const html = renderSession(view(), options);

    expect(html).toContain('Binding: the agent applies it from its next step');
    expect(html).toContain('Not binding: the agent takes note');
  });
});

describe('EXT-21: an agent that publishes nothing still gets a timeline', () => {
  const pulse = {
    currentTool: 'shell',
    stale: false,
    transcriptPath: TRANSCRIPT,
    entries: [
      pulseEntry(1, '2026-08-13T10:00:00.000Z', 'message', 'Reading the parser tests'),
      pulseEntry(2, '2026-08-13T10:00:05.000Z', 'tool', 'shell: pytest -q'),
      pulseEntry(3, '2026-08-13T10:00:20.000Z', 'message', 'Three tests are red, fixing'),
    ],
  };

  it('draws every transcript line as its own row, oldest first', () => {
    const update = renderUpdate(view(), pulse);

    expect(update.rows.map((row) => row.key)).toEqual(['pulse:1', 'pulse:2', 'pulse:3']);
    expect(timelineOf(update)).toContain('shell: pytest -q');
  });

  it('offers a comment button on what the agent said, but not on a tool call', () => {
    const timeline = timelineOf(renderUpdate(view(), pulse));

    expect(timeline.match(/class="reply-after"/g)).toHaveLength(2);
    expect(timeline).not.toContain('data-after="shell: pytest -q"');
  });

  it('keeps the heading as the session name, not a copy of the newest line', () => {
    // The heading and the top row said the same thing when the pulse was one field.
    const update = renderUpdate(view(), pulse);

    expect(update.title).toBe('agent session sess-1');
    expect(update.meta).toContain('running shell');
  });

  it('offers the transcript, which is where the untruncated text lives', () => {
    expect(renderUpdate(view(), pulse).meta).toContain(TRANSCRIPT);
  });

  it('takes staleness from the transcript, which is the one that knows', () => {
    const quiet = view({ stale: true });

    expect(renderUpdate(quiet, pulse).meta).not.toContain('no activity');
    expect(renderUpdate(quiet, { ...pulse, stale: true }).meta).toContain('no activity');
  });

  it('EXT-13: escapes the transcript like everything else the agent wrote', () => {
    const hostile = {
      currentTool: '<img src=x>',
      stale: false,
      transcriptPath: '"><script>alert(2)</script>',
      entries: [pulseEntry(1, null, 'message', '<script>alert(1)</script>')],
    };
    const update = renderUpdate(view(), hostile);

    expect(update.meta).not.toContain('<img');
    expect(update.meta).not.toContain('<script>');
    expect(timelineOf(update)).not.toContain('<script>');
    expect(renderSession(view(), options, hostile)).not.toContain('<script>alert(1)</script>');
  });

  it('stands down once real reports arrive rather than doubling them', () => {
    const reported = view({
      events: [{ seq: 1, ts: '2026-08-13T10:00:00.000Z', type: 'progress', title: 'first milestone' }],
    });
    const update = renderUpdate(reported, pulse);

    expect(update.meta).not.toContain('running shell');
    expect(timelineOf(update)).not.toContain('Reading the parser tests');
    expect(timelineOf(update)).toContain('first milestone');
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

    expect(update.rows.map((row) => row.key)).toEqual(['event:1', 'comment:1', 'event:2']);
  });

  it('leaves a comment addressed to a report inside that report', () => {
    const update = renderUpdate(
      view({
        events: [{ seq: 1, ts: '2026-08-13T10:00:00.000Z', type: 'progress', title: 'first milestone' }],
        comments: [comment({ reply_to: 1 })],
      }),
    );

    expect(update.rows.map((row) => row.key)).toEqual(['event:1']);
    expect(timelineOf(update)).toContain('do not touch legacy/');
  });

  it('sits between the transcript lines it was written between', () => {
    const update = renderUpdate(view({ comments: [comment()] }), {
      currentTool: null,
      stale: false,
      transcriptPath: TRANSCRIPT,
      entries: [
        pulseEntry(1, '2026-08-13T10:00:00.000Z', 'message', 'starting on the parser'),
        pulseEntry(2, '2026-08-13T10:00:20.000Z', 'message', 'parser done'),
      ],
    });

    expect(update.rows.map((row) => row.key)).toEqual(['pulse:1', 'comment:1', 'pulse:2']);
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

describe('EXT-23: the question notification obeys its setting', () => {
  const asking = view({
    status: 'blocked',
    events: [
      {
        seq: 1,
        ts: '2026-08-13T10:00:00.000Z',
        type: 'question',
        title: 'Rewrite the CLI or keep it?',
        needs_answer: true,
      },
    ],
  });
  const blocked = { ...asking, waitingQuestion: asking.events[0] ?? null };

  it('withholds the popup when the human turned it off', () => {
    expect(planNotification(blocked, undefined, { onQuestion: false }).level).toBe('none');
  });

  it('shows it by default, and when the setting is unset', () => {
    // `agentMonitor.notifyOnQuestion` was declared in package.json and read by nobody:
    // switching it off changed nothing at all.
    expect(planNotification(blocked).level).toBe('info');
    expect(planNotification(blocked, undefined, {}).level).toBe('info');
    expect(planNotification(blocked, undefined, { onQuestion: true }).level).toBe('info');
  });

  it('still reports an error, which the setting does not cover', () => {
    // An agent that hit a wall is not something to find out about later.
    const failed = view({
      events: [{ seq: 1, ts: '2026-08-13T10:00:00.000Z', type: 'error', title: 'the build will not link' }],
    });

    expect(planNotification(failed, undefined, { onQuestion: false }).level).toBe('error');
  });
});

describe('EXT-29: choosing between sessions', () => {
  const session = (id: string, title?: string): SessionView =>
    view({
      id,
      meta: {
        id,
        agent: 'codex',
        cwd: '/work',
        status: 'working',
        started_at: '2026-08-13T10:00:00.000Z',
        updated_at: '2026-08-13T10:00:00.000Z',
        protocol_version: 1,
        ...(title === undefined ? {} : { title }),
      },
    });

  it('carries the id, so two identical titles are still two sessions', () => {
    // Titles come from a language model and can match. Picking the session back out by
    // its label handed the comment to whichever was first — silently, and in the case
    // where being precise matters most.
    const choices = sessionChoices([
      session('sess-a', 'Refactoring the parser'),
      session('sess-b', 'Refactoring the parser'),
    ]);

    expect(choices.map((choice) => choice.id)).toEqual(['sess-a', 'sess-b']);
    expect(choices[0]?.description).not.toBe(choices[1]?.description);
  });

  it('says enough in the description to tell them apart', () => {
    const [choice] = sessionChoices([
      {
        ...session('sess-a'),
        unread: [{ seq: 1, ts: '2026-08-13T10:00:00.000Z', kind: 'steer', text: 'careful' }],
      },
    ]);

    expect(choice?.description).toContain('codex');
    expect(choice?.description).toContain('working');
    expect(choice?.description).toContain('1 undelivered');
    expect(choice?.description).toContain('sess-a');
  });
});

describe('EXT-31: one wording for a comment kind, not two', () => {
  it('offers the panel exactly the choices the palette offers', () => {
    // The panel had three short labels and the palette had different sentences for the
    // same three things, which is how they end up meaning subtly different things.
    const html = renderSession(view(), options);

    for (const choice of COMMENT_KIND_CHOICES) {
      expect(html).toContain(`value="${choice.kind}"`);
      expect(html).toContain(choice.label);
      expect(html).toContain(choice.detail);
    }
  });

  it('keeps stop out of that list and names the cost on it', () => {
    expect(COMMENT_KIND_CHOICES.map((choice) => choice.kind)).not.toContain('stop');
    expect(STOP_CHOICE.detail).toContain('terminal it runs in');
  });

  it('badges a comment in the timeline with the wording it was sent under', () => {
    // The badge used to print the name from the file, so a comment chosen as "Change
    // course" came back as "STEER" and the two read as different things.
    const html = renderRows(
      renderUpdate(
        view({
          comments: [
            { seq: 1, ts: '2026-08-13T10:00:05.000Z', kind: 'steer', text: 'careful' },
            { seq: 2, ts: '2026-08-13T10:00:06.000Z', kind: 'fyi', text: 'ci is red already' },
          ],
        }),
      ).rows,
    );

    expect(html).toContain('<span class="kind">course change</span>');
    expect(html).toContain('<span class="kind">context</span>');
    expect(html).not.toContain('>steer<');
    expect(html).not.toContain('>fyi<');
  });

  it('names the kind the human never picks', () => {
    // `answer` reaches the timeline from the buttons on a question, so it is in no
    // choice list and would have been the one badge left printing a wire name.
    expect(commentKindLabel('answer')).toBe('answer');
    expect(commentKindLabel('stop')).toBe('stop');
  });
});
