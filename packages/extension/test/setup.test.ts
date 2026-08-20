import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { makeWorkspace } from '@agent-monitor/testkit';
import { describe, expect, it } from 'vitest';

import {
  findBrokenSetup,
  isSetUp,
  MARKER_END,
  MARKER_START,
  replaceTomlBlock,
  setupWorkspace,
  splitCommand,
  writeMarkerBlock,
  type SetupPaths,
} from '../src/core/setup.js';
import { trackTemp } from './helpers.js';

async function makeSetup(overrides: Partial<SetupPaths> = {}): Promise<SetupPaths> {
  const workspace = await makeWorkspace('agent-monitor-setup-');
  trackTemp(workspace.cleanup);

  return {
    root: workspace.root,
    node: '/usr/bin/node',
    mcpServer: '/ext/dist/mcp-server.cjs',
    hook: '/ext/dist/hook.cjs',
    codexConfig: path.join(workspace.root, 'codex-config.toml'),
    ...overrides,
  };
}

async function read(file: string): Promise<string> {
  return fs.readFile(file, 'utf8');
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await read(file)) as Record<string, unknown>;
}

describe('setupWorkspace', () => {
  it('writes every configuration the agents need', async () => {
    const paths = await makeSetup();

    const report = await setupWorkspace(paths);

    expect(report.notes).toEqual([]);
    const mcp = await readJson(path.join(paths.root, '.mcp.json'));
    expect(mcp.mcpServers).toMatchObject({
      'agent-monitor': {
        command: '/usr/bin/node',
        args: ['/ext/dist/mcp-server.cjs'],
        env: { AGENT_MONITOR_AGENT: 'claude' },
      },
    });

    const settings = await readJson(path.join(paths.root, '.claude', 'settings.json'));
    expect(JSON.stringify(settings.hooks)).toContain('/ext/dist/hook.cjs post-tool --agent-monitor');

    expect(await read(path.join(paths.root, 'CLAUDE.md'))).toContain('report_progress');
    expect(await read(paths.codexConfig as string)).toContain('[mcp_servers.agent-monitor]');
    expect(await read(path.join(paths.root, '.gitignore'))).toContain('.agent-monitor/');
  });

  it('EXT-08: running it twice changes nothing the second time', async () => {
    const paths = await makeSetup();
    await setupWorkspace(paths);

    const before = await snapshotFiles(paths);
    const report = await setupWorkspace(paths);
    const after = await snapshotFiles(paths);

    expect(after).toEqual(before);
    expect(report.changed).toEqual([]);
  });

  it('EXT-08: repoints the hook after an extension upgrade instead of adding a second copy', async () => {
    const paths = await makeSetup();
    await setupWorkspace(paths);

    await setupWorkspace({ ...paths, hook: '/ext-2/dist/hook.cjs', mcpServer: '/ext-2/dist/mcp-server.cjs' });

    const settings = await readJson(path.join(paths.root, '.claude', 'settings.json'));
    const serialised = JSON.stringify(settings.hooks);
    expect(serialised).toContain('/ext-2/dist/hook.cjs post-tool --agent-monitor');
    expect(serialised).not.toContain('/ext/dist/hook.cjs');
  });

  it('EXT-09: leaves the rest of an existing configuration alone', async () => {
    const paths = await makeSetup();
    await fs.mkdir(path.join(paths.root, '.claude'), { recursive: true });
    await fs.writeFile(
      path.join(paths.root, '.claude', 'settings.json'),
      JSON.stringify(
        {
          model: 'opus',
          hooks: {
            PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'my-own-linter' }] }],
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    await fs.writeFile(
      path.join(paths.root, '.mcp.json'),
      JSON.stringify({ mcpServers: { other: { command: 'other-server' } } }, null, 2),
      'utf8',
    );

    await setupWorkspace(paths);

    const settings = await readJson(path.join(paths.root, '.claude', 'settings.json'));
    expect(settings.model).toBe('opus');
    expect(JSON.stringify(settings.hooks)).toContain('my-own-linter');

    const mcp = await readJson(path.join(paths.root, '.mcp.json'));
    expect((mcp.mcpServers as Record<string, unknown>).other).toEqual({ command: 'other-server' });
  });

  it('EXT-09: backs the Codex config up before touching it, and keeps the rest', async () => {
    const paths = await makeSetup();
    const codex = paths.codexConfig as string;
    const original = 'model = "gpt-5.6-sol"\n\n[projects."/work"]\ntrust_level = "trusted"\n';
    await fs.writeFile(codex, original, 'utf8');

    await setupWorkspace(paths);

    const updated = await read(codex);
    expect(updated).toContain('model = "gpt-5.6-sol"');
    expect(updated).toContain('trust_level = "trusted"');
    expect(updated).toContain('[mcp_servers.agent-monitor]');
    expect(await read(`${codex}.agent-monitor.bak`)).toBe(original);
  });

  it('EXT-18: knows whether the workspace has been wired up, for the empty-panel message', async () => {
    const paths = await makeSetup();

    expect(await isSetUp(paths.root)).toBe(false);

    await setupWorkspace(paths);

    expect(await isSetUp(paths.root)).toBe(true);
  });

  it('names the agent to the Codex server, which is told nothing by its environment', async () => {
    const paths = await makeSetup();

    await setupWorkspace(paths);

    expect(await read(paths.codexConfig as string)).toContain('env = { AGENT_MONITOR_AGENT = "codex" }');
  });

  it('registers the Codex notify program above the first table, as TOML requires', async () => {
    const paths = await makeSetup();
    const codex = paths.codexConfig as string;
    await fs.writeFile(
      codex,
      'model = "gpt-5.6-sol"\n\n[projects."/work"]\ntrust_level = "trusted"\n',
      'utf8',
    );

    await setupWorkspace(paths);

    const lines = (await read(codex)).split('\n');
    const notifyLine = lines.findIndex((line) => line.startsWith('notify ='));
    const firstTable = lines.findIndex((line) => line.startsWith('['));

    expect(notifyLine).toBeGreaterThanOrEqual(0);
    expect(notifyLine).toBeLessThan(firstTable);
    expect(lines[notifyLine]).toContain('/ext/dist/hook.cjs');
    expect(lines[notifyLine]).toContain('--agent=codex');
    expect(lines[notifyLine]).toContain('--agent-monitor');
  });

  it("leaves someone else's notify program alone", async () => {
    const paths = await makeSetup();
    const codex = paths.codexConfig as string;
    await fs.writeFile(codex, 'notify = ["/usr/bin/my-notifier"]\n', 'utf8');

    await setupWorkspace(paths);

    const updated = await read(codex);
    expect(updated).toContain('notify = ["/usr/bin/my-notifier"]');
    expect(updated).not.toContain('--agent=codex');
    expect(updated).toContain('[mcp_servers.agent-monitor]');
  });

  it('repoints its own notify program after the extension moves', async () => {
    const paths = await makeSetup();
    const codex = paths.codexConfig as string;
    await setupWorkspace(paths);
    await setupWorkspace({ ...paths, hook: '/new-ext/dist/hook.cjs' });

    const updated = await read(codex);
    expect(updated).toContain('/new-ext/dist/hook.cjs');
    expect(updated).not.toContain('/ext/dist/hook.cjs');
    expect(updated.match(/^notify =/gm)).toHaveLength(1);
  });

  it('EXT-09: reports a broken config instead of overwriting it', async () => {
    const paths = await makeSetup();
    await fs.mkdir(path.join(paths.root, '.claude'), { recursive: true });
    const broken = '{ "hooks": ';
    await fs.writeFile(path.join(paths.root, '.claude', 'settings.json'), broken, 'utf8');

    const report = await setupWorkspace(paths);

    expect(report.notes.join(' ')).toContain('not valid JSON');
    expect(await read(path.join(paths.root, '.claude', 'settings.json'))).toBe(broken);
  });

  it('EXT-11: adds the ignore entry exactly once', async () => {
    const paths = await makeSetup();
    await fs.writeFile(path.join(paths.root, '.gitignore'), 'node_modules/\n', 'utf8');

    await setupWorkspace(paths);
    await setupWorkspace(paths);

    const gitignore = await read(path.join(paths.root, '.gitignore'));
    expect(gitignore.split('\n').filter((line) => line.trim() === '.agent-monitor/')).toHaveLength(1);
    expect(gitignore).toContain('node_modules/');
  });

  it('skips the Codex config when no path is available', async () => {
    const paths = await makeSetup();
    const report = await setupWorkspace({ ...paths, codexConfig: undefined });

    expect(report.notes.join(' ')).toContain('Codex config was not touched');
  });
});

