import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { readJsonl, systemClock, type AgentKind, type Clock } from '@agent-monitor/protocol';

import { ActivityParser, type PassiveActivity } from './activity.js';
import { ClaudeTranscriptParser } from './claude.js';
import { CodexTranscriptParser } from './codex.js';
import { claudeProjectSlug } from './slug.js';

export interface PassiveSessionView extends PassiveActivity {
  transcriptPath: string;
  stale: boolean;
}

export interface PassiveTrackerOptions {
  /** Where `.claude` and `.codex` live. Injected so tests can point at fixtures. */
  homeDir: string;
  clock?: Clock;
  staleAfterMs?: number;
  /** Consecutive unreadable reads before the whole layer switches itself off. */
  maxFailures?: number;
  /** How many days of Codex rollouts to consider. */
  daysBack?: number;
  /**
   * Ignore transcripts older than this. A project accumulates hundreds of them, and
   * a session that ended yesterday is history, not a pulse.
   */
  maxAgeMs?: number;
  onDisabled?: (reason: string) => void;
}

interface SourceState {
  agent: AgentKind;
  parser: ActivityParser;
  offset: number;
  /** Belongs to a different workspace; stop reading it. */
  ignored: boolean;
}

const DEFAULT_STALE_AFTER_MS = 10 * 60_000;
const DEFAULT_MAX_FAILURES = 3;
const DEFAULT_DAYS_BACK = 3;
const DEFAULT_MAX_AGE_MS = 6 * 60 * 60_000;

/**
 * The layer that works when nothing has been set up.
 *
 * It reads the agents' own transcript files, which are undocumented and change
 * between releases. That is acceptable for a pulse and unacceptable as a dependency,
 * so the whole layer switches itself off after a few unreadable reads and says so
 * once, instead of reporting per-record noise forever (TESTS.md PASV-07).
 */
export class PassiveTracker {
  readonly root: string;

  readonly #homeDir: string;
  readonly #clock: Clock;
  readonly #staleAfterMs: number;
  readonly #maxFailures: number;
  readonly #daysBack: number;
  readonly #maxAgeMs: number;
  readonly #onDisabled: ((reason: string) => void) | undefined;
  readonly #sources = new Map<string, SourceState>();

  #failures = 0;
  #disabled = false;

  constructor(root: string, options: PassiveTrackerOptions) {
    this.root = root;
    this.#homeDir = options.homeDir;
    this.#clock = options.clock ?? systemClock;
    this.#staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.#maxFailures = options.maxFailures ?? DEFAULT_MAX_FAILURES;
    this.#daysBack = options.daysBack ?? DEFAULT_DAYS_BACK;
    this.#maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.#onDisabled = options.onDisabled;
  }

  get disabled(): boolean {
    return this.#disabled;
  }

  async refresh(): Promise<PassiveSessionView[]> {
    if (this.#disabled) return [];

    try {
      await this.#discover();
    } catch {
      // Discovery walks other tools' directories; if their layout changed, there is
      // nothing to read and nothing to report.
      return this.#views();
    }

    for (const [file, state] of this.#sources) {
      if (state.ignored) continue;
      await this.#read(file, state);
      if (this.#disabled) return [];
    }

    return this.#views();
  }

  async #read(file: string, state: SourceState): Promise<void> {
    try {
      const chunk = await readJsonl<unknown>(file, state.offset, (raw) => raw);
      if (chunk.reset) {
        state.parser = newParser(state.agent);
        state.offset = 0;
      }
      state.parser.applyAll(chunk.records);
      state.offset = chunk.nextOffset;

      if (chunk.records.length === 0 && chunk.skipped > 0) this.#fail(`unparsable records in ${file}`);
      else if (chunk.records.length > 0) this.#failures = 0;

      // A rollout from another project is discovered, identified, and then left alone.
      const cwd = state.parser.result().cwd;
      if (cwd !== null && path.resolve(cwd) !== path.resolve(this.root)) state.ignored = true;
    } catch (error) {
      this.#fail(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  #fail(reason: string): void {
    this.#failures += 1;
    if (this.#failures < this.#maxFailures) return;

    this.#disabled = true;
    this.#sources.clear();
    this.#onDisabled?.(
      `Agent Monitor turned off passive session tracking: the agents' transcript format could not be read (${reason}). Reports published through the monitoring tools are unaffected.`,
    );
  }

  #views(): PassiveSessionView[] {
    const views: PassiveSessionView[] = [];
    for (const [file, state] of this.#sources) {
      if (state.ignored) continue;
      const activity = state.parser.result();
      if (activity.lastActivityAt === null) continue;
      if (this.#clock.now() - Date.parse(activity.lastActivityAt) > this.#maxAgeMs) continue;

      views.push({
        ...activity,
        transcriptPath: file,
        stale: this.#clock.now() - Date.parse(activity.lastActivityAt) > this.#staleAfterMs,
      });
    }

    views.sort((a, b) => (a.lastActivityAt ?? '') < (b.lastActivityAt ?? '') ? 1 : -1);
    return views;
  }

  async #discover(): Promise<void> {
    for (const file of await this.#claudeTranscripts()) this.#track(file, 'claude');
    for (const file of await this.#codexRollouts()) this.#track(file, 'codex');
  }

  #track(file: string, agent: AgentKind): void {
    if (this.#sources.has(file)) return;
    this.#sources.set(file, { agent, parser: newParser(agent), offset: 0, ignored: false });
  }

  /** Claude Code files are already grouped by workspace, so the slug is the filter. */
  async #claudeTranscripts(): Promise<string[]> {
    const dir = path.join(this.#homeDir, '.claude', 'projects', claudeProjectSlug(this.root));
    return listJsonl(dir, this.#clock.now() - this.#maxAgeMs);
  }

  /**
   * Codex groups rollouts by date, not by project, so recent days are scanned and the
   * workspace filter is applied after parsing.
   */
  async #codexRollouts(): Promise<string[]> {
    const base = path.join(this.#homeDir, '.codex', 'sessions');
    const files: string[] = [];

    for (let back = 0; back < this.#daysBack; back += 1) {
      const day = new Date(this.#clock.now() - back * 24 * 60 * 60 * 1000);
      const dir = path.join(
        base,
        String(day.getUTCFullYear()),
        String(day.getUTCMonth() + 1).padStart(2, '0'),
        String(day.getUTCDate()).padStart(2, '0'),
      );
      files.push(...(await listJsonl(dir, this.#clock.now() - this.#maxAgeMs)));
    }
    return files;
  }
}

function newParser(agent: AgentKind): ActivityParser {
  return agent === 'codex' ? new CodexTranscriptParser() : new ClaudeTranscriptParser();
}

/**
 * List recent transcripts in a directory.
 *
 * The modification-time filter is what keeps this cheap: a long-lived project holds
 * hundreds of transcripts, and parsing them all on the first refresh would cost
 * seconds and fill the sidebar with finished work.
 */
async function listJsonl(dir: string, notBefore: number): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const full = path.join(dir, entry.name);
      const stats = await fs.stat(full).catch(() => null);
      if (stats && stats.mtimeMs >= notBefore) files.push(full);
    }
    return files;
  } catch {
    return [];
  }
}
