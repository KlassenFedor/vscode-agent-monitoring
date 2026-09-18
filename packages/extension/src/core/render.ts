import type { AgentEvent, Comment } from '@agent-monitor/protocol';

import { artifactLabel, linkLabel } from './artifacts.js';
import { COMMENT_KIND_CHOICES, DEFAULT_STOP_REASON, STOP_CHOICE, commentKindLabel } from './kinds.js';
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
  transcriptPath: string;
  entries: readonly { ordinal: number; ts: string | null; text: string }[];
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
${renderRows(update.rows)}
</main>

<footer class="composer">
  <div class="reply-banner" id="reply-banner" hidden>
    <span id="reply-target"></span>
    <button id="cancel-reply" type="button">Don't reply to it</button>
  </div>
  <label for="comment">Comment to the agent</label>
  <textarea id="comment" rows="3" placeholder="${escapeHtml(COMPOSER_PLACEHOLDER)}"></textarea>
  <div class="composer-actions">
    <select id="kind" aria-label="How the agent should treat this comment">
${renderKindOptions()}
    </select>
    <button id="send" type="button">Send</button>
    <button id="stop" type="button" class="danger" title="${escapeHtml(STOP_CHOICE.detail)}">${escapeHtml(STOP_CHOICE.label)}</button>
  </div>
  <p class="composer-hint" id="kind-hint"></p>
</footer>

<script nonce="${options.nonce}">${SCRIPT}</script>
</body>
</html>`;
}

/** One row of the timeline, with the identity that lets it be patched in place. */
export interface TimelineRow {
  /** Stable across refreshes: `event:12`, `comment:3`, `pulse:41`. */
  key: string;
  html: string;
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
  rows: TimelineRow[];
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
      pulse
        ? `<button class="transcript" type="button" data-path="${escapeHtml(pulse.transcriptPath)}">Open transcript</button>`
        : '',
    ]
      .filter(Boolean)
      .join('\n    '),
    question: session.waitingQuestion ? renderQuestion(session.waitingQuestion) : '',
    rows: buildRows(session, showPulse ? pulse : undefined),
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
function buildRows(session: SessionView, pulse?: SessionPulse): TimelineRow[] {
  const rows: (TimelineRow & { ts: string })[] = [
    ...session.events.map((event) => ({
      key: `event:${event.seq}`,
      ts: event.ts,
      html: renderEvent(event, session),
    })),
    ...session.comments
      .filter((comment) => comment.reply_to === undefined)
      .map((comment) => ({
        key: `comment:${comment.seq}`,
        ts: comment.ts,
        html: renderStandaloneComment(comment, session.cursorSeq),
      })),
    ...(pulse?.entries ?? []).map((entry) => ({
      key: `pulse:${entry.ordinal}`,
      ts: entry.ts ?? '',
      html: renderPassiveEntry(entry),
    })),
  ];

  if (rows.length === 0) {
    return [{ key: 'empty', html: EMPTY_TIMELINE }];
  }

  // Stable on equal timestamps, which is the normal case inside one transcript record.
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => (a.row.ts === b.row.ts ? a.index - b.index : a.row.ts < b.row.ts ? -1 : 1))
    .map(({ row }) => ({ key: row.key, html: row.html }));
}

export interface TimelineDiff {
  /** Every key, in the order they belong on screen. */
  order: string[];
  /** Rows that are new or whose markup changed; the rest must not be touched. */
  changed: TimelineRow[];
}

/**
 * What actually has to be redrawn.
 *
 * Replacing the whole timeline on every refresh cost the human their text selection
 * once a second, which with a growing transcript means copying anything out of the
 * panel is impossible. The decision of what changed is made here, where the ordinary
 * test suite reaches it, and the webview is left doing DOM mechanics only — the
 * webview script is the one part of this extension no test can see.
 */
export function diffRows(previous: readonly TimelineRow[], next: readonly TimelineRow[]): TimelineDiff {
  const before = new Map(previous.map((row) => [row.key, row.html]));

  return {
    order: next.map((row) => row.key),
    changed: next.filter((row) => before.get(row.key) !== row.html),
  };
}

export function renderRows(rows: readonly TimelineRow[]): string {
  return rows.map((row) => wrapRow(row)).join('\n');
}

/** The key has to survive on the node itself; that is how a patch finds its row. */
function wrapRow(row: TimelineRow): string {
  return `<div class="row" data-key="${escapeHtml(row.key)}">${row.html}</div>`;
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
    ${renderTime(event.ts)}
    ${event.throttled === true ? '<span class="throttled">rapid</span>' : ''}
  </div>
  <h3>${escapeHtml(event.title)}</h3>
  ${event.summary === undefined ? '' : `<pre class="summary">${escapeHtml(event.summary)}</pre>`}
  ${event.next === undefined ? '' : `<p class="next"><strong>Next:</strong> ${escapeHtml(event.next)}</p>`}
  ${renderArtifacts(event)}
  ${replies.map((comment) => renderComment(comment, session.cursorSeq)).join('')}
  <button class="reply" data-reply-to="${event.seq}">Comment on this</button>
</article>`;
}

