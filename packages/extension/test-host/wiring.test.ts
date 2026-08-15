import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import * as vscode from 'vscode';

const EXTENSION_ID = 'agent-monitor.agent-monitor';
const SESSION_ID = 'host-test-session';

interface Contribution {
  contributes: {
    commands: { command: string }[];
    configuration: { properties: Record<string, { default: unknown }> };
    menus: Record<string, { command: string }[]>;
  };
}

function workspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'the host run needs a workspace folder; scripts/host-setup.mjs makes one');
  return folder.uri.fsPath;
}

function manifest(): Contribution {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `extension ${EXTENSION_ID} is not installed in the host`);
  return extension.packageJSON as Contribution;
}

/** A session the extension can find, written the way the agents write one. */
async function writeSession(root: string): Promise<void> {
  const dir = path.join(root, '.agent-monitor', 'sessions', SESSION_ID);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'meta.json'),
    JSON.stringify({
      id: SESSION_ID,
      agent: 'claude',
      cwd: root,
      status: 'working',
      started_at: '2026-08-15T10:00:00.000Z',
      updated_at: '2026-08-15T10:00:00.000Z',
      protocol_version: 1,
      title: 'Session from the host test',
    }),
    'utf8',
  );
  await fs.writeFile(
    path.join(dir, 'events.jsonl'),
    `${JSON.stringify({
      seq: 1,
      ts: '2026-08-15T10:00:01.000Z',
      type: 'progress',
      title: 'A milestone the panel should show',
    })}\n`,
    'utf8',
  );
}

async function waitFor(what: string, predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`timed out waiting for ${what}`);
}

describe('Agent Monitor in a real VS Code', () => {
  before(async function () {
    this.timeout(60_000);
    await writeSession(workspaceRoot());

    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension);
    await extension.activate();
    await vscode.commands.executeCommand('agentMonitor.refresh');
  });

  it('EXT-32: every command the manifest promises is actually registered', async () => {
    // The manifest is a promise to the human: a command in the palette that throws
    // "command not found" is worse than one that was never offered. Nothing else in
    // the suite compares the two halves — `package.json` and `registerCommand` — and
    // they are edited in different files at different times.
    const registered = new Set(await vscode.commands.getCommands(true));
    const declared = manifest().contributes.commands.map((entry) => entry.command);

    assert.ok(declared.length > 0, 'the manifest declares no commands');
    for (const command of declared) {
      assert.ok(registered.has(command), `${command} is declared but never registered`);
    }
  });

  it('EXT-32: every command a menu fires is one the manifest declares', async () => {
    const declared = new Set(manifest().contributes.commands.map((entry) => entry.command));

    for (const [menu, entries] of Object.entries(manifest().contributes.menus)) {
      for (const entry of entries) {
        assert.ok(declared.has(entry.command), `${menu} fires undeclared ${entry.command}`);
      }
    }
  });

  it('EXT-33: every setting has a default, and something reads it', async () => {
    // `agentMonitor.notifyOnQuestion` shipped declared and read by nobody: switching it
    // off changed nothing. A dead setting is worse than a missing one, and the only
    // place that can notice is here, where the manifest and the shipped code meet.
    const config = vscode.workspace.getConfiguration('agentMonitor');
    const properties = manifest().contributes.configuration.properties;
    const bundle = await fs.readFile(
      path.join(vscode.extensions.getExtension(EXTENSION_ID)?.extensionPath ?? '', 'dist', 'extension.cjs'),
      'utf8',
    );

    for (const [key, declaredValue] of Object.entries(properties)) {
      const name = key.replace(/^agentMonitor\./, '');
      assert.deepEqual(config.get(name), declaredValue.default, `${key} default disagrees with the manifest`);
      assert.ok(bundle.includes(`'${name}'`) || bundle.includes(`"${name}"`), `${key} is read by nobody`);
    }
  });

  it('EXT-34: opening a session shows its panel with the session in it', async () => {
    // Proves the whole chain in one go: the model found the session on disk, the panel
    // was created, and the webview was given a document. None of that is reachable
    // without a host.
    await vscode.commands.executeCommand('agentMonitor.openSession', SESSION_ID);

    await waitFor('the session panel to open', () =>
      vscode.window.tabGroups.all.some((group) =>
        group.tabs.some((tab) => tab.label === 'Session from the host test'),
      ),
    );
  });

  it('EXT-35: opening a transcript puts the file in an editor', async () => {
    // The passive rows hang off this one: it is what a click on them does, and it takes
    // its argument straight from the tree rather than asking a question.
    const transcript = path.join(workspaceRoot(), 'transcript.jsonl');
    await fs.writeFile(transcript, '{"type":"assistant"}\n', 'utf8');

    await vscode.commands.executeCommand('agentMonitor.openTranscript', transcript);

    await waitFor('the transcript to open', () =>
      vscode.window.tabGroups.all.some((group) => group.tabs.some((tab) => tab.label === 'transcript.jsonl')),
    );
  });

  it('EXT-36: the view the activity bar points at exists', async () => {
    // `viewsContainers` and `views` are two more halves edited apart; focusing the view
    // is the cheapest thing that fails when they stop agreeing.
    await vscode.commands.executeCommand('agentMonitor.sessions.focus');
  });
});