describe('EXT-10: instruction blocks in CLAUDE.md and AGENTS.md', () => {
  it('appends a bounded block to a file the human already owns', async () => {
    const paths = await makeSetup();
    const file = path.join(paths.root, 'CLAUDE.md');
    await fs.writeFile(file, '# My project\n\nBuild with `npm run build`.\n', 'utf8');

    await setupWorkspace(paths);

    const content = await read(file);
    expect(content).toContain('# My project');
    expect(content).toContain('Build with `npm run build`.');
    expect(content.indexOf(MARKER_START)).toBeGreaterThan(content.indexOf('# My project'));
  });

  it('rewrites only what is between the markers', async () => {
    const paths = await makeSetup();
    const file = path.join(paths.root, 'CLAUDE.md');
    await fs.writeFile(
      file,
      `# Before\n\n${MARKER_START}\nold instructions\n${MARKER_END}\n\n# After\n`,
      'utf8',
    );

    await writeMarkerBlock(file, 'new instructions');

    const content = await read(file);
    expect(content).toContain('# Before');
    expect(content).toContain('# After');
    expect(content).toContain('new instructions');
    expect(content).not.toContain('old instructions');
  });

  it('is a no-op when the block is already current', async () => {
    const file = path.join((await makeSetup()).root, 'AGENTS.md');
    await writeMarkerBlock(file, 'same body');

    expect(await writeMarkerBlock(file, 'same body')).toBe(false);
  });
});