/**
 * Chips for whatever the event attached: copies first, then links.
 *
 * The two are told apart on the chip rather than only in the markup, because clicking
 * one opens a snapshot this session owns and clicking the other opens the human's live
 * working copy. Somebody reading a week-old report needs to know which of those they
 * are about to look at.
 */
function renderArtifacts(event: AgentEvent): string {
  const kind = escapeHtml(String(event.kind ?? ''));
  const refs = Array.isArray(event.artifacts)
    ? event.artifacts.filter((ref): ref is string => typeof ref === 'string')
    : [];
  const links = Array.isArray(event.links)
    ? event.links.filter((link): link is string => typeof link === 'string')
    : [];
  if (refs.length === 0 && links.length === 0) return '';

  const chips = [
    ...refs.map(
      (ref) =>
        `<button class="artifact" data-ref="${escapeHtml(ref)}" data-kind="${kind}">${escapeHtml(artifactLabel(ref))}</button>`,
    ),
    ...links.map(
      (link) =>
        `<button class="artifact link" data-link="${escapeHtml(link)}" data-kind="${kind}" title="${escapeHtml(link)} — opened in place, not a copy">${escapeHtml(linkLabel(link))}</button>`,
    ),
  ].join('');
  return `<div class="artifacts">${chips}</div>`;
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
  return `<article class="passive passive-message">
  <div class="event-head">
    <span class="source">from the transcript</span>
    ${renderTime(entry.ts)}
  </div>
  <pre class="summary">${escapeHtml(entry.text)}</pre>
  <button class="reply-after" data-after="${escapeHtml(entry.text.slice(0, 60))}">Comment on this</button>
</article>`;
}

function renderStandaloneComment(comment: Comment, cursorSeq: number): string {
  return `<div class="comment comment-standalone comment-${escapeHtml(comment.kind)}">
  <span class="kind">${escapeHtml(commentKindLabel(comment.kind))}</span>
  ${renderTime(comment.ts)}
  <span class="text">${escapeHtml(comment.text)}</span>
  ${renderDelivery(comment, cursorSeq)}
</div>`;
}

function renderComment(comment: Comment, cursorSeq: number): string {
  return `<div class="comment comment-${escapeHtml(comment.kind)}">
  <span class="kind">${escapeHtml(commentKindLabel(comment.kind))}</span>
  ${renderTime(comment.ts)}
  <span class="text">${escapeHtml(comment.text)}</span>
  ${renderDelivery(comment, cursorSeq)}
</div>`;
}

/**
 * Whether the agent has actually seen this comment.
 *
 * Without it, "the agent read it and ignored me" and "it never arrived" look identical
 * on screen, and they are different problems fixed in different places (DESIGN.md §10).
 */
function renderDelivery(comment: Comment, cursorSeq: number): string {
  return comment.seq <= cursorSeq
    ? '<span class="delivered" title="The agent has read this.">delivered</span>'
    : '<span class="pending" title="Waiting for the agent to pick it up.">not delivered yet</span>';
}

function renderTime(ts: string | null): string {
  if (ts === null) return '';
  return `<time datetime="${escapeHtml(ts)}" title="${escapeHtml(ts)}">${escapeHtml(formatTime(ts))}</time>`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * `HH:MM:SS` on the reader's own clock.
 *
 * Records are stamped in UTC, and this used to print them that way: every time in the
 * panel was an hour or several off from the clock the human was looking at, silently.
 * The offset is a parameter so tests can name one instead of depending on the machine
 * the suite happens to run on.
 */
export function formatTime(ts: string, offsetMinutes?: number): string {
  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed)) return ts;

  const offset = offsetMinutes ?? -new Date(parsed).getTimezoneOffset();
  return new Date(parsed + offset * 60_000).toISOString().slice(11, 19);
}

const EMPTY_TIMELINE = '<p class="empty">No reports yet. The agent publishes one at each milestone.</p>';

const COMPOSER_PLACEHOLDER = 'It will be delivered without interrupting the agent.';

/**
 * The kinds, worded the same here as in the command palette.
 *
 * Both come from {@link COMMENT_KIND_CHOICES}: two sets of wording for the same three
 * things is how they end up meaning subtly different things.
 */
