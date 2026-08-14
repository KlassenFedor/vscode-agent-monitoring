import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { MONITOR_DIR, monitorDir } from '@agent-monitor/protocol';

import { readTextOrNull } from './fsutil.js';

export const MARKER_START = '<!-- agent-monitor:start -->';
export const MARKER_END = '<!-- agent-monitor:end -->';

const OWNERSHIP_MARKER = 'agent-monitor';

/**
 * Appended to every hook command this extension writes.
 *
 * The hook ignores it; its job is to let a later setup run recognise its own entries
 * no matter where the extension was installed. Matching on the install path instead
 * would leave a stale duplicate behind after every upgrade (TESTS.md EXT-08).
 */
const HOOK_OWNERSHIP_FLAG = '--agent-monitor';

export interface SetupPaths {
  root: string;
  /** Absolute path to the bundled MCP server entry point. */
  mcpServer: string;
  /** Absolute path to the bundled hook entry point. */
  hook: string;
  /** Node binary the agents should run these with. */
  node: string;
  /** `~/.codex/config.toml`; skipped when absent from the options. */
  codexConfig?: string;
}

export interface SetupReport {
  changed: string[];
  unchanged: string[];
  notes: string[];
}

/**
 * Wire the current workspace up for both agents.
 *
 * Idempotent by construction: every step rewrites only its own entries, identified by
 * the ownership marker, and leaves everything else in the file untouched. Running it
 * twice must produce byte-identical files (TESTS.md EXT-08), and running it after an
 * extension upgrade must repoint the old paths rather than adding a second copy.
 */
export async function setupWorkspace(paths: SetupPaths): Promise<SetupReport> {
  const report: SetupReport = { changed: [], unchanged: [], notes: [] };

  await fs.mkdir(monitorDir(paths.root), { recursive: true });
  await record(report, path.join(paths.root, '.gitignore'), () => ensureGitignoreEntry(paths.root));
  await record(report, path.join(paths.root, '.mcp.json'), () => writeMcpConfig(paths));
  await record(report, path.join(paths.root, '.claude', 'settings.json'), () => writeClaudeHooks(paths));
  await record(report, path.join(paths.root, 'CLAUDE.md'), () =>
    writeMarkerBlock(path.join(paths.root, 'CLAUDE.md'), agentInstructions('claude')),
  );
  await record(report, path.join(paths.root, 'AGENTS.md'), () =>
    writeMarkerBlock(path.join(paths.root, 'AGENTS.md'), agentInstructions('codex')),
  );

  if (paths.codexConfig) {
    await record(report, paths.codexConfig, () => writeCodexConfig(paths.codexConfig as string, paths));
  } else {
    report.notes.push('Codex config was not touched: no config path was provided.');
  }

  return report;
}

/**
 * Has this workspace been wired up yet?
 *
 * Decides which of the two empty-panel messages a first-time user reads, so it answers
 * "would running Setup tell them something new" rather than "was Setup run". The
 * directory appears either way — Setup creates it, and so does the first agent that
 * reports — and in both cases the answer is no.
 */
export async function isSetUp(root: string): Promise<boolean> {
  try {
    return (await fs.stat(monitorDir(root))).isDirectory();
  } catch {
    return false;
  }
}

