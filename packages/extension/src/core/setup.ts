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

export interface SetupOptions {
  /**
   * Work out what would change without touching anything.
   *
   * The same code path decides, so the preview cannot drift from the write: the only
   * difference is where the bytes go. This exists because one of the files is
   * `~/.codex/config.toml` — outside the workspace, shared by every project on the
   * machine — and finding out afterwards from "updated 3 file(s)" is not consent.
   */
  dryRun?: boolean;
}

/** Where a step sends its bytes. Swapped out to preview instead of write. */
export type Writer = (file: string, content: string) => Promise<void>;

const realWriter: Writer = async (file, content) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, 'utf8');
};

const previewWriter: Writer = async () => {};

/**
 * Wire the current workspace up for both agents.
 *
 * Idempotent by construction: every step rewrites only its own entries, identified by
 * the ownership marker, and leaves everything else in the file untouched. Running it
 * twice must produce byte-identical files (TESTS.md EXT-08), and running it after an
 * extension upgrade must repoint the old paths rather than adding a second copy.
 */
export async function setupWorkspace(paths: SetupPaths, options: SetupOptions = {}): Promise<SetupReport> {
  const report: SetupReport = { changed: [], unchanged: [], notes: [] };
  const write = options.dryRun === true ? previewWriter : realWriter;

  if (options.dryRun !== true) await fs.mkdir(monitorDir(paths.root), { recursive: true });
  await record(report, path.join(paths.root, '.gitignore'), () => ensureGitignoreEntry(paths.root, write));
  await record(report, path.join(paths.root, '.mcp.json'), () => writeMcpConfig(paths, write));
  await record(report, path.join(paths.root, '.claude', 'settings.json'), () =>
    writeClaudeHooks(paths, write),
  );
  await record(report, path.join(paths.root, 'CLAUDE.md'), () =>
    writeMarkerBlock(path.join(paths.root, 'CLAUDE.md'), agentInstructions('claude'), write),
  );
  await record(report, path.join(paths.root, 'AGENTS.md'), () =>
    writeMarkerBlock(path.join(paths.root, 'AGENTS.md'), agentInstructions('codex'), write),
  );

  if (paths.codexConfig) {
    await record(report, paths.codexConfig, () =>
      writeCodexConfig(paths.codexConfig as string, paths, write),
    );
  } else {
    report.notes.push('Codex config was not touched: no config path was provided.');
  }

  return report;
}

export interface SetupIssue {
  /** The configuration file naming a program that is not there. */
  file: string;
  /** The path that does not resolve. */
  program: string;
}

/**
 * Find configuration this extension wrote that now points at nothing.
 *
 * Setup writes absolute paths, and two of them move on their own: the extension
 * directory changes on every extension upgrade, and VS Code's bundled Node lives under
 * a build-id directory that is replaced on every VS Code update. Either one leaves the
 * agents running commands that fail — a Stop hook reporting `node: not found`, or an
 * MCP server that never starts, which is the same failure with nobody to report it.
 *
 * Only entries carrying our ownership marker are examined; a program the human
 * configured is their business.
 */
export async function findBrokenSetup(
  paths: Pick<SetupPaths, 'root' | 'codexConfig'>,
  exists: (file: string) => Promise<boolean> = fileExists,
): Promise<SetupIssue[]> {
  const issues: SetupIssue[] = [];

  const check = async (file: string, programs: readonly string[]): Promise<void> => {
    for (const program of programs) {
      if (program !== '' && !(await exists(program))) issues.push({ file, program });
    }
  };

  const mcpFile = path.join(paths.root, '.mcp.json');
  const mcp = (await readJsonOrNull(mcpFile)) as { mcpServers?: Record<string, unknown> } | null;
  const server = mcp?.mcpServers?.[OWNERSHIP_MARKER] as { command?: unknown; args?: unknown } | undefined;
  if (server) {
    await check(mcpFile, programsOf(server.command, server.args));
  }

  const claudeFile = path.join(paths.root, '.claude', 'settings.json');
  const claude = (await readJsonOrNull(claudeFile)) as { hooks?: Record<string, HookEntry[]> } | null;
  for (const entries of Object.values(claude?.hooks ?? {})) {
    for (const entry of entries) {
      if (!isOurs(entry)) continue;
      for (const hook of entry.hooks ?? []) {
        await check(claudeFile, splitCommand(hook.command).slice(0, 2));
      }
    }
  }

  if (paths.codexConfig) {
    const toml = (await readTextOrNull(paths.codexConfig)) ?? '';
    await check(paths.codexConfig, codexPrograms(toml));
  }

  return issues;
}

function programsOf(command: unknown, args: unknown): string[] {
  const first = Array.isArray(args) && typeof args[0] === 'string' ? [args[0]] : [];
  return [...(typeof command === 'string' ? [command] : []), ...first];
}

