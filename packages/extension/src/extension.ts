import { execFile } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import * as vscode from 'vscode';

import type { CommentKind } from '@agent-monitor/protocol';

import { COMMENT_KIND_CHOICES, DEFAULT_STOP_REASON, STOP_CHOICE } from './core/kinds.js';
import { parseLabelExtras } from './core/label.js';
import { currentSessionIds, sessionFootprint, type SessionFootprint } from './core/manage.js';
import { WorkspaceModel, type SessionView } from './core/model.js';
import { resolveNodePath } from './core/node-path.js';
import { planNotification, sessionChoices, sessionLabel } from './core/notify.js';
import { mergePassive } from './core/passive/merge.js';
import { PassiveTracker, type KnownTranscript, type PassiveSessionView } from './core/passive/tracker.js';
import { residualSessions } from './core/residual.js';
import { rotateSessions } from './core/rotate.js';
import { findBrokenSetup, isSetUp, setupWorkspace, type SetupPaths } from './core/setup.js';
import { SessionWatcher } from './core/watcher.js';
import { SessionPanels } from './ui/panel.js';
import { SessionTreeProvider, type Node } from './ui/tree.js';

const run = promisify(execFile);

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
  let residual: ReadonlySet<string> = new Set();
  const tracker = new PassiveTracker(root, {
    homeDir: os.homedir(),
    staleAfterMs: config.get<number>('staleAfterMs') ?? 600_000,
    onDisabled: (reason) => void vscode.window.showWarningMessage(reason),
  });

  const dismissed = new DismissedSessions(context);

  const tree = new SessionTreeProvider(
    model,
    () => passive,
    () => pulses,
    () => parseLabelExtras(vscode.workspace.getConfiguration('agentMonitor').get('sessionLabelExtras')),
    () => residual,
  );
  const panels = new SessionPanels(model, () => pulses);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'agentMonitor.openSession';

  let previous = new Map<string, SessionView>();
  const contexts = new Map<string, boolean>();

  const refresh = async (): Promise<void> => {
    const snapshot = await model.refresh();
    // Cheap when nothing has ever been written; switches itself off if the agents'
    // transcript format moves out from under it.
    const merged = mergePassive(
      snapshot.sessions,
      await tracker.refresh(knownTranscripts(snapshot.sessions)),
    );
    // A row the human has dismissed stays dismissed: there is nothing on disk to act
    // on, so the only thing we can honour about it is that they said they were done.
    passive = merged.visible.filter((view) => !dismissed.has(view.transcriptPath));
    pulses = merged.attached;
    // Two small files, read on the tick that uses them: a session an agent's pointer
    // names must never be mistaken for the residue a slash command left behind.
    residual = residualSessions(snapshot.sessions, {
      current: await currentSessionIds(root),
      pulses,
    });

    // Read per refresh, not once at activate: a setting that needs a window reload to
    // take effect is the same bug in a smaller form, and this lookup is in-memory.
    const onQuestion = vscode.workspace.getConfiguration('agentMonitor').get<boolean>('notifyOnQuestion');

    for (const session of snapshot.sessions) {
      // An archived session is the human saying they are done being interrupted by it.
      if (session.archived) continue;
      notify(planNotification(session, previous.get(session.id), { onQuestion }), panels, model);
    }
    previous = new Map(snapshot.sessions.map((session) => [session.id, session]));

    // Chooses between the two welcome messages in an empty panel (`viewsWelcome` in
    // package.json); until it is set, the panel offers Setup, which is the right guess.
    //
    // Only on change. Setting a context key re-evaluates every `when` clause in the
    // window, which rebuilds the inline buttons on every row — once a second that is
    // a row nobody can keep the pointer on.
    await setContextIfChanged(contexts, 'agentMonitor.configured', await isSetUp(root));
    await setContextIfChanged(contexts, 'agentMonitor.hasDismissed', dismissed.size > 0);

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
    vscode.commands.registerCommand('agentMonitor.archiveSession', (target?: Node) => {
      void setArchived(model, tree, sessionIdOf(target), true);
    }),
    vscode.commands.registerCommand('agentMonitor.unarchiveSession', (target?: Node) => {
      void setArchived(model, tree, sessionIdOf(target), false);
    }),
    vscode.commands.registerCommand('agentMonitor.deleteSession', (target?: Node) => {
      void deleteSession(model, tree, panels, sessionIdOf(target));
    }),
    vscode.commands.registerCommand('agentMonitor.dismissSession', (target?: Node) => {
      void dismissSession(dismissed, target, refresh);
    }),
    vscode.commands.registerCommand('agentMonitor.showDismissedSessions', () => {
      void restoreDismissed(dismissed, refresh);
    }),
  );

  void watcher.start();
  void refresh();
  void offerRepair(context, root);

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
  const live = sessions.filter((session) => session.status !== 'done' && !session.archived);
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