function renderKindOptions(): string {
  return COMMENT_KIND_CHOICES.map(
    (choice) => `      <option value="${escapeHtml(choice.kind)}">${escapeHtml(choice.label)}</option>`,
  ).join('\n');
}

const KIND_HINTS = Object.fromEntries(COMMENT_KIND_CHOICES.map((choice) => [choice.kind, choice.detail]));

const STYLES = `
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0 1rem 10rem; }
.session-header h1 { font-size: 1.1rem; margin-bottom: 0.2rem; }
.meta { display: flex; gap: 0.6rem; align-items: center; font-size: 0.85rem; opacity: 0.8; margin-top: 0; }
.meta .transcript { font-size: 0.75rem; padding: 0 0.4rem; }
.status { text-transform: uppercase; letter-spacing: 0.04em; }
.status-blocked { color: var(--vscode-editorWarning-foreground); }
.status-error { color: var(--vscode-editorError-foreground); }
.status-done { opacity: 0.6; }
.stale { color: var(--vscode-editorWarning-foreground); }
.question { border: 1px solid var(--vscode-editorWarning-foreground); border-radius: 4px; padding: 0.6rem 0.8rem; margin: 0.8rem 0; }
.question h2 { font-size: 0.9rem; margin: 0 0 0.3rem; }
.answers { display: flex; flex-wrap: wrap; gap: 0.4rem; }
.event { border-left: 2px solid var(--vscode-panel-border); padding: 0.4rem 0 0.8rem 0.8rem; margin-bottom: 0.6rem; }
.event-head { display: flex; gap: 0.6rem; align-items: baseline; font-size: 0.75rem; opacity: 0.7; }
.event h3 { font-size: 0.95rem; margin: 0.2rem 0; }
.summary { white-space: pre-wrap; word-break: break-word; font-family: var(--vscode-editor-font-family); font-size: 0.85rem; margin: 0.3rem 0; }
.artifacts { display: flex; flex-wrap: wrap; gap: 0.4rem; margin: 0.4rem 0; }
/* A link is not held by the session, so it does not get a solid edge like a copy. */
.artifact.link { border-style: dashed; }
.comment { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: baseline; font-size: 0.85rem; margin-top: 0.3rem; opacity: 0.9; }
.comment .kind { text-transform: uppercase; font-size: 0.7rem; opacity: 0.7; }
.comment time { opacity: 0.6; font-size: 0.75rem; }
.delivered, .pending { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.04em; }
.delivered { opacity: 0.55; }
.pending { color: var(--vscode-editorWarning-foreground); }
.empty { opacity: 0.7; }
.pulse { opacity: 0.8; }
.passive { border-left: 2px dashed var(--vscode-panel-border); padding: 0.3rem 0 0.5rem 0.8rem; margin-bottom: 0.5rem; }
.passive .source { text-transform: uppercase; letter-spacing: 0.04em; }
.comment-standalone { border-left: 2px solid var(--vscode-textLink-foreground); padding-left: 0.8rem; margin: 0.4rem 0; }
.composer { position: fixed; bottom: 0; left: 0; right: 0; background: var(--vscode-editor-background); border-top: 1px solid var(--vscode-panel-border); padding: 0.5rem 1rem; }
.composer label { font-size: 0.75rem; opacity: 0.7; }
.composer textarea { width: 100%; box-sizing: border-box; }
.composer-actions { display: flex; gap: 0.5rem; margin-top: 0.3rem; }
.composer-hint { font-size: 0.75rem; opacity: 0.7; margin: 0.3rem 0 0; }
.reply-banner { display: flex; gap: 0.5rem; align-items: baseline; font-size: 0.75rem; margin-bottom: 0.3rem; }
.reply-banner[hidden] { display: none; }
.danger { color: var(--vscode-editorWarning-foreground); }
button { cursor: pointer; }
`;

