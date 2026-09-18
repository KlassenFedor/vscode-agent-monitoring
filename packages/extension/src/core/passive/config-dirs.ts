import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/**
 * Every Claude Code configuration directory whose transcripts may belong to this workspace.
 *
 * `~/.claude` is only the default. `CLAUDE_CONFIG_DIR` moves the whole thing — settings,
 * credentials, `projects/` with the transcripts — and it is how people run two accounts
 * side by side: a subscription in `~/.claude`, an API key in `~/.claude-api`. Looking in
 * the default alone made the second account invisible, and the case where that hurts
 * most is exactly the common one: its launcher passes `--setting-sources user`, so the
 * project's hooks never run, no session directory is made, and the transcript is the
 * only trace the session leaves (TESTS.md PASV-16).
 *
 * The environment variable is set in the agent's shell, not in the editor, so it cannot
 * be read from here. What can be found is found by name: every directory in the home
 * called `.claude` or `.claude-<something>`. Anything else — a path outside the home, a
 * name that breaks the pattern — is what `extra` is for (`agentMonitor.claudeConfigDirs`).
 *
 * Missing directories are not filtered out here: the caller lists `projects/<slug>`
 * under each one and an absent directory simply lists as empty.
 */
export async function claudeConfigDirs(homeDir: string, extra: readonly string[] = []): Promise<string[]> {
  const found: string[] = [path.join(homeDir, '.claude')];

  try {
    const entries = await fs.readdir(homeDir, { withFileTypes: true });
    for (const entry of entries) {
      // `~/.claude.json` and its backups share the prefix; they are files, not homes.
      if (entry.isDirectory() && CONFIG_DIR_NAME.test(entry.name)) found.push(path.join(homeDir, entry.name));
    }
  } catch {
    // An unreadable home still has the default and whatever the human named.
  }

  for (const dir of extra) {
    const expanded = expandHome(dir.trim(), homeDir);
    if (expanded !== '' && path.isAbsolute(expanded)) found.push(expanded);
  }

  const seen = new Set<string>();
  return found.filter((dir) => {
    const key = path.resolve(dir);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const CONFIG_DIR_NAME = /^\.claude(?:[-_.].+)?$/;

function expandHome(dir: string, homeDir: string): string {
  if (dir === '~') return homeDir;
  if (dir.startsWith('~/') || dir.startsWith('~\\')) return path.join(homeDir, dir.slice(2));
  return dir;
}