async function record(report: SetupReport, file: string, step: () => Promise<boolean>): Promise<void> {
  try {
    const changed = await step();
    (changed ? report.changed : report.unchanged).push(file);
  } catch (error) {
    report.notes.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Returns true when the file was modified. */
export async function ensureGitignoreEntry(root: string): Promise<boolean> {
  const file = path.join(root, '.gitignore');
  const entry = `${MONITOR_DIR}/`;
  const current = (await readTextOrNull(file)) ?? '';

  const lines = current.split('\n').map((line) => line.trim());
  if (lines.includes(entry) || lines.includes(MONITOR_DIR)) return false;

  const prefix = current === '' || current.endsWith('\n') ? current : `${current}\n`;
  await writeFile(file, `${prefix}${entry}\n`);
  return true;
}

export async function writeMcpConfig(paths: SetupPaths): Promise<boolean> {
  const file = path.join(paths.root, '.mcp.json');
  const config = ((await readJson(file)) ?? {}) as Record<string, unknown>;
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;

  // The agent is named outright rather than sniffed from the environment: Claude Code
  // does export enough to guess, Codex exports nothing at all, and a session filed
  // under the wrong agent is a session the human cannot find.
  const desired = { command: paths.node, args: [paths.mcpServer], env: { AGENT_MONITOR_AGENT: 'claude' } };
  if (deepEqual(servers[OWNERSHIP_MARKER], desired)) return false;

  config.mcpServers = { ...servers, [OWNERSHIP_MARKER]: desired };
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
  return true;
}

interface HookEntry {
  matcher?: string;
  hooks: { type: string; command: string }[];
}

export async function writeClaudeHooks(paths: SetupPaths): Promise<boolean> {
  const file = path.join(paths.root, '.claude', 'settings.json');
  const settings = ((await readJson(file)) ?? {}) as Record<string, unknown>;
  const hooks = { ...((settings.hooks ?? {}) as Record<string, HookEntry[]>) };

  const desired: Record<string, HookEntry[]> = {
    SessionStart: [{ hooks: [command(paths, 'session-start')] }],
    PostToolUse: [{ matcher: '*', hooks: [command(paths, 'post-tool')] }],
    Stop: [{ hooks: [command(paths, 'stop')] }],
  };

  for (const [event, entries] of Object.entries(desired)) {
    // Drop our previous entries — including ones pointing at an older install path —
    // then add the current ones back. Anything the user configured survives.
    const foreign = (hooks[event] ?? []).filter((entry) => !isOurs(entry));
    hooks[event] = [...foreign, ...entries];
  }

  settings.hooks = hooks;
  const next = `${JSON.stringify(settings, null, 2)}\n`;
  if ((await readTextOrNull(file)) === next) return false;

  await writeFile(file, next);
  return true;
}

function isOurs(entry: HookEntry): boolean {
  return (entry.hooks ?? []).some((hook) => hook.command?.includes(HOOK_OWNERSHIP_FLAG));
}

function command(paths: SetupPaths, subcommand: string): { type: string; command: string } {
  return {
    type: 'command',
    command: `${quote(paths.node)} ${quote(paths.hook)} ${subcommand} ${HOOK_OWNERSHIP_FLAG}`,
  };
}

/**
 * Codex keeps its MCP servers in one global TOML file, so this is the one place the
 * extension writes outside the workspace. It edits a single block and keeps a backup,
 * because the file also holds the user's model and approval settings (EXT-09).
 */
export async function writeCodexConfig(file: string, paths: SetupPaths): Promise<boolean> {
  const current = (await readTextOrNull(file)) ?? '';
  const block = [
    `[mcp_servers.${OWNERSHIP_MARKER}]`,
    `command = ${JSON.stringify(paths.node)}`,
    `args = [${JSON.stringify(paths.mcpServer)}]`,
    // Codex hands an MCP server none of its own environment, so nothing about the
    // server's surroundings says which agent started it.
    `env = { AGENT_MONITOR_AGENT = "codex" }`,
  ].join('\n');

  const next = ensureCodexNotify(
    replaceTomlBlock(current, `[mcp_servers.${OWNERSHIP_MARKER}]`, block),
    paths,
  );
  if (next === current) return false;

  if (current !== '') await writeFile(`${file}.agent-monitor.bak`, current);
  await writeFile(file, next);
  return true;
}

/**
 * Register the `notify` program, which is how Codex says a turn has finished.
 *
 * Two constraints shape this. A bare key must precede every table in TOML, so the line
 * goes above the first `[section]` rather than at the end of the file. And `notify`
 * holds a single program for the whole installation: if the user already has one that
 * is not ours, it stays, and Codex simply keeps its status channel unregistered
 * (DESIGN.md §4.2 — feedback there travels over MCP anyway).
 */
export function ensureCodexNotify(source: string, paths: SetupPaths): string {
  const desired = `notify = [${JSON.stringify(paths.node)}, ${JSON.stringify(paths.hook)}, "notify", "--agent=codex", "${HOOK_OWNERSHIP_FLAG}"]`;

  const lines = source.split('\n');
  const existing = lines.findIndex((line) => /^\s*notify\s*=/.test(line));
  if (existing !== -1) {
    if (!lines[existing]?.includes(HOOK_OWNERSHIP_FLAG)) return source;
    if (lines[existing] === desired) return source;
    lines[existing] = desired;
    return lines.join('\n');
  }

  const firstTable = lines.findIndex((line) => line.trimStart().startsWith('['));
  const insertAt = firstTable === -1 ? lines.length : firstTable;
  lines.splice(insertAt, 0, desired, ...(firstTable === -1 ? [] : ['']));
  return lines.join('\n');
}

/** Replace a TOML table, or append it. A table runs until the next line starting with `[`. */
export function replaceTomlBlock(source: string, header: string, block: string): string {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line.trim() === header);

  if (start === -1) {
    const prefix = source === '' ? '' : source.endsWith('\n') ? source : `${source}\n`;
    return `${prefix}${source === '' ? '' : '\n'}${block}\n`;
  }

  let end = start + 1;
  while (end < lines.length && !lines[end]?.trimStart().startsWith('[')) end += 1;

  const rebuilt = [...lines.slice(0, start), ...block.split('\n'), ...lines.slice(end)].join('\n');
  // A table that ran to the end of the file swallows the trailing newline; putting it
  // back is what makes a second setup run a no-op.
  return rebuilt.endsWith('\n') ? rebuilt : `${rebuilt}\n`;
}

/**
 * Insert or update the instruction block in `CLAUDE.md` / `AGENTS.md`.
 *
 * Bounded by markers so an update rewrites only what the extension wrote; the rest of
 * a file the human has been curating stays exactly as it was (EXT-10).
 */
export async function writeMarkerBlock(file: string, body: string): Promise<boolean> {
  const current = (await readTextOrNull(file)) ?? '';
  const block = `${MARKER_START}\n${body.trim()}\n${MARKER_END}`;

  const start = current.indexOf(MARKER_START);
  const end = current.indexOf(MARKER_END);

  let next: string;
  if (start !== -1 && end > start) {
    next = current.slice(0, start) + block + current.slice(end + MARKER_END.length);
  } else {
    const prefix = current === '' ? '' : current.endsWith('\n') ? `${current}\n` : `${current}\n\n`;
    next = `${prefix}${block}\n`;
  }

  if (next === current) return false;
  await writeFile(file, next);
  return true;
}

/** The rules that make the agent use the tools at all. */
export function agentInstructions(agent: 'claude' | 'codex'): string {
  const pull =
    agent === 'codex'
      ? '- Between steps, call `check_feedback`. It is cheap and returns nothing when there is nothing new.\n'
      : '';

  return `## Progress monitoring

This workspace is monitored by Agent Monitor. For any task longer than about ten minutes:

- Call \`report_progress\` at each milestone — analysis finished, a module done, a plan
  ready, tests green — not after every file edit.
- The reply to \`report_progress\` may contain comments from the human. Apply them from
  your next step onwards; a \`[steer]\` comment overrides your earlier plan.
${pull}- Attach the artefact itself with \`publish_artifact\` when the human would want to read
  a diff, a plan or a table rather than your summary of it.
- At a real fork in the road, call \`ask_user\` instead of guessing.
- Call \`set_status\` with \`waiting_review\` when the work wants looking at, and \`done\`
  when you have finished.`;
}

async function readJson(file: string): Promise<unknown | null> {
  const text = await readTextOrNull(file);
  if (text === null || text.trim() === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`is not valid JSON, so it was left alone: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

async function writeFile(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, 'utf8');
}

function quote(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
