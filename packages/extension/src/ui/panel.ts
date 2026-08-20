import { randomBytes } from 'node:crypto';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { artifactsDir, type CommentKind } from '@agent-monitor/protocol';

import { openKindFor } from '../core/artifacts.js';
import type { WorkspaceModel } from '../core/model.js';
import type { PassiveSessionView } from '../core/passive/tracker.js';
import { diffRows, renderSession, renderUpdate, type TimelineRow } from '../core/render.js';

interface WebviewMessage {
  type?: string;
  text?: string;
  kind?: string;
  replyTo?: number;
  ref?: string;
  path?: string;
  /** Identifies the send the panel is waiting on, so a stale reply cannot clear it. */
  token?: string;
}

/** The parts of an update that are replaced wholesale, as one comparable string. */
function headerOf(update: { title: string; meta: string; question: string }): string {
  return JSON.stringify([update.title, update.meta, update.question]);
}

function sameKeys(previous: readonly TimelineRow[], next: readonly TimelineRow[]): boolean {
  return previous.length === next.length && previous.every((row, index) => row.key === next[index]?.key);
}

/**
 * One panel per session, reused when the same session is opened again.
 *
 * The panel holds no state of its own: it renders whatever the model currently has,
 * so closing and reopening it cannot lose or duplicate anything (TESTS.md EXT-14).
 */
export class SessionPanels {
  readonly #panels = new Map<string, vscode.WebviewPanel>();
  /** Panels whose document has been written; the rest of the time they are patched. */
  readonly #written = new Set<string>();
  /** Header fragments last sent, so an unchanged session costs no message. */
  readonly #sent = new Map<string, string>();
  /** Timeline rows the panel is currently showing, keyed for patching. */
  readonly #rows = new Map<string, TimelineRow[]>();

  constructor(
    private readonly model: WorkspaceModel,
    /** Transcript pulse for sessions that publish nothing, by session id. */
    private readonly pulses: () => ReadonlyMap<string, PassiveSessionView> = () => new Map(),
  ) {}

  show(sessionId: string): void {
    const existing = this.#panels.get(sessionId);
    if (existing) {
      existing.reveal();
      this.render(sessionId);
      return;
    }

    const session = this.model.session(sessionId);
    const panel = vscode.window.createWebviewPanel(
      'agentMonitor.session',
      session ? renderUpdate(session, this.pulses().get(sessionId)).title : sessionId,
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    panel.onDidDispose(() => {
      this.#panels.delete(sessionId);
      this.#written.delete(sessionId);
      this.#sent.delete(sessionId);
      this.#rows.delete(sessionId);
    });
    panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
      void this.#handle(sessionId, message);
    });

    this.#panels.set(sessionId, panel);
    this.render(sessionId);
  }

  /** Re-render every open panel; called after each model refresh. */
  renderAll(): void {
    for (const sessionId of this.#panels.keys()) this.render(sessionId);
  }

  render(sessionId: string): void {
    const panel = this.#panels.get(sessionId);
    const session = this.model.session(sessionId);
    if (!panel || !session) return;

    const pulse = this.pulses().get(sessionId);
    const update = renderUpdate(session, pulse);
    panel.title = update.title;

    // The document is written once. After that only the parts that change are sent
    // over, because assigning `html` again reloads the page — and this runs on every
    // refresh, which is once a second while an agent works: it would close an open
    // dropdown and wipe a comment the human was still typing.
    if (!this.#written.has(sessionId)) {
      panel.webview.html = renderSession(
        session,
        {
          nonce: randomBytes(16).toString('base64'),
          cspSource: panel.webview.cspSource,
        },
        pulse,
      );
      this.#written.add(sessionId);
      this.#sent.set(sessionId, headerOf(update));
      this.#rows.set(sessionId, update.rows);
      return;
    }

    const rows = diffRows(this.#rows.get(sessionId) ?? [], update.rows);
    const header = headerOf(update);
    const sameOrder = sameKeys(this.#rows.get(sessionId) ?? [], update.rows);
    if (this.#sent.get(sessionId) === header && rows.changed.length === 0 && sameOrder) return;

    this.#sent.set(sessionId, header);
    this.#rows.set(sessionId, update.rows);
    void panel.webview.postMessage({
      type: 'update',
      title: update.title,
      meta: update.meta,
      question: update.question,
      ...rows,
    });
  }

  /**
   * Close the panel for one session, if it has one.
   *
   * Called when the session directory is deleted: `render` already refuses to touch a
   * panel whose session is gone, so without this the human is left looking at a frozen
   * copy of something that no longer exists.
   */
  close(sessionId: string): void {
    this.#panels.get(sessionId)?.dispose();
  }

  dispose(): void {
    for (const panel of this.#panels.values()) panel.dispose();
    this.#panels.clear();
    this.#written.clear();
    this.#sent.clear();
    this.#rows.clear();
  }

  async #handle(sessionId: string, message: WebviewMessage): Promise<void> {
    if (message.type === 'comment' && typeof message.text === 'string') {
      await this.#postComment(sessionId, message);
      return;
    }

    // The transcript is the only place the untruncated text of a passive entry exists.
    if (message.type === 'openTranscript' && typeof message.path === 'string') {
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(message.path));
      return;
    }

    if (message.type === 'openArtifact' && typeof message.ref === 'string') {
      await this.#openArtifact(sessionId, message.ref);
    }
  }

  /**
   * Write the comment, then tell the panel whether it landed.
   *
   * The panel keeps the text until this says it is on disk. A failure here — the
   * session directory gone, the disk read-only — used to be an unhandled rejection
   * behind `void`, with the box already emptied: the comment was lost from the screen
   * and from the file at the same moment, and the human had every reason to believe
   * it had been sent. Losing feedback silently is the most expensive failure this
   * project has (TESTS.md HOOK-06); it does not get a pass in the UI.
   */
  async #postComment(sessionId: string, message: WebviewMessage): Promise<void> {
    const panel = this.#panels.get(sessionId);
    let delivered = false;

    try {
      await this.model.postComment(sessionId, {
        text: message.text as string,
        kind: (message.kind ?? 'steer') as CommentKind,
        ...(typeof message.replyTo === 'number' ? { replyTo: message.replyTo } : {}),
      });
      delivered = true;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(
        `Agent Monitor could not save your comment: ${reason}. It is still in the box — try again.`,
      );
    }

    void panel?.webview.postMessage({ type: 'commentSettled', token: message.token, delivered });
  }

  async #openArtifact(sessionId: string, ref: string): Promise<void> {
    const name = ref.split('/').pop();
    if (!name) return;

    const uri = vscode.Uri.file(path.join(artifactsDir(this.model.root, sessionId), name));
    // VS Code already knows how to show each of these; rendering them inside the
    // webview would be a worse viewer with more attack surface.
    if (openKindFor(ref) === 'markdown') {
      await vscode.commands.executeCommand('markdown.showPreview', uri);
    } else {
      await vscode.commands.executeCommand('vscode.open', uri);
    }
  }
}