describe('replaceTomlBlock', () => {
  it('appends the table when the file does not have it', () => {
    expect(replaceTomlBlock('model = "x"\n', '[a.b]', '[a.b]\nkey = 1')).toBe(
      'model = "x"\n\n[a.b]\nkey = 1\n',
    );
  });

  it('replaces the table in place, leaving the tables around it', () => {
    const source = '[first]\nx = 1\n\n[a.b]\nold = true\n\n[last]\ny = 2\n';

    const result = replaceTomlBlock(source, '[a.b]', '[a.b]\nnew = true');

    expect(result).toContain('[first]\nx = 1');
    expect(result).toContain('[a.b]\nnew = true');
    expect(result).toContain('[last]\ny = 2');
    expect(result).not.toContain('old = true');
  });

  it('handles a table that runs to the end of the file', () => {
    const result = replaceTomlBlock('[a.b]\nold = 1\n', '[a.b]', '[a.b]\nnew = 1');
    expect(result.trim()).toBe('[a.b]\nnew = 1');
  });
});

async function snapshotFiles(paths: SetupPaths): Promise<Record<string, string>> {
  const files = [
    path.join(paths.root, '.mcp.json'),
    path.join(paths.root, '.claude', 'settings.json'),
    path.join(paths.root, 'CLAUDE.md'),
    path.join(paths.root, 'AGENTS.md'),
    path.join(paths.root, '.gitignore'),
    paths.codexConfig as string,
  ];

  const entries = await Promise.all(files.map(async (file) => [file, await read(file)] as const));
  return Object.fromEntries(entries);
}

