import * as vscode from 'vscode';

import type { AgentEvent } from '@agent-monitor/protocol';

import { decorateLabel, formatStamp, type SessionLabelExtra } from '../core/label.js';
import type { SessionView, WorkspaceModel } from '../core/model.js';
import { sessionLabel } from '../core/notify.js';
import type { PassiveSessionView } from '../core/passive/tracker.js';
import { formatTime } from '../core/render.js';
import { planTreeRefresh } from '../core/tree-diff.js';

/**
 * Exported so the commands a context menu fires can read what was clicked.
 *
 * `key` is the row's identity, and it is on the node rather than derived on the spot
 * because two things depend on it being the same string every refresh: the instance
 * cache below, and `TreeItem.id`, which is what lets VS Code keep a row's expansion
 * state and its open hover across a redraw.
 */
export type Node =
  | { key: string; kind: 'session'; session: SessionView }
  | { key: string; kind: 'event'; session: SessionView; event: AgentEvent }
  | { key: string; kind: 'passive'; passive: PassiveSessionView }
  | { key: string; kind: 'archive'; sessions: readonly SessionView[] };

const RECENT_EVENTS = 20;

export class SessionTreeProvider implements vscode.TreeDataProvider<Node> {
  readonly #changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.#changed.event;

  /**
   * One object per row, reused for as long as the row exists.
   *
   * `onDidChangeTreeData` names an element by identity, so a provider that mints a
   * fresh object per call can only ever say "everything changed" — which is what it
   * used to do, once a second, whether or not anything had. Redrawing a row destroys
   * its hover: the tooltip on a session name flashed and vanished, and the one on an
   * inline button flickered as the button was rebuilt underneath the pointer.
   */
  readonly #nodes = new Map<string, Node>();
  /** What each root row last looked like, so an unchanged one is left alone. */
  #signatures = new Map<string, string>();

  constructor(
    private readonly model: WorkspaceModel,
    /** Sessions seen only through the agents' own transcripts, if any. */
    private readonly passiveSessions: () => readonly PassiveSessionView[] = () => [],
    /** Transcript pulse for registered sessions that publish nothing, by session id. */
    private readonly pulses: () => ReadonlyMap<string, PassiveSessionView> = () => new Map(),
    /** `agentMonitor.sessionLabelExtras`, read per refresh so it applies immediately. */
    private readonly labelExtras: () => readonly SessionLabelExtra[] = () => [],
    /** Sessions that hold nothing and never will (`residualSessions`). */
    private readonly residual: () => ReadonlySet<string> = () => new Set(),
  ) {}