/** The node binary and the bundle out of our two entries in `~/.codex/config.toml`. */
function codexPrograms(toml: string): string[] {
  const programs: string[] = [];

  const block = toml.split(`[mcp_servers.${OWNERSHIP_MARKER}]`)[1]?.split('\n[')[0];
  if (block !== undefined) {
    const command = /^\s*command\s*=\s*("(?:[^"\\]|\\.)*")/m.exec(block);
    const args = /^\s*args\s*=\s*\[\s*("(?:[^"\\]|\\.)*")/m.exec(block);
    for (const match of [command, args]) {
      if (match?.[1]) programs.push(JSON.parse(match[1]) as string);
    }
  }

  const notify = /^\s*notify\s*=\s*\[\s*("(?:[^"\\]|\\.)*")\s*,\s*("(?:[^"\\]|\\.)*")/m.exec(toml);
  if (notify && toml.includes(HOOK_OWNERSHIP_FLAG)) {
    for (const token of [notify[1], notify[2]]) {
      if (token) programs.push(JSON.parse(token) as string);
    }
  }

  return programs;
}

/**
 * Split a hook command line the way a shell would, for the quoting `quote()` produces.
 *
 * Only what we write has to survive this: a program path, possibly quoted because it
 * contains a space, followed by plain arguments.
 */
export function splitCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quoted = false;
  let started = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === '\\' && quoted && command[index + 1] === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
      started = true;
    } else if (!quoted && /\s/.test(char ?? '')) {
      if (started) tokens.push(current);
      current = '';
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (started) tokens.push(current);

  return tokens;
}

async function fileExists(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

/** Like `readJson`, but a file we cannot parse is simply not our problem here. */
async function readJsonOrNull(file: string): Promise<unknown | null> {
  try {
    return await readJson(file);
  } catch {
    return null;
  }
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
export async function ensureGitignoreEntry(root: string, write: Writer = realWriter): Promise<boolean> {
  const file = path.join(root, '.gitignore');
  const entry = `${MONITOR_DIR}/`;
  const current = (await readTextOrNull(file)) ?? '';

  const lines = current.split('\n').map((line) => line.trim());
  if (lines.includes(entry) || lines.includes(MONITOR_DIR)) return false;

  const prefix = current === '' || current.endsWith('\n') ? current : `${current}\n`;
  await write(file, `${prefix}${entry}\n`);
  return true;
}

export async function writeMcpConfig(paths: SetupPaths, write: Writer = realWriter): Promise<boolean> {
  const file = path.join(paths.root, '.mcp.json');
  const config = ((await readJson(file)) ?? {}) as Record<string, unknown>;
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;

  // The agent is named outright rather than sniffed from the environment: Claude Code
  // does export enough to guess, Codex exports nothing at all, and a session filed
  // under the wrong agent is a session the human cannot find.
  const desired = { command: paths.node, args: [paths.mcpServer], env: { AGENT_MONITOR_AGENT: 'claude' } };
  if (deepEqual(servers[OWNERSHIP_MARKER], desired)) return false;

  config.mcpServers = { ...servers, [OWNERSHIP_MARKER]: desired };
  await write(file, `${JSON.stringify(config, null, 2)}\n`);
  return true;
}

interface HookEntry {
  matcher?: string;
  hooks: { type: string; command: string }[];
}

export async function writeClaudeHooks(paths: SetupPaths, write: Writer = realWriter): Promise<boolean> {
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

  await write(file, next);
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
export async function writeCodexConfig(
  file: string,
  paths: SetupPaths,
  write: Writer = realWriter,
): Promise<boolean> {
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

  if (current !== '') await write(`${file}.agent-monitor.bak`, current);
  await write(file, next);
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
export async function writeMarkerBlock(
  file: string,
  body: string,
  write: Writer = realWriter,
): Promise<boolean> {
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
  await write(file, next);
  return true;
}

/** The rules that make the agent use the tools at all. */
export function agentInstructions(agent: 'claude' | 'codex'): string {
  const pull =
    agent === 'codex'
      ? '- Between steps, call `check_feedback`. It is cheap and returns nothing when there is nothing new.\n'
      : '';

  return `## Progress monitoring

This workspace is monitored by Agent Monitor: a local log kept under \`.agent-monitor/\`
in the workspace root. Reports, questions and artefacts are written to files on this
machine and read by the person who started the session; nothing is uploaded anywhere and
the tools open no network connection. Reporting into it is asked for by this file, so it
is part of the work rather than something extra you need permission for.

For any task longer than about ten minutes:

- Call \`report_progress\` at each milestone — analysis finished, a module done, a plan
  ready, tests green — not after every file edit.
- The reply to \`report_progress\` may contain comments from the human. Apply them from
  your next step onwards; a \`[steer]\` comment overrides your earlier plan.
${pull}- Attach the artefact itself with \`publish_artifact\` when the human would want to read
  a diff, a plan or a table rather than your summary of it.
- At a real fork in the road, call \`ask_user\` instead of guessing.
- Call \`set_status\` with \`waiting_review\` when the work wants looking at, and \`done\`
  when you have finished.
- Attach the smallest thing that carries the point — a diff, an excerpt, a table — not a
  whole archive, build output or dependency tree, and never a file holding credentials or
  personal data.
- If one of these calls is refused by your own permission or approval rules, do not retry
  it and do not go quiet: say what was refused in \`report_progress\`, which moves no files,
  and call \`ask_user\` when it is the human's approval you are missing.
- Write everything the human reads in the panel — report titles, phases, summaries and
  next steps, artefact titles and notes, questions and their options, session titles —
  in the language the human uses in their own messages and comments, not the language
  of the code or of these instructions. Use a different language only when they have
  explicitly asked for one.`;
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

function quote(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
