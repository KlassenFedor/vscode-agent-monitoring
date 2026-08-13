import { randomBytes } from 'node:crypto';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { artifactsDir, type CommentKind } from '@agent-monitor/protocol';

import { openKindFor } from '../core/artifacts.js';
import type { WorkspaceModel } from '../core/model.js';
import { sessionLabel } from '../core/notify.js';
import { renderSession } from '../core/render.js';

interface WebviewMessage {
  type?: string;
  text?: string;
  kind?: string;
  replyTo?: number;
  ref?: string;
}

/**
 * One panel per session, reused when the same session is opened again.
 *
 * The panel holds no state of its own: it renders whatever the model currently has,
 * so closing and reopening it cannot lose or duplicate anything (TESTS.md EXT-14).
 */
export class SessionPanels {
  readonly #panels = new Map<string, vscode.WebviewPanel>();

  constructor(private readonly model: WorkspaceModel) {}

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
      session ? sessionLabel(session) : sessionId,
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    panel.onDidDispose(() => this.#panels.delete(sessionId));
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

    panel.title = sessionLabel(session);
    panel.webview.html = renderSession(session, {
      nonce: randomBytes(16).toString('base64'),
      cspSource: panel.webview.cspSource,
    });
  }

  dispose(): void {
    for (const panel of this.#panels.values()) panel.dispose();
    this.#panels.clear();
  }

  async #handle(sessionId: string, message: WebviewMessage): Promise<void> {
    if (message.type === 'comment' && typeof message.text === 'string') {
      await this.model.postComment(sessionId, {
        text: message.text,
        kind: (message.kind ?? 'steer') as CommentKind,
        ...(typeof message.replyTo === 'number' ? { replyTo: message.replyTo } : {}),
      });
      return;
    }

    if (message.type === 'openArtifact' && typeof message.ref === 'string') {
      await this.#openArtifact(sessionId, message.ref);
    }
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
