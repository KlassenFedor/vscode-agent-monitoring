import { promises as fs } from 'node:fs';

/**
 * Minimum Node the bundled server and hook are built against (`engines` in the
 * extension manifest). A node older than this starts and then fails somewhere inside,
 * which is a worse failure than not being found at all.
 */
export const MIN_NODE_MAJOR = 20;

export interface NodeLookup {
  /** `process.execPath` of the extension host. */
  execPath: string;
  /** `process.env.PATH`. */
  pathEnv?: string | undefined;
  platform?: NodeJS.Platform;
  /** Swapped out in tests. */
  exists?: (file: string) => Promise<boolean>;
  /** Major version of a candidate, or `null` when it cannot be run. Swapped out in tests. */
  majorVersion?: (file: string) => Promise<number | null>;
}

export interface ResolvedNode {
  /** Absolute path to write into the agents' configuration. */
  path: string;
  /** Where it came from, for the message shown before anything is written. */
  source: 'path' | 'execPath';
  /**
   * Set when the chosen path is the best available and still not good enough: it is
   * version-scoped, unverifiable, or too old. Shown to the human rather than swallowed.
   */
  warning?: string;
}

/**
 * Does this path die on the next VS Code update?
 *
 * A remote extension host runs the Node that ships inside the server build, at
 * `~/.vscode-server/bin/<commit>/node`. The commit is the build id: an update installs
 * a new directory and removes the old one, so a path written into `.claude/settings.json`
 * yesterday resolves to nothing today —
 *
 *     /bin/sh: 1: /home/…/.vscode-server/bin/a5b5009…/node: not found
 *
 * — and every hook the agent fires reports a failure the human cannot act on.
 */
export function isEphemeralNode(execPath: string): boolean {
  const segments = execPath.split(/[\\/]/);
  return segments.some((segment) =>
    ['.vscode-server', '.vscode-remote', '.vscode-server-insiders', '.cursor-server'].includes(segment),
  );
}

/**
 * Is this a Node binary at all?
 *
 * On the desktop, `process.execPath` is VS Code's own Electron executable. It runs
 * scripts only with `ELECTRON_RUN_AS_NODE=1` in its environment — which agents spawning
 * a hook do not set — and without it, `code some-script.js` opens an editor window.
 */
export function looksLikeNode(execPath: string): boolean {
  // Split on both separators, not `path.basename`: a Windows path handed to the POSIX
  // build of `path` comes back whole, and the check silently answers about nothing.
  const base = (execPath.split(/[\\/]/).pop() ?? '').toLowerCase();
  return base === 'node' || base === 'node.exe';
}

/**
 * Pick the Node binary to write into the agents' configuration.
 *
 * Not `process.execPath`: what runs this extension is the wrong answer on both of the
 * two ways VS Code is installed (see `isEphemeralNode` and `looksLikeNode`). What the
 * agents need is a Node that will still be there next week, so the search starts at
 * `PATH` — the same lookup the human's own shell does — and falls back to the extension
 * host's own binary only when there is nothing else at all.
 */
export async function resolveNodePath(lookup: NodeLookup): Promise<ResolvedNode> {
  const platform = lookup.platform ?? process.platform;
  const exists = lookup.exists ?? fileExists;
  const majorVersion = lookup.majorVersion ?? (async () => null);

  const hostIsUsable = looksLikeNode(lookup.execPath) && !isEphemeralNode(lookup.execPath);
  const candidates = hostIsUsable
    ? [lookup.execPath, ...pathCandidates(lookup.pathEnv, platform)]
    : [...pathCandidates(lookup.pathEnv, platform), lookup.execPath];

  const present: string[] = [];
  for (const candidate of candidates) {
    if (present.includes(candidate)) continue;
    if (await exists(candidate)) present.push(candidate);
  }

  let firstTooOld: { path: string; major: number } | undefined;
  for (const candidate of present) {
    const major = await majorVersion(candidate);
    if (major === null) continue;
    if (major >= MIN_NODE_MAJOR) return describe(candidate, lookup.execPath);
    firstTooOld ??= { path: candidate, major };
  }

  // Nothing answered `--version`, or everything that did was too old. Both are better
  // reported with a working-ish path than turned into a failed setup: the agents may
  // well run fine, and the human is the one who can tell.
  if (present.length > 0) {
    const chosen = present[0] as string;
    const resolved = describe(chosen, lookup.execPath);
    if (firstTooOld && firstTooOld.path === chosen) {
      return {
        ...resolved,
        warning: `${chosen} is Node ${firstTooOld.major}; Agent Monitor needs ${MIN_NODE_MAJOR} or newer. Install a newer Node and run Setup again.`,
      };
    }
    return resolved;
  }

  return {
    path: lookup.execPath,
    source: 'execPath',
    warning: hostIsUsable
      ? `No Node was found on PATH, so ${lookup.execPath} was used instead.`
      : `No Node was found on PATH, so ${lookup.execPath} was used instead. It belongs to VS Code and stops working when VS Code updates — install Node and run Setup again.`,
  };
}

function describe(chosen: string, execPath: string): ResolvedNode {
  if (chosen !== execPath) return { path: chosen, source: 'path' };
  if (isEphemeralNode(execPath)) {
    return {
      path: chosen,
      source: 'execPath',
      warning: `No Node was found on PATH, so VS Code's own (${execPath}) was used. It is replaced on every VS Code update, and Setup has to be run again when that happens.`,
    };
  }
  return { path: chosen, source: 'execPath' };
}

/**
 * `node` under every directory on PATH, in the order the shell would search them.
 *
 * Joined by hand rather than with `path.join`, which uses the separator of the machine
 * this is running on. That is the right one in production and the wrong one in a test
 * of Windows behaviour running on Linux — and a lookup nobody can test on the platform
 * that broke is how this file came to exist.
 */
function pathCandidates(pathEnv: string | undefined, platform: NodeJS.Platform): string[] {
  if (!pathEnv) return [];
  const windows = platform === 'win32';
  const [listSeparator, pathSeparator, binary] = windows ? [';', '\\', 'node.exe'] : [':', '/', 'node'];

  return pathEnv
    .split(listSeparator)
    .map((dir) => dir.trim().replace(/[\\/]+$/, ''))
    .filter((dir) => dir !== '')
    .map((dir) => `${dir}${pathSeparator}${binary}`);
}

async function fileExists(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}
