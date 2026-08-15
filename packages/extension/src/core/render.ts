import type { AgentEvent, Comment } from '@agent-monitor/protocol';

import { artifactLabel } from './artifacts.js';
import type { SessionView } from './model.js';
import { sessionLabel } from './notify.js';

export interface RenderOptions {
  /** Nonce for the single inline script; required by the webview's CSP. */
  nonce: string;
  /** `webview.cspSource`, the only origin allowed to load anything. */
  cspSource: string;
}

/**
 * What the agent's own transcript says, for a session that publishes nothing.
 *
 * Structural on purpose: this is a `PassiveSessionView` seen through the smallest
 * shape the panel needs, so the renderer keeps knowing nothing about the passive layer.
 */
export interface SessionPulse {
  currentTool: string | null;
  stale: boolean;
  entries: readonly { ts: string | null; kind: 'message' | 'tool'; text: string }[];
}

/**
 * Build the session panel.
 *
 * Every value that reaches the page goes through {@link escapeHtml} first. Event
 * titles and summaries are written by a language model quoting a codebase, so they
 * routinely contain angle brackets and quotes; treating them as markup would be an
 * injection bug with the agent as the attacker's mouthpiece (TESTS.md EXT-13).
 *
 * Summaries render as pre-wrapped text rather than markdown. Parsing markdown would
 * mean either a dependency inside the webview or a hand-rolled parser producing HTML
 * from model output — both worse trades than losing bold text.
 */
