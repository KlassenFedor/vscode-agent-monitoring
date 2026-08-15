import * as vscode from 'vscode';

import type { AgentEvent } from '@agent-monitor/protocol';

import type { SessionView, WorkspaceModel } from '../core/model.js';
import { sessionLabel } from '../core/notify.js';
import type { PassiveSessionView } from '../core/passive/tracker.js';

type Node =
  | { kind: 'session'; session: SessionView }
  | { kind: 'event'; session: SessionView; event: AgentEvent }
  | { kind: 'passive'; passive: PassiveSessionView };

const RECENT_EVENTS = 20;

export class SessionTreeProvider implements vscode.TreeDataProvider<Node> {
  readonly #changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.#changed.event;

  constructor(
    private readonly model: WorkspaceModel,
    /** Sessions seen only through the agents' own transcripts, if any. */
    private readonly passiveSessions: () => readonly PassiveSessionView[] = () => [],
    /** Transcript pulse for registered sessions that publish nothing, by session id. */
    private readonly pulses: () => ReadonlyMap<string, PassiveSessionView> = () => new Map(),
  ) {}

  refresh(): void {
    this.#changed.fire(undefined);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'session') return sessionItem(node.session, this.pulses().get(node.session.id));
    if (node.kind === 'passive') return passiveItem(node.passive);

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

  getChildren(node?: Node): Node[] {
    if (!node) {
      return [
        ...this.model.snapshot().sessions.map((session) => ({ kind: 'session', session }) as const),
        ...this.passiveSessions().map((passive) => ({ kind: 'passive', passive }) as const),
      ];
    }
    if (node.kind !== 'session') return [];

    return node.session.events
      .slice(-RECENT_EVENTS)
      .reverse()
      .map((event) => ({ kind: 'event', session: node.session, event }));
  }
}

/**
 * @param pulse What the agent's transcript says it is doing, when it publishes nothing
 *   itself. A session registered by the MCP server or the hook exists from the first
 *   second but may stay empty for a long while; without the pulse it would show a
 *   status, no name, and turn stale while the agent was working normally.
 */
function sessionItem(session: SessionView, pulse?: PassiveSessionView): vscode.TreeItem {
  const item = new vscode.TreeItem(
    labelFor(session, pulse),
    session.events.length === 0
      ? vscode.TreeItemCollapsibleState.None
      : vscode.TreeItemCollapsibleState.Collapsed,
  );

  const stale = pulse ? pulse.stale : session.stale;
  const bits: string[] = [session.status];
  if (session.unread.length > 0) bits.push(`${session.unread.length} unread`);
  if (session.events.length === 0 && pulse?.currentTool) bits.push(pulse.currentTool);
  if (stale) bits.push('stale');

  item.description = bits.join(' · ');
  item.iconPath = new vscode.ThemeIcon(iconForSession(session, stale));
  item.contextValue = 'agentMonitor.session';
  item.command = {
    command: 'agentMonitor.openSession',
    title: 'Open session',
    arguments: [session.id],
  };
  return item;
}

/**
 * A session we only know about from its transcript.
 *
 * Shown without a command: there is no session directory to open, no timeline to
 * read and nowhere to put a comment. It exists to answer "is it alive".
 */
function passiveItem(passive: PassiveSessionView): vscode.TreeItem {
  const item = new vscode.TreeItem(
    passive.lastMessage ?? `${passive.agent} session`,
    vscode.TreeItemCollapsibleState.None,
  );

  const bits = ['not reporting'];
  if (passive.currentTool) bits.push(passive.currentTool);
  if (passive.stale) bits.push('stale');

  item.description = bits.join(' · ');
  item.tooltip = [
    `${passive.agent} session seen only through its transcript.`,
    'Run "Agent Monitor: Set Up Workspace" to get reports and comments.',
    passive.changedFiles.length === 0 ? '' : `Changed: ${passive.changedFiles.slice(-5).join(', ')}`,
  ]
    .filter(Boolean)
    .join('\n');
  item.iconPath = new vscode.ThemeIcon(passive.stale ? 'warning' : 'circle-outline');
  item.contextValue = 'agentMonitor.passiveSession';
  return item;
}

/**
 * A session nobody has named is listed as "codex session codex-20" — true and useless.
 * Until a report or `set_status` supplies a title, the last thing the agent said is a
 * better name than its id.
 */
function labelFor(session: SessionView, pulse?: PassiveSessionView): string {
  const title = session.meta?.title;
  if (typeof title === 'string' && title.trim() !== '') return title;
  return pulse?.lastMessage ?? sessionLabel(session);
}

function iconForSession(session: SessionView, stale: boolean): string {
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