describe('EXT-30: Setup says what it will touch before it touches it', () => {
  it('names the same files a real run changes, and writes none of them', async () => {
    // One of them is ~/.codex/config.toml: outside the workspace, shared by every
    // project on the machine. Finding out afterwards from "updated 3 file(s)" is not
    // consent. The preview is the same code with the writes turned off, so it cannot
    // drift from what actually happens.
    const paths = await makeSetup();

    const plan = await setupWorkspace(paths, { dryRun: true });
    const before = await listFiles(paths.root);

    expect(plan.changed.length).toBeGreaterThan(0);
    expect(plan.changed).toContain(paths.codexConfig);
    expect(before).toEqual([]);
    await expect(fs.stat(paths.codexConfig as string)).rejects.toThrow();

    const real = await setupWorkspace(paths);
    expect(real.changed).toEqual(plan.changed);
  });

  it('promises nothing when there is nothing left to do', async () => {
    const paths = await makeSetup();
    await setupWorkspace(paths);

    expect((await setupWorkspace(paths, { dryRun: true })).changed).toEqual([]);
  });

  it('leaves an existing config untouched while previewing', async () => {
    const paths = await makeSetup();
    await fs.writeFile(paths.codexConfig as string, 'model = "gpt-5.6"\n', 'utf8');

    await setupWorkspace(paths, { dryRun: true });

    expect(await read(paths.codexConfig as string)).toBe('model = "gpt-5.6"\n');
    await expect(fs.stat(`${paths.codexConfig as string}.agent-monitor.bak`)).rejects.toThrow();
  });
});

async function listFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
}

describe('EXT-38: configuration that has stopped resolving', () => {
  /** Only the paths handed in exist; everything else is gone. */
  function only(...present: string[]): (file: string) => Promise<boolean> {
    return async (file) => present.includes(file);
  }

  it('says nothing about a setup whose programs are all there', async () => {
    const paths = await makeSetup();
    await setupWorkspace(paths);

    const issues = await findBrokenSetup(paths, only(paths.node, paths.hook, paths.mcpServer));

    expect(issues).toEqual([]);
  });

  it('names the node VS Code deleted, in every file that mentions it', async () => {
    // The failure this exists for: VS Code updates, the build-id directory under
    // `.vscode-server/bin/` is replaced, and every hook the agent fires answers
    // `/bin/sh: 1: …/node: not found` with nothing on screen tying it to this extension.
    const node = '/home/u/.vscode-server/bin/a5b5009/node';
    const paths = await makeSetup({ node });
    await setupWorkspace(paths);

    const issues = await findBrokenSetup(paths, only(paths.hook, paths.mcpServer));

    expect(issues.map((issue) => issue.program)).toEqual(Array(issues.length).fill(node));
    expect(new Set(issues.map((issue) => issue.file))).toEqual(
      new Set([
        path.join(paths.root, '.mcp.json'),
        path.join(paths.root, '.claude', 'settings.json'),
        paths.codexConfig,
      ]),
    );
  });

  it('names a bundle left behind by an extension upgrade', async () => {
    const paths = await makeSetup();
    await setupWorkspace(paths);

    const issues = await findBrokenSetup(paths, only(paths.node, paths.mcpServer));

    expect(issues.map((issue) => issue.program)).toContain(paths.hook);
    expect(issues.map((issue) => issue.program)).not.toContain(paths.mcpServer);
  });

  it("leaves the human's own hooks alone", async () => {
    const paths = await makeSetup();
    const settings = path.join(paths.root, '.claude', 'settings.json');
    await fs.mkdir(path.dirname(settings), { recursive: true });
    await fs.writeFile(
      settings,
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: '/gone/their-own-script.sh' }] }] },
      }),
    );
    await setupWorkspace(paths);

    const issues = await findBrokenSetup(paths, only(paths.node, paths.hook, paths.mcpServer));

    expect(issues).toEqual([]);
  });

  it('reports nothing for a workspace that was never set up', async () => {
    const paths = await makeSetup();

    expect(await findBrokenSetup(paths, only())).toEqual([]);
  });

  it('reads the program back out of a quoted command', () => {
    expect(splitCommand('/usr/bin/node /ext/hook.cjs stop --agent-monitor')).toEqual([
      '/usr/bin/node',
      '/ext/hook.cjs',
      'stop',
      '--agent-monitor',
    ]);
    expect(splitCommand('"C:\\Program Files\\nodejs\\node.exe" "C:\\ext\\hook.cjs" stop')).toEqual([
      'C:\\Program Files\\nodejs\\node.exe',
      'C:\\ext\\hook.cjs',
      'stop',
    ]);
    expect(splitCommand('')).toEqual([]);
  });
});