/**
 * Rows the human has taken out of the list, remembered across restarts.
 *
 * Only transcript-only sessions land here. They have no session directory, so there
 * is nothing to archive and nothing of ours to delete — the one file involved is the
 * agent's own transcript, which this extension reads and never writes. Keyed by that
 * path because it is the only stable name such a row has.
 *
 * Workspace state rather than `meta.json`: there is no `meta.json` to put it in.
 */
class DismissedSessions {
  static readonly KEY = 'agentMonitor.dismissedTranscripts';

  #paths: Set<string>;

  constructor(private readonly context: vscode.ExtensionContext) {
    const stored = context.workspaceState.get<unknown>(DismissedSessions.KEY);
    this.#paths = new Set(
      Array.isArray(stored) ? stored.filter((value): value is string => typeof value === 'string') : [],
    );
  }

  get size(): number {
    return this.#paths.size;
  }

  has(transcriptPath: string): boolean {
    return this.#paths.has(transcriptPath);
  }

  async add(transcriptPath: string): Promise<void> {
    this.#paths.add(transcriptPath);
    await this.#save();
  }

  async clear(): Promise<number> {
    const count = this.#paths.size;
    this.#paths = new Set();
    await this.#save();
    return count;
  }

  async #save(): Promise<void> {
    await this.context.workspaceState.update(DismissedSessions.KEY, [...this.#paths]);
  }
}

/**
 * Take a transcript-only row out of the list.
 *
 * Nothing is deleted and nothing is written outside this extension's own workspace
 * state; the transcript stays where the agent put it, and the row comes back with
 * "Show Dismissed Sessions".
 */
async function dismissSession(
  dismissed: DismissedSessions,
  target: Node | undefined,
  refresh: () => Promise<void>,
): Promise<void> {
  if (target?.kind !== 'passive') return;
  await dismissed.add(target.passive.transcriptPath);
  await refresh();
}

/** Put every dismissed row back. There is no per-row undo; the list is short. */
async function restoreDismissed(dismissed: DismissedSessions, refresh: () => Promise<void>): Promise<void> {
  const count = await dismissed.clear();
  await refresh();

  void vscode.window.showInformationMessage(
    count === 0
      ? 'Agent Monitor: nothing was dismissed.'
      : `Agent Monitor: ${count} dismissed session(s) are back in the list, if their transcripts are still recent.`,
  );
}

/**
 * Set a `when`-clause context key, but only when its value actually changed.
 *
 * `setContext` is not free: every clause in the window is re-evaluated, and the tree's
 * inline buttons are rebuilt with them. Firing it once a second with the same value
 * made the buttons flicker under the pointer and their tooltips jump.
 */
async function setContextIfChanged(known: Map<string, boolean>, key: string, value: boolean): Promise<void> {
  if (known.get(key) === value) return;
  known.set(key, value);
  await vscode.commands.executeCommand('setContext', key, value);
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
  const sessions = model
    .snapshot()
    .sessions.filter((session) => session.status !== 'done' && !session.archived);
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
    void vscode.window.showErrorMessage(`Agent Monitor could not save your comment: ${describeError(error)}`);
  }
}

/**
 * Take a session out of the list, or put it back.
 *
 * Nothing is asked first, and nothing is lost: the directory stays exactly where it is,
 * and the row moves to the Archived folder one click away.
 */
async function setArchived(
  model: WorkspaceModel,
  tree: SessionTreeProvider,
  sessionId: string | undefined,
  archived: boolean,
): Promise<void> {
  if (!sessionId) return;
  try {
    await model.setArchived(sessionId, archived);
    tree.refresh();
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Agent Monitor could not ${archived ? 'archive' : 'restore'} the session: ${describeError(error)}`,
    );
  }
}

/**
 * Delete a session directory, after saying what that costs.
 *
 * The confirmation counts the actual files rather than saying "this cannot be undone"
 * and leaving the human to guess the size of it — reports and artefacts are the whole
 * record of a run, and there is no copy anywhere else. A session an agent is still
 * pointed at is called out by name: deleting it does not stop the agent, which will
 * simply start the directory again from empty.
 */
async function deleteSession(
  model: WorkspaceModel,
  tree: SessionTreeProvider,
  panels: SessionPanels,
  sessionId: string | undefined,
): Promise<void> {
  if (!sessionId) return;

  const session = model.session(sessionId);
  const footprint = await sessionFootprint(model.root, sessionId).catch(() => null);
  const remove = 'Delete';

  const confirmed = await vscode.window.showWarningMessage(
    `Delete "${session ? sessionLabel(session) : sessionId}" for good?`,
    { modal: true, detail: deletionDetail(footprint) },
    remove,
  );
  if (confirmed !== remove) return;

  try {
    await model.remove(sessionId);
    panels.close(sessionId);
    tree.refresh();
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Agent Monitor could not delete the session: ${describeError(error)}`,
    );
  }
}