export function renderSession(session: SessionView, options: RenderOptions, pulse?: SessionPulse): string {
  const update = renderUpdate(session, pulse);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${options.cspSource} 'unsafe-inline'; script-src 'nonce-${options.nonce}';">
<title>${escapeHtml(update.title)}</title>
<style>${STYLES}</style>
</head>
<body>
<header class="session-header">
  <h1 id="session-title">${escapeHtml(update.title)}</h1>
  <p class="meta" id="session-meta">${update.meta}</p>
</header>

<div id="question-slot">${update.question}</div>

<main class="timeline" id="timeline">
${update.timeline}
</main>

<footer class="composer">
  <label for="comment">Comment to the agent</label>
  <textarea id="comment" rows="3" placeholder="It will be delivered without interrupting the agent."></textarea>
  <div class="composer-actions">
    <select id="kind" aria-label="Comment kind">
      <option value="steer">steer — change the plan</option>
      <option value="fyi">fyi — context only</option>
      <option value="stop">stop — stop and wait for me</option>
    </select>
    <button id="send">Send</button>
  </div>
</footer>

<script nonce="${options.nonce}">${SCRIPT}</script>
</body>
</html>`;
}

/**
 * Everything about a panel that changes while it is open.
 *
 * Kept separate from the document around it because rewriting a webview's `html` is a
 * page load: it closes an open dropdown, empties the comment box and takes the focus,
 * which on a one-second refresh makes the composer unusable. The panel is written
 * once and then patched with these fragments.
 */
export interface SessionUpdate {
  /** Panel title, and the heading inside it. */
  title: string;
  meta: string;
  question: string;
  timeline: string;
}

export function renderUpdate(session: SessionView, pulse?: SessionPulse): SessionUpdate {
  const stale = pulse ? pulse.stale : session.stale;
  const showPulse = session.events.length === 0;

  return {
    title: sessionLabel(session),
    meta: [
      `<span class="status status-${escapeHtml(session.status)}">${escapeHtml(session.status)}</span>`,
      `<span>${escapeHtml(session.meta?.agent ?? 'agent')}</span>`,
      showPulse && pulse?.currentTool
        ? `<span class="pulse">running ${escapeHtml(pulse.currentTool)}</span>`
        : '',
      stale ? '<span class="stale">no activity for a while</span>' : '',
    ]
      .filter(Boolean)
      .join('\n    '),
    question: session.waitingQuestion ? renderQuestion(session.waitingQuestion) : '',
    timeline: renderTimeline(session, showPulse ? pulse : undefined),
  };
}

/**
 * One time-ordered column out of three sources.
 *
 * Published reports are the real timeline. Comments addressed to a report are drawn
 * inside it, but one written into the box at the bottom has no report to belong to —
 * it used to be visible nowhere at all — so it takes a row of its own at the time it
 * was written. The transcript fills the column while the agent publishes nothing:
 * that is the whole timeline for an agent that never calls the tools, and it stands
 * down as soon as real reports arrive rather than doubling them.
 */
function renderTimeline(session: SessionView, pulse?: SessionPulse): string {
  const rows: { ts: string; html: string }[] = [
    ...session.events.map((event) => ({ ts: event.ts, html: renderEvent(event, session) })),
    ...session.comments
      .filter((comment) => comment.reply_to === undefined)
      .map((comment) => ({ ts: comment.ts, html: renderStandaloneComment(comment) })),
    ...(pulse?.entries ?? []).map((entry) => ({ ts: entry.ts ?? '', html: renderPassiveEntry(entry) })),
  ];

  if (rows.length === 0) {
    return '<p class="empty">No reports yet. The agent publishes one at each milestone.</p>';
  }

  // Stable on equal timestamps, which is the normal case inside one transcript record.
  return rows
    .map((row, index) => ({ ...row, index }))
    .sort((a, b) => (a.ts === b.ts ? a.index - b.index : a.ts < b.ts ? -1 : 1))
    .map((row) => row.html)
    .join('\n');
}

/**
 * A line from the agent's own transcript.
 *
 * Deliberately not styled as a report: nobody published it, it carries no `seq`, and a
 * comment cannot be addressed to it. What the human gets instead is a button that aims
 * the composer at this moment — the comment then lands in the row below it, because
 * both are placed by time.
 */
function renderPassiveEntry(entry: SessionPulse['entries'][number]): string {
  const time =
    entry.ts === null
      ? ''
      : `<time datetime="${escapeHtml(entry.ts)}">${escapeHtml(formatTime(entry.ts))}</time>`;

  if (entry.kind === 'tool') {
    return `<div class="passive passive-tool">
  ${time}
  <span class="text">${escapeHtml(entry.text)}</span>
</div>`;
  }

  return `<article class="passive passive-message">
  <div class="event-head">
    <span class="source">from the transcript</span>
    ${time}
  </div>
  <pre class="summary">${escapeHtml(entry.text)}</pre>
  <button class="reply-after" data-after="${escapeHtml(entry.text.slice(0, 60))}">Comment on this</button>
</article>`;
}

function renderStandaloneComment(comment: Comment): string {
  return `<div class="comment comment-standalone comment-${escapeHtml(comment.kind)}">
  <span class="kind">${escapeHtml(comment.kind)}</span>
  <time datetime="${escapeHtml(comment.ts)}">${escapeHtml(formatTime(comment.ts))}</time>
  <span class="text">${escapeHtml(comment.text)}</span>
</div>`;
}

function renderQuestion(question: AgentEvent): string {
  const options = Array.isArray(question.options)
    ? question.options.filter((option): option is string => typeof option === 'string')
    : [];

  const buttons = options
    .map(
      (option) =>
        `<button class="answer" data-answer="${escapeHtml(option)}" data-reply-to="${question.seq}">${escapeHtml(option)}</button>`,
    )
    .join('');

  return `<section class="question">
  <h2>The agent is waiting for you</h2>
  <p>${escapeHtml(question.title)}</p>
  <div class="answers">${buttons}</div>
</section>`;
}

function renderEvent(event: AgentEvent, session: SessionView): string {
  const replies = session.comments.filter((comment) => comment.reply_to === event.seq);

  return `<article class="event event-${escapeHtml(event.type)}" data-seq="${event.seq}">
  <div class="event-head">
    <span class="seq">#${event.seq}</span>
    ${event.phase === undefined ? '' : `<span class="phase">${escapeHtml(event.phase)}</span>`}
    <time datetime="${escapeHtml(event.ts)}">${escapeHtml(formatTime(event.ts))}</time>
    ${event.throttled === true ? '<span class="throttled">rapid</span>' : ''}
  </div>
  <h3>${escapeHtml(event.title)}</h3>
  ${event.summary === undefined ? '' : `<pre class="summary">${escapeHtml(event.summary)}</pre>`}
  ${event.next === undefined ? '' : `<p class="next"><strong>Next:</strong> ${escapeHtml(event.next)}</p>`}
  ${renderArtifacts(event)}
  ${replies.map(renderComment).join('')}
  <button class="reply" data-reply-to="${event.seq}">Comment on this</button>
</article>`;
}

function renderArtifacts(event: AgentEvent): string {
  const refs = Array.isArray(event.artifacts)
    ? event.artifacts.filter((ref): ref is string => typeof ref === 'string')
    : [];
  if (refs.length === 0) return '';

  const chips = refs
    .map(
      (ref) =>
        `<button class="artifact" data-ref="${escapeHtml(ref)}" data-kind="${escapeHtml(String(event.kind ?? ''))}">${escapeHtml(artifactLabel(ref))}</button>`,
    )
    .join('');
  return `<div class="artifacts">${chips}</div>`;
}

function renderComment(comment: Comment): string {
  return `<div class="comment comment-${escapeHtml(comment.kind)}">
  <span class="kind">${escapeHtml(comment.kind)}</span>
  <span class="text">${escapeHtml(comment.text)}</span>
</div>`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTime(ts: string): string {
  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed)) return ts;
  return new Date(parsed).toISOString().slice(11, 19);
}

const STYLES = `
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0 1rem 8rem; }
.session-header h1 { font-size: 1.1rem; margin-bottom: 0.2rem; }
.meta { display: flex; gap: 0.6rem; font-size: 0.85rem; opacity: 0.8; margin-top: 0; }
.status { text-transform: uppercase; letter-spacing: 0.04em; }
.status-blocked { color: var(--vscode-editorWarning-foreground); }
.status-done { opacity: 0.6; }
.stale { color: var(--vscode-editorWarning-foreground); }
.question { border: 1px solid var(--vscode-editorWarning-foreground); border-radius: 4px; padding: 0.6rem 0.8rem; margin: 0.8rem 0; }
.question h2 { font-size: 0.9rem; margin: 0 0 0.3rem; }
.answers { display: flex; flex-wrap: wrap; gap: 0.4rem; }
.event { border-left: 2px solid var(--vscode-panel-border); padding: 0.4rem 0 0.8rem 0.8rem; margin-bottom: 0.6rem; }
.event-head { display: flex; gap: 0.6rem; font-size: 0.75rem; opacity: 0.7; }
.event h3 { font-size: 0.95rem; margin: 0.2rem 0; }
.summary { white-space: pre-wrap; word-break: break-word; font-family: var(--vscode-editor-font-family); font-size: 0.85rem; margin: 0.3rem 0; }
.artifacts { display: flex; flex-wrap: wrap; gap: 0.4rem; margin: 0.4rem 0; }
.comment { display: flex; gap: 0.5rem; font-size: 0.85rem; margin-top: 0.3rem; opacity: 0.9; }
.comment .kind { text-transform: uppercase; font-size: 0.7rem; opacity: 0.7; }
.empty { opacity: 0.7; }
.pulse { opacity: 0.8; }
.passive { border-left: 2px dashed var(--vscode-panel-border); padding: 0.3rem 0 0.5rem 0.8rem; margin-bottom: 0.5rem; }
.passive .source { text-transform: uppercase; letter-spacing: 0.04em; }
.passive-tool { display: flex; gap: 0.6rem; font-size: 0.8rem; opacity: 0.65; font-family: var(--vscode-editor-font-family); }
.passive-tool .text { word-break: break-word; }
.comment-standalone { border-left: 2px solid var(--vscode-textLink-foreground); padding-left: 0.8rem; margin: 0.4rem 0; }
.comment time { opacity: 0.6; font-size: 0.75rem; }
.composer { position: fixed; bottom: 0; left: 0; right: 0; background: var(--vscode-editor-background); border-top: 1px solid var(--vscode-panel-border); padding: 0.5rem 1rem; }
.composer label { font-size: 0.75rem; opacity: 0.7; }
.composer textarea { width: 100%; box-sizing: border-box; }
.composer-actions { display: flex; gap: 0.5rem; margin-top: 0.3rem; }
button { cursor: pointer; }
`;

const SCRIPT = `
const vscode = acquireVsCodeApi();
const box = document.getElementById('comment');
const kind = document.getElementById('kind');
let replyTo;

