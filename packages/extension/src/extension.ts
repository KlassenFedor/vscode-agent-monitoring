import * as os from 'node:os';
import * as path from 'node:path';

import * as vscode from 'vscode';

import type { CommentKind } from '@agent-monitor/protocol';

import { WorkspaceModel, type SessionView } from './core/model.js';
import { planNotification, sessionLabel } from './core/notify.js';
import { mergePassive } from './core/passive/merge.js';
import { PassiveTracker, type KnownTranscript, type PassiveSessionView } from './core/passive/tracker.js';
import { rotateSessions } from './core/rotate.js';
import { isSetUp, setupWorkspace } from './core/setup.js';
import { SessionWatcher } from './core/watcher.js';
import { SessionPanels } from './ui/panel.js';
import { SessionTreeProvider } from './ui/tree.js';

export function activate(context: vscode.ExtensionContext): void {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;

  const root = folder.uri.fsPath;
  const config = vscode.workspace.getConfiguration('agentMonitor');

  const model = new WorkspaceModel(root, {
    staleAfterMs: config.get<number>('staleAfterMs') ?? 600_000,
  });
  let passive: PassiveSessionView[] = [];
  let pulses: ReadonlyMap<string, PassiveSessionView> = new Map();
  const tracker = new PassiveTracker(root, {
    homeDir: os.homedir(),
    staleAfterMs: config.get<number>('staleAfterMs') ?? 600_000,
    onDisabled: (reason) => void vscode.window.showWarningMessage(reason),
  });

  const tree = new SessionTreeProvider(
    model,
    () => passive,
    () => pulses,
  );
  const panels = new SessionPanels(model, () => pulses);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'agentMonitor.openSession';

  let previous = new Map<string, SessionView>();

  const refresh = async (): Promise<void> => {
    const snapshot = await model.refresh();
    // Cheap when nothing has ever been written; switches itself off if the agents'
    // transcript format moves out from under it.
    const merged = mergePassive(
      snapshot.sessions,
      await tracker.refresh(knownTranscripts(snapshot.sessions)),
    );
    passive = merged.visible;
    pulses = merged.attached;

    // Read per refresh, not once at activate: a setting that needs a window reload to
    // take effect is the same bug in a smaller form, and this lookup is in-memory.
    const onQuestion = vscode.workspace.getConfiguration('agentMonitor').get<boolean>('notifyOnQuestion');

    for (const session of snapshot.sessions) {
      notify(planNotification(session, previous.get(session.id), { onQuestion }), panels, model);
    }
    previous = new Map(snapshot.sessions.map((session) => [session.id, session]));

    // Chooses between the two welcome messages in an empty panel (`viewsWelcome` in
    // package.json); until it is set, the panel offers Setup, which is the right guess.
    await vscode.commands.executeCommand('setContext', 'agentMonitor.configured', await isSetUp(root));

    tree.refresh();
    panels.renderAll();
    updateStatus(status, snapshot.sessions);
  };

  const watcher = new SessionWatcher(root, () => void refresh(), {
    pollIntervalMs: config.get<number>('pollIntervalMs') ?? 1_000,
  });

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('agentMonitor.sessions', tree),
    status,
    { dispose: () => watcher.stop() },
    { dispose: () => panels.dispose() },
    vscode.commands.registerCommand('agentMonitor.refresh', () => void refresh()),
    vscode.commands.registerCommand('agentMonitor.openSession', (sessionId?: string) => {
      const id = sessionId ?? model.snapshot().sessions[0]?.id;
      if (id) panels.show(id);
    }),
    vscode.commands.registerCommand('agentMonitor.comment', () => void promptForComment(model)),
    vscode.commands.registerCommand('agentMonitor.setupWorkspace', () => void runSetup(context, root)),
  );

  void watcher.start();
  void refresh();

  // Once per window, not per refresh: old sessions do not age fast enough to be worth
  // checking again, and a delete racing the watcher would only make noise.
  void rotateSessions(root, { keepMs: (config.get<number>('keepSessionsForDays') ?? 14) * 24 * 60 * 60_000 });
}

export function deactivate(): void {
  // Everything is disposed through context.subscriptions.
}