function deletionDetail(footprint: SessionFootprint | null): string {
  if (!footprint) return 'Its directory under .agent-monitor/ is removed. This cannot be undone.';

  const counts = [
    `${footprint.events} report(s)`,
    `${footprint.comments} comment(s)`,
    `${footprint.artifacts} artefact(s)`,
  ].join(', ');

  return [
    `${counts} are removed from .agent-monitor/. This cannot be undone.`,
    footprint.current
      ? 'An agent is still pointed at this session. Deleting it does not stop the agent — it starts a fresh, empty directory on its next report.'
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Everything Setup writes into the agents' configuration, with the Node binary chosen
 * rather than assumed.
 *
 * `process.execPath` used to go in here, and it is wrong on both kinds of install: on a
 * remote host it is `~/.vscode-server/bin/<commit>/node`, which VS Code deletes on its
 * next update, and on the desktop it is VS Code's own Electron binary, which does not
 * run scripts at all. See `core/node-path.ts`.
 */
async function setupPaths(
  context: vscode.ExtensionContext,
  root: string,
): Promise<{ paths: SetupPaths; warning?: string }> {
  const dist = path.join(context.extensionPath, 'dist');
  const node = await resolveNodePath({
    execPath: process.execPath,
    pathEnv: process.env.PATH,
    majorVersion: nodeMajorVersion,
  });

  const paths: SetupPaths = {
    root,
    node: node.path,
    mcpServer: path.join(dist, 'mcp-server.cjs'),
    hook: path.join(dist, 'hook.cjs'),
    codexConfig: path.join(os.homedir(), '.codex', 'config.toml'),
  };

  return { paths, ...(node.warning === undefined ? {} : { warning: node.warning }) };
}

/** `node --version` for a candidate binary, or null when it will not run. */
async function nodeMajorVersion(file: string): Promise<number | null> {
  try {
    const { stdout } = await run(file, ['--version'], { timeout: 3_000 });
    const major = /^v(\d+)\./.exec(stdout.trim())?.[1];
    return major === undefined ? null : Number(major);
  } catch {
    return null;
  }
}

/**
 * Notice configuration of ours that has stopped resolving, and offer to repair it.
 *
 * Both absolute paths Setup writes move on their own — the extension directory on every
 * extension upgrade, VS Code's bundled Node on every VS Code update — and when they do,
 * the failure surfaces in the agent's terminal as `node: not found` from a hook, with
 * nothing on screen connecting it to this extension. Repair is Setup: it rewrites only
 * its own entries.
 */
async function offerRepair(context: vscode.ExtensionContext, root: string): Promise<void> {
  if (!(await isSetUp(root))) return;

  const codexConfig = path.join(os.homedir(), '.codex', 'config.toml');
  const issues = await findBrokenSetup({ root, codexConfig });
  if (issues.length === 0) return;

  const repair = 'Repair';
  const choice = await vscode.window.showWarningMessage(
    `Agent Monitor: ${issues[0]?.program} is gone, so the agents' hooks and MCP server cannot start. This usually means VS Code updated.`,
    repair,
    'Not now',
  );
  if (choice === repair) await runSetup(context, root);
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
  const { paths, warning } = await setupPaths(context, root);

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
        `\nThe agents will run them with ${paths.node}.`,
        outside.length === 0
          ? ''
          : '\nThe Codex config lives outside this workspace and is shared by all your projects. A backup is written next to it.',
        warning === undefined ? '' : `\n${warning}`,
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

  const complaints = [...report.notes, ...(warning === undefined ? [] : [warning])];
  if (complaints.length > 0) {
    void vscode.window.showWarningMessage(`${summary} ${complaints.join(' ')}`);
  } else {
    void vscode.window.showInformationMessage(summary);
  }
}