const SCRIPT = `
const vscode = acquireVsCodeApi();
const box = document.getElementById('comment');
const kind = document.getElementById('kind');
const sendButton = document.getElementById('send');
const timeline = document.getElementById('timeline');
const banner = document.getElementById('reply-banner');
const bannerText = document.getElementById('reply-target');
const hint = document.getElementById('kind-hint');
const HINTS = ${JSON.stringify(KIND_HINTS)};
const PLACEHOLDER = ${JSON.stringify(COMPOSER_PLACEHOLDER)};
const STOP_REASON = ${JSON.stringify(DEFAULT_STOP_REASON)};

let replyTo;
let pending;

// Land on the newest entry. The column is oldest-first, so a session with hundreds of
// reports otherwise opens on one from two days ago with the current work off-screen.
window.scrollTo(0, document.body.scrollHeight);
showHint();

// Patch only the rows that changed; never the composer. A half-typed comment, an open
// dropdown and a selection the human is about to copy all belong to them, and a report
// arriving mid-sentence must not take any of it.
window.addEventListener('message', (event) => {
  const update = event.data;
  if (!update) return;

  if (update.type === 'commentSettled') {
    settle(update.token, update.delivered === true);
    return;
  }
  if (update.type !== 'update') return;

  const atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 40;
  document.getElementById('session-title').textContent = update.title;
  document.getElementById('session-meta').innerHTML = update.meta;
  document.getElementById('question-slot').innerHTML = update.question;
  applyRows(update.order, update.changed);
  // Following the agent should keep following it; reading history should not jump.
  if (atBottom) window.scrollTo(0, document.body.scrollHeight);
});

function applyRows(order, changed) {
  const wanted = new Set(order);
  for (const node of [...timeline.children]) {
    if (!wanted.has(node.dataset.key)) node.remove();
  }

  const html = new Map(changed.map((row) => [row.key, row.html]));
  let previous = null;

  for (const key of order) {
    let node = timeline.querySelector('[data-key="' + cssEscape(key) + '"]');
    const markup = html.get(key);

    if (!node) {
      node = document.createElement('div');
      node.className = 'row';
      node.dataset.key = key;
      node.innerHTML = markup || '';
      insertAfter(node, previous);
    } else if (markup !== undefined) {
      // Untouched rows keep their DOM nodes, and with them the selection inside.
      node.innerHTML = markup;
    }
    previous = node;
  }
}

function insertAfter(node, previous) {
  if (previous && previous.nextSibling) timeline.insertBefore(node, previous.nextSibling);
  else if (previous) timeline.appendChild(node);
  else timeline.insertBefore(node, timeline.firstChild);
}

function cssEscape(value) {
  return value.replace(/["\\\\]/g, '\\\\$&');
}

// The box is emptied by the acknowledgement, never by the click. Clearing it up front
// meant that a comment which failed to reach the disk was gone from both places at
// once, and the human had no way to know: they watched it leave the box and assumed
// it had been sent.
function send(overrideKind, fallbackText) {
  const typed = box.value.trim();
  const text = typed === '' ? fallbackText : typed;
  if (!text || pending) return;

  pending = String(Date.now());
  sendButton.disabled = true;
  vscode.postMessage({ type: 'comment', text, kind: overrideKind || kind.value, replyTo, token: pending });
}

function settle(token, delivered) {
  // The answer buttons post a comment too, without a token. Nothing the human typed is
  // waiting on those, and emptying the box on their behalf would eat a half-written one.
  if (!pending || token !== pending) return;
  pending = undefined;
  sendButton.disabled = false;
  if (!delivered) return;

  box.value = '';
  clearReply();
}

function aimAt(label, seq) {
  replyTo = seq;
  banner.hidden = false;
  bannerText.textContent = label;
  box.focus();
}

function clearReply() {
  replyTo = undefined;
  banner.hidden = true;
  bannerText.textContent = '';
  box.placeholder = PLACEHOLDER;
}

function showHint() {
  hint.textContent = HINTS[kind.value] || '';
}

sendButton.addEventListener('click', () => send());
document.getElementById('stop').addEventListener('click', () => send('stop', STOP_REASON));
document.getElementById('cancel-reply').addEventListener('click', clearReply);
kind.addEventListener('change', showHint);

box.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) send();
});

document.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  if (target.classList.contains('artifact')) {
    if (target.dataset.link) {
      vscode.postMessage({ type: 'openLink', path: target.dataset.link, kind: target.dataset.kind });
    } else {
      vscode.postMessage({ type: 'openArtifact', ref: target.dataset.ref, kind: target.dataset.kind });
    }
  } else if (target.classList.contains('transcript')) {
    vscode.postMessage({ type: 'openTranscript', path: target.dataset.path });
  } else if (target.classList.contains('answer')) {
    vscode.postMessage({
      type: 'comment',
      text: target.dataset.answer,
      kind: 'answer',
      replyTo: Number(target.dataset.replyTo),
    });
  } else if (target.classList.contains('reply')) {
    aimAt('Replying to report #' + target.dataset.replyTo, Number(target.dataset.replyTo));
  } else if (target.classList.contains('reply-after')) {
    // Nothing to address: a transcript line has no seq. The comment is placed by time,
    // so it lands directly under the line the human was looking at.
    aimAt('Commenting after: ' + target.dataset.after, undefined);
  }
});
`;