/** Transcripts the hook recorded for us, so the passive layer need not guess at paths. */
function knownTranscripts(sessions: readonly SessionView[]): KnownTranscript[] {
  return sessions.flatMap((session) =>
    session.meta?.transcript_path ? [{ path: session.meta.transcript_path, agent: session.meta.agent }] : [],
  );
}

function updateStatus(status: vscode.StatusBarItem, sessions: readonly SessionView[]): void {
  const live = sessions.filter((session) => session.status !== 'done');
  if (live.length === 0) {
    status.hide();
    return;
  }

  const waiting = live.filter((session) => session.waitingQuestion).length;
  const unread = live.reduce((total, session) => total + session.unread.length, 0);

  const parts = [`${live.length} agent${live.length === 1 ? '' : 's'}`];
  if (waiting > 0) parts.push(`${waiting} waiting`);
  if (unread > 0) parts.push(`${unread} undelivered`);

  status.text = `$(pulse) ${parts.join(' · ')}`;
  status.tooltip = live.map((session) => `${sessionLabel(session)} — ${session.status}`).join('\n');
  status.show();
}

function notify(
  plan: ReturnType<typeof planNotification>,
  panels: SessionPanels,
  model: WorkspaceModel,
): void {
  if (plan.level === 'none') return;

  const open = 'Open session';
  const actions = [...plan.actions, open];
  const show = plan.level === 'error' ? vscode.window.showErrorMessage : vscode.window.showInformationMessage;

  void show(plan.message, ...actions).then(async (choice) => {
    if (choice === undefined) return;
    if (choice !== open && plan.actions.includes(choice)) {
      // Answering straight from the notification is the whole point of offering the
      // agent's options here: the agent is blocked until one of them arrives.
      await model.postComment(plan.sessionId, {
        text: choice,
        kind: 'answer',
        ...(plan.event ? { replyTo: plan.event.seq } : {}),
      });
      return;
    }
    panels.show(plan.sessionId);
  });
}

async function promptForComment(model: WorkspaceModel): Promise<void> {
  const sessions = model.snapshot().sessions.filter((session) => session.status !== 'done');
  if (sessions.length === 0) {
    void vscode.window.showInformationMessage('Agent Monitor: no running sessions in this workspace.');
    return;
  }

  let target = sessions[0];
  if (sessions.length > 1) {
    const picked = await vscode.window.showQuickPick(sessions.map(sessionLabel), {
      title: 'Comment on which session?',
      ignoreFocusOut: true,
    });
    if (!picked) return;
    target = sessions.find((session) => sessionLabel(session) === picked);
  }
  if (!target) return;

  const kind = await vscode.window.showQuickPick(
    [
      { label: 'steer', detail: 'Change the plan. The agent must apply it from its next step.' },
      { label: 'fyi', detail: 'Context only.' },
      { label: 'stop', detail: 'Stop and wait for me.' },
    ],
    // Anything that takes the focus — a panel refreshing, a notification — would
    // otherwise dismiss the pick before the human has read the three options.
    { title: 'Kind of comment', ignoreFocusOut: true },
  );
  if (!kind) return;

  const text = await vscode.window.showInputBox({
    title: 'Comment',
    placeHolder: 'e.g. do not touch legacy/',
    ignoreFocusOut: true,
  });
  if (!text) return;

  await model.postComment(target.id, { text, kind: kind.label as CommentKind });
}

async function runSetup(context: vscode.ExtensionContext, root: string): Promise<void> {
  const dist = path.join(context.extensionPath, 'dist');
  const report = await setupWorkspace({
    root,
    node: process.execPath,
    mcpServer: path.join(dist, 'mcp-server.cjs'),
    hook: path.join(dist, 'hook.cjs'),
    codexConfig: path.join(os.homedir(), '.codex', 'config.toml'),
  });

  const summary =
    report.changed.length === 0
      ? 'Agent Monitor: already set up, nothing to change.'
      : `Agent Monitor: updated ${report.changed.length} file(s).`;

  if (report.notes.length > 0) {
    void vscode.window.showWarningMessage(`${summary} ${report.notes.join(' ')}`);
  } else {
    void vscode.window.showInformationMessage(summary);
  }
}