  /**
   * Redraw whatever actually changed.
   *
   * The list is rebuilt on every watcher tick — roughly once a second — and almost
   * every tick finds the same rows saying the same thing. Firing the event regardless
   * made the sidebar unusable to point at; comparing first costs one string per row.
   */
  refresh(): void {
    const roots = this.#buildRoots();
    const previous = this.#signatures;
    const next = new Map(roots.map((node) => [node.key, this.#signature(node)] as const));
    this.#signatures = next;

    const plan = planTreeRefresh(previous, next);
    if (plan.all) {
      this.#changed.fire(undefined);
      return;
    }

    for (const key of plan.keys) {
      const node = this.#nodes.get(key);
      // A key with no instance behind it should not happen; if it ever does, the whole
      // tree is the one answer that is still correct.
      if (!node) {
        this.#changed.fire(undefined);
        return;
      }
      this.#changed.fire(node);
    }
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const item = this.#buildItem(node);
    item.id = node.key;
    return item;
  }

  getChildren(node?: Node): Node[] {
    if (!node) return this.#buildRoots();

    if (node.kind === 'archive') {
      return node.sessions.map((session) =>
        this.#node({ key: sessionKey(session), kind: 'session', session }),
      );
    }
    if (node.kind !== 'session') return [];

    return node.session.events
      .slice(-RECENT_EVENTS)
      .reverse()
      .map((event) => ({
        key: `event:${node.session.id}:${event.seq}`,
        kind: 'event' as const,
        session: node.session,
        event,
      }));
  }

  /**
   * The rows at the top level, as the same objects as last time wherever the row is
   * the same row. Instances for rows that are gone are dropped, so a long-lived
   * window does not accumulate one per session it has ever seen.
   */
  #buildRoots(): Node[] {
    const all = this.model.snapshot().sessions;
    const archived = all.filter((session) => session.archived);
    const residual = this.residual();

    const roots: Node[] = [
      ...all
        .filter((session) => !session.archived && !residual.has(session.id))
        .map((session) => this.#node({ key: sessionKey(session), kind: 'session', session })),
      ...this.passiveSessions().map((passive) =>
        this.#node({ key: `passive:${passive.transcriptPath}`, kind: 'passive', passive }),
      ),
      // One row instead of a run of them, and only once there is something in it: an
      // empty folder is a permanent reminder of a decision already made.
      ...(archived.length === 0 ? [] : [this.#node({ key: 'archive', kind: 'archive', sessions: archived })]),
    ];

    const live = new Set([
      ...roots.map((node) => node.key),
      ...archived.map((session) => sessionKey(session)),
    ]);
    for (const key of [...this.#nodes.keys()]) {
      if (!live.has(key)) this.#nodes.delete(key);
    }
    return roots;
  }

  /** The cached instance for this row, refreshed in place, or a new one. */
  #node<T extends Node>(node: T): T {
    const existing = this.#nodes.get(node.key);
    if (existing && existing.kind === node.kind) {
      Object.assign(existing, node);
      return existing as T;
    }
    this.#nodes.set(node.key, node);
    return node;
  }

  /**
   * Everything about a row that is visible, as one comparable string.
   *
   * Taken from the finished `TreeItem` rather than from the session behind it, so a
   * field that stops being shown stops forcing redraws by itself. A collapsed
   * session's children count too: expanding it must not show a stale list.
   */
  #signature(node: Node): string {
    const item = this.#buildItem(node);
    const icon = item.iconPath instanceof vscode.ThemeIcon ? item.iconPath.id : '';

    const children =
      node.kind === 'session'
        ? node.session.events
            .slice(-RECENT_EVENTS)
            .map((event) => `${event.seq}:${event.type}:${event.title}`)
            .join('')
        : node.kind === 'archive'
          ? node.sessions
              .map((session) => this.#signature({ key: sessionKey(session), kind: 'session', session }))
              .join('')
          : '';

    return JSON.stringify([
      item.label,
      item.description,
      item.tooltip,
      icon,
      item.contextValue,
      item.collapsibleState,
      children,
    ]);
  }

  #buildItem(node: Node): vscode.TreeItem {
    const extras = this.labelExtras();

    if (node.kind === 'session') return sessionItem(node.session, this.pulses().get(node.session.id), extras);
    if (node.kind === 'passive') return passiveItem(node.passive, extras);
    if (node.kind === 'archive') return archiveItem(node.sessions);

    const item = new vscode.TreeItem(node.event.title, vscode.TreeItemCollapsibleState.None);
    item.description = `#${node.event.seq}`;
    item.iconPath = new vscode.ThemeIcon(iconForEvent(node.event));
    item.command = {
      command: 'agentMonitor.openSession',
      title: 'Open session',
      arguments: [node.session.id],
    };
    return item;
  }
}

function sessionKey(session: SessionView): string {
  return `session:${session.id}`;
}

/**
 * @param pulse What the agent's transcript says it is doing, when it publishes nothing
 *   itself. A session registered by the MCP server or the hook exists from the first
 *   second but may stay empty for a long while; without the pulse it would show a
 *   status, no name, and turn stale while the agent was working normally.
 */
function sessionItem(
  session: SessionView,
  pulse: PassiveSessionView | undefined,
  extras: readonly SessionLabelExtra[],
): vscode.TreeItem {
  const stale = pulse ? pulse.stale : session.stale;
  const lastAt = pulse?.lastActivityAt ?? session.lastActivityAt;

  const item = new vscode.TreeItem(
    labelFor(session, pulse, lastAt, extras),
    session.events.length === 0
      ? vscode.TreeItemCollapsibleState.None
      : vscode.TreeItemCollapsibleState.Collapsed,
  );

  const bits: string[] = [session.status];
  if (session.unread.length > 0) bits.push(`${session.unread.length} unread`);
  if (session.events.length === 0 && pulse?.currentTool) bits.push(pulse.currentTool);
  // Not for an archived one: "stale" is a warning that the agent may be stuck, and
  // nobody is waiting on a session that has been put away.
  if (stale && !session.archived) bits.push('stale');
  // Promised by DESIGN.md §6 and missing: "is it alive" is a question about a clock.
  if (lastAt !== null) bits.push(formatTime(lastAt));

  item.description = bits.join(' · ');
  item.iconPath = new vscode.ThemeIcon(iconForSession(session, stale));
  item.tooltip = sessionTooltip(session, pulse, lastAt);
  // Two values, because the buttons on the row differ: an archived session is put back,
  // not filed away again (`view/item/context` in package.json).
  item.contextValue = session.archived ? 'agentMonitor.archivedSession' : 'agentMonitor.session';
  item.command = {
    command: 'agentMonitor.openSession',
    title: 'Open session',
    arguments: [session.id],
  };
  return item;
}

function sessionTooltip(
  session: SessionView,
  pulse: PassiveSessionView | undefined,
  lastAt: string | null,
): string {
  return [
    sessionLabel(session),
    `${session.meta?.agent ?? 'agent'} · ${session.status}`,
    // Named in words here because the label shows the same two stamps bare, and which
    // of them is which is not something a reader should have to work out from order.
    session.meta?.started_at ? `Started ${formatStamp(session.meta.started_at, Date.now())}` : '',
    lastAt === null ? '' : `Last activity ${formatStamp(lastAt, Date.now())}`,
    session.events.length > 0 ? `${session.events.length} report(s)` : 'No reports published yet',
    session.unread.length > 0 ? `${session.unread.length} comment(s) not delivered yet` : '',
    pulse?.currentTool ? `Running ${pulse.currentTool}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * The one row that stands for every session the human has put away.
 *
 * A folder rather than a filter switch: the sessions are still there, still readable,
 * and still one click from coming back. Hiding them behind a setting would make
 * "archive" mean "disappear", which is what the delete button is for.
 */
function archiveItem(sessions: readonly SessionView[]): vscode.TreeItem {
  const item = new vscode.TreeItem('Archived', vscode.TreeItemCollapsibleState.Collapsed);
  item.description = `${sessions.length}`;
  item.iconPath = new vscode.ThemeIcon('archive');
  item.tooltip = 'Sessions you have filed away. They are still on disk and can be restored.';
  item.contextValue = 'agentMonitor.archive';
  return item;
}

/**
 * A session we only know about from its transcript.
 *
 * There is no session directory behind it: nothing to open, nowhere to put a comment,
 * and so nothing to archive or delete either — the only file involved belongs to the
 * agent and is not ours to touch. What the row does offer is Dismiss, which takes it
 * out of the list and remembers that (`agentMonitor.dismissSession`).
 *
 * Clicking opens the transcript itself, because a row that answers nothing at all is
 * a dead end, and the transcript is the one thing that does exist.
 */
function passiveItem(passive: PassiveSessionView, extras: readonly SessionLabelExtra[]): vscode.TreeItem {
  const item = new vscode.TreeItem(
    decorateLabel(
      passive.lastMessage ?? `${passive.agent} session`,
      { agent: passive.agent, updatedAt: passive.lastActivityAt },
      extras,
      Date.now(),
    ),
    vscode.TreeItemCollapsibleState.None,
  );

  const bits = ['not reporting'];
  if (passive.currentTool) bits.push(passive.currentTool);
  if (passive.stale) bits.push('stale');

  item.description = bits.join(' · ');
  item.tooltip = [
    `${passive.agent} session seen only through its transcript.`,
    'Run "Agent Monitor: Set Up Workspace" to get reports and comments.',
    'It has no session directory here, so there is nothing to archive or delete — use Dismiss to take the row out of the list.',
    passive.lastActivityAt === null ? '' : `Last activity ${formatStamp(passive.lastActivityAt, Date.now())}`,
    passive.changedFiles.length === 0 ? '' : `Changed: ${passive.changedFiles.slice(-5).join(', ')}`,
  ]
    .filter(Boolean)
    .join('\n');
  item.iconPath = new vscode.ThemeIcon(passive.stale ? 'warning' : 'circle-outline');
  item.contextValue = 'agentMonitor.passiveSession';
  item.command = {
    command: 'agentMonitor.openTranscript',
    title: 'Open transcript',
    arguments: [passive.transcriptPath],
  };
  return item;
}

/**
 * A session nobody has named is listed as "codex session codex-20" — true and useless.
 * Until a report or `set_status` supplies a title, the last thing the agent said is a
 * better name than its id.
 */
function labelFor(
  session: SessionView,
  pulse: PassiveSessionView | undefined,
  lastAt: string | null,
  extras: readonly SessionLabelExtra[],
): string {
  const title = session.meta?.title;
  const base =
    typeof title === 'string' && title.trim() !== '' ? title : (pulse?.lastMessage ?? sessionLabel(session));

  return decorateLabel(
    base,
    { agent: session.meta?.agent, createdAt: session.meta?.started_at, updatedAt: lastAt },
    extras,
    Date.now(),
  );
}

function iconForSession(session: SessionView, stale: boolean): string {
  if (session.archived) return 'archive';
  if (session.waitingQuestion) return 'question';
  if (session.status === 'done') return 'pass';
  if (session.status === 'error') return 'error';
  if (stale) return 'warning';
  return 'pulse';
}

function iconForEvent(event: AgentEvent): string {
  switch (event.type) {
    case 'question':
      return 'question';
    case 'error':
      return 'error';
    case 'artifact':
      return 'file';
    case 'status':
      return 'info';
    default:
      return 'circle-filled';
  }
}
