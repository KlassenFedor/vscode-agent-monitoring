import * as os from 'node:os';
import * as path from 'node:path';

import * as vscode from 'vscode';

import type { CommentKind } from '@agent-monitor/protocol';

import { COMMENT_KIND_CHOICES, DEFAULT_STOP_REASON, STOP_CHOICE } from './core/kinds.js';
import { WorkspaceModel, type SessionView } from './core/model.js';
import { planNotification, sessionChoices, sessionLabel } from './core/notify.js';
import { mergePassive } from './core/passive/merge.js';
import { PassiveTracker, type KnownTranscript, type PassiveSessionView } from './core/passive/tracker.js';
import { rotateSessions } from './core/rotate.js';
import { isSetUp, setupWorkspace } from './core/setup.js';
import { SessionWatcher } from './core/watcher.js';
import { SessionPanels } from './ui/panel.js';
import { SessionTreeProvider, type Node } from './ui/tree.js';

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
    vscode.commands.registerCommand('agentMonitor.openSession', (target?: string | Node) => {
      void openSession(model, panels, target);
    }),
    vscode.commands.registerCommand('agentMonitor.comment', (target?: Node) => {
      void promptForComment(model, sessionIdOf(target));
    }),
    vscode.commands.registerCommand('agentMonitor.stopSession', (target?: Node) => {
      void stopSession(model, sessionIdOf(target));
    }),
    vscode.commands.registerCommand('agentMonitor.openTranscript', (target?: string | Node) => {
      void openTranscript(target);
    }),
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

/** What the tree clicked on, when a command was fired from a context menu. */
function sessionIdOf(target?: Node): string | undefined {
  if (target && typeof target === 'object' && target.kind === 'session') return target.session.id;
  return undefined;
}

/**
 * Choose a session to act on.
 *
 * Never by label: titles come from a language model and two of them can match. The
 * pick returns an id, and a single running session skips the question entirely.
 */
async function pickSession(model: WorkspaceModel, title: string): Promise<string | undefined> {
  const sessions = model.snapshot().sessions.filter((session) => session.status !== 'done');
  if (sessions.length === 0) {
    void vscode.window.showInformationMessage('Agent Monitor: no running sessions in this workspace.');
    return undefined;
  }
  if (sessions.length === 1) return sessions[0]?.id;

  const picked = await vscode.window.showQuickPick(
    sessionChoices(sessions).map((choice) => ({ ...choice, detail: '' })),
    { title, ignoreFocusOut: true },
  );
  return picked?.id;
}

async function openSession(
  model: WorkspaceModel,
  panels: SessionPanels,
  target?: string | Node,
): Promise<void> {
  // Two agents in one workspace is a supported case (E2E-07), and this command is also
  // what the status bar fires: opening whichever session came first, without saying so,
  // is a coin toss the human never sees.
  const direct = typeof target === 'string' ? target : sessionIdOf(target);
  const id = direct ?? (await pickSession(model, 'Open which session?'));
  if (id) panels.show(id);
}

/**
 * Open the agent's own transcript.
 *
 * This is what a passive row does when clicked. It has no session directory behind it,
 * so there is nothing to open and nowhere to comment — and a row that answers nothing
 * at all is worse than one that answers the only question it can.
 */
async function openTranscript(target?: string | Node): Promise<void> {
  const file =
    typeof target === 'string'
      ? target
      : target?.kind === 'passive'
        ? target.passive.transcriptPath
        : target?.kind === 'session'
          ? target.session.meta?.transcript_path
          : undefined;

  if (!file) {
    void vscode.window.showInformationMessage('Agent Monitor: no transcript is known for this session yet.');
    return;
  }
  await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file));
}

/**
 * Stop the agent and say why.
 *
 * Offered as an action rather than a kind of comment, and honest about what it costs:
 * a blocked agent ends its turn waiting on its own terminal, and no button here can
 * tell it to carry on (docs-local/live/FINDINGS.md §1).
 */
async function stopSession(model: WorkspaceModel, sessionId?: string): Promise<void> {
  const id = sessionId ?? (await pickSession(model, 'Stop which session?'));
  if (!id) return;

  const confirmed = await vscode.window.showWarningMessage(
    STOP_CHOICE.detail,
    { modal: true },
    STOP_CHOICE.label,
  );
  if (confirmed !== STOP_CHOICE.label) return;

  const reason = await vscode.window.showInputBox({
    title: 'Why should it stop?',
    value: DEFAULT_STOP_REASON,
    ignoreFocusOut: true,
  });
  if (reason === undefined) return;

  await post(model, id, { text: reason.trim() === '' ? DEFAULT_STOP_REASON : reason, kind: 'stop' });
}

async function promptForComment(model: WorkspaceModel, sessionId?: string): Promise<void> {
  const id = sessionId ?? (await pickSession(model, 'Comment on which session?'));
  if (!id) return;

  // `value`, not `kind`: `QuickPickItem.kind` is VS Code's own separator enum, and
  // reusing the name makes the item stop being a QuickPickItem at all.
  const picked = await vscode.window.showQuickPick(
    COMMENT_KIND_CHOICES.map((choice) => ({
      label: choice.label,
      detail: choice.detail,
      value: choice.kind,
    })),
    // Anything that takes the focus — a panel refreshing, a notification — would
    // otherwise dismiss the pick before the human has read the options.
    { title: 'How should the agent treat this?', ignoreFocusOut: true },
  );
  if (!picked) return;

  const text = await vscode.window.showInputBox({
    title: picked.label,
    placeHolder: 'e.g. do not touch legacy/',
    ignoreFocusOut: true,
  });
  if (!text) return;

  await post(model, id, { text, kind: picked.value });
}

/** Writing a comment can fail, and a comment lost in silence is the worst outcome. */
async function post(
  model: WorkspaceModel,
  sessionId: string,
  input: { text: string; kind: CommentKind },
): Promise<void> {
  try {
    await model.postComment(sessionId, input);
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Agent Monitor could not save your comment: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Wire the workspace up, after saying which files that means.
 *
 * One of them is `~/.codex/config.toml`: outside the workspace, shared by every project
 * on the machine, and holding the human's own model and approval settings. Finding out
 * afterwards from "updated 3 file(s)" is not consent. The preview runs the same code
 * with the writes turned off, so it cannot drift from what actually happens.
 */
async function runSetup(context: vscode.ExtensionContext, root: string): Promise<void> {
  const dist = path.join(context.extensionPath, 'dist');
  const paths = {
    root,
    node: process.execPath,
    mcpServer: path.join(dist, 'mcp-server.cjs'),
    hook: path.join(dist, 'hook.cjs'),
    codexConfig: path.join(os.homedir(), '.codex', 'config.toml'),
  };

  const plan = await setupWorkspace(paths, { dryRun: true });
  if (plan.changed.length === 0 && plan.notes.length === 0) {
    void vscode.window.showInformationMessage('Agent Monitor: already set up, nothing to change.');
    return;
  }

  const outside = plan.changed.filter((file) => !file.startsWith(root + path.sep));
  const apply = 'Apply';
  const confirmed = await vscode.window.showInformationMessage(
    'Agent Monitor will change these files:',
    {
      modal: true,
      detail: [
        plan.changed.map((file) => `• ${file}`).join('\n'),
        outside.length === 0
          ? ''
          : '\nThe Codex config lives outside this workspace and is shared by all your projects. A backup is written next to it.',
      ]
        .filter(Boolean)
        .join('\n'),
    },
    apply,
  );
  if (confirmed !== apply) return;

  const report = await setupWorkspace(paths);

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