// Patch the parts that change; never the composer. A half-typed comment and an open
// dropdown belong to the human, and a report arriving mid-sentence must not take them.
window.addEventListener('message', (event) => {
  const update = event.data;
  if (!update || update.type !== 'update') return;

  const atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 40;
  document.getElementById('session-title').textContent = update.title;
  document.getElementById('session-meta').innerHTML = update.meta;
  document.getElementById('question-slot').innerHTML = update.question;
  document.getElementById('timeline').innerHTML = update.timeline;
  // Following the agent should keep following it; reading history should not jump.
  if (atBottom) window.scrollTo(0, document.body.scrollHeight);
});

function send() {
  const text = box.value.trim();
  if (text === '') return;
  vscode.postMessage({ type: 'comment', text, kind: kind.value, replyTo });
  box.value = '';
  replyTo = undefined;
}

document.getElementById('send').addEventListener('click', send);
box.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) send();
});

document.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  if (target.classList.contains('artifact')) {
    vscode.postMessage({ type: 'openArtifact', ref: target.dataset.ref, kind: target.dataset.kind });
  } else if (target.classList.contains('answer')) {
    vscode.postMessage({
      type: 'comment',
      text: target.dataset.answer,
      kind: 'answer',
      replyTo: Number(target.dataset.replyTo),
    });
  } else if (target.classList.contains('reply')) {
    replyTo = Number(target.dataset.replyTo);
    box.focus();
    box.placeholder = 'Replying to report #' + replyTo;
  } else if (target.classList.contains('reply-after')) {
    // Nothing to address: a transcript line has no seq. The comment is placed by time,
    // so it lands directly under the line the human was looking at.
    replyTo = undefined;
    box.focus();
    box.placeholder = 'Commenting after: ' + target.dataset.after;
  }
});
`;
