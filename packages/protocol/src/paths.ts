import * as path from 'node:path';

import { UnsafeNameError } from './errors.js';

/** Root of the file bus inside a workspace. Git-ignored by the setup command. */
export const MONITOR_DIR = '.agent-monitor';

export const SESSIONS_DIR = 'sessions';
export const ARTIFACTS_DIR = 'artifacts';
export const EVENTS_FILE = 'events.jsonl';
export const INBOX_FILE = 'inbox.jsonl';
export const META_FILE = 'meta.json';
export const CURSOR_FILE = 'cursor.json';
export const INDEX_FILE = 'index.jsonl';

/** Bumped whenever an on-disk shape changes incompatibly. */
export const PROTOCOL_VERSION = 1;

export function monitorDir(root: string): string {
  return path.join(root, MONITOR_DIR);
}

export function sessionsDir(root: string): string {
  return path.join(monitorDir(root), SESSIONS_DIR);
}

export function sessionDir(root: string, sessionId: string): string {
  return path.join(sessionsDir(root), assertSessionId(sessionId));
}

export function eventsPath(root: string, sessionId: string): string {
  return path.join(sessionDir(root, sessionId), EVENTS_FILE);
}

export function inboxPath(root: string, sessionId: string): string {
  return path.join(sessionDir(root, sessionId), INBOX_FILE);
}

export function metaPath(root: string, sessionId: string): string {
  return path.join(sessionDir(root, sessionId), META_FILE);
}

export function cursorPath(root: string, sessionId: string): string {
  return path.join(sessionDir(root, sessionId), CURSOR_FILE);
}

export function artifactsDir(root: string, sessionId: string): string {
  return path.join(sessionDir(root, sessionId), ARTIFACTS_DIR);
}

export function indexPath(root: string): string {
  return path.join(monitorDir(root), INDEX_FILE);
}

/** Lock file guarding a data file. Kept next to it so both share a filesystem. */
export function lockPathFor(target: string): string {
  return `${target}.lock`;
}

/**
 * Session ids come from agent environment variables, so they are untrusted input
 * that ends up as a directory name.
 */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isSafeSessionId(value: string): boolean {
  return SESSION_ID_RE.test(value) && !value.includes('..');
}

export function assertSessionId(value: string): string {
  if (!isSafeSessionId(value)) {
    throw new UnsafeNameError(value, 'session id must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}');
  }
  return value;
}

/**
 * Artifact names are chosen by the agent, i.e. by a language model, i.e. by whatever
 * ends up in its context. Path separators are rejected outright rather than
 * normalised: an artifact is always a flat file directly inside `artifacts/`.
 */
const ARTIFACT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** Device names Windows resolves regardless of the directory the file sits in. */
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

export function isSafeArtifactName(value: string): boolean {
  if (!ARTIFACT_NAME_RE.test(value)) return false;
  if (value.includes('..')) return false;
  if (value.endsWith('.')) return false;
  if (WINDOWS_RESERVED_RE.test(value)) return false;
  return true;
}

export function assertArtifactName(value: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new UnsafeNameError(String(value), 'artifact name must be a non-empty string');
  }
  if (value.includes('\0')) throw new UnsafeNameError(value, 'contains a NUL byte');
  if (path.isAbsolute(value)) throw new UnsafeNameError(value, 'must be relative');
  if (value.includes('/') || value.includes('\\')) {
    throw new UnsafeNameError(value, 'must not contain path separators');
  }
  if (!isSafeArtifactName(value)) {
    throw new UnsafeNameError(
      value,
      'must match [A-Za-z0-9][A-Za-z0-9._-]{0,99}, not end with a dot, and not be a Windows device name',
    );
  }
  return value;
}

/**
 * Resolve an artifact name to an absolute path, then prove the result is still
 * inside the session's `artifacts/` directory.
 *
 * The name check above already makes escape impossible; this is the second lock on
 * the door, so a future relaxation of the character rules cannot silently turn into
 * a path traversal (docs/TESTS.md SEC-04).
 */
export function resolveArtifactPath(root: string, sessionId: string, name: string): string {
  const dir = artifactsDir(root, sessionId);
  const resolved = path.resolve(dir, assertArtifactName(name));
  const prefix = path.resolve(dir) + path.sep;
  if (!resolved.startsWith(prefix)) {
    throw new UnsafeNameError(name, 'resolves outside the session artifacts directory');
  }
  return resolved;
}

/** `artifacts/<name>`, the form stored inside events. Always POSIX-separated. */
export function artifactRef(name: string): string {
  return `${ARTIFACTS_DIR}/${assertArtifactName(name)}`;
}

/** Reject anything in `event.artifacts` that does not point into `artifacts/`. */
export function assertArtifactRef(value: string): string {
  const prefix = `${ARTIFACTS_DIR}/`;
  if (!value.startsWith(prefix)) {
    throw new UnsafeNameError(value, `artifact reference must start with ${prefix}`);
  }
  assertArtifactName(value.slice(prefix.length));
  return value;
}

/** `7, 'report.md'` -> `0007-report.md`, so a directory listing sorts chronologically. */
export function artifactFileName(seq: number, name: string): string {
  const prefix = String(Math.max(0, Math.trunc(seq))).padStart(4, '0');
  return `${prefix}-${assertArtifactName(name)}`;
}

/**
 * Pick a name that is not taken yet: `report.md` -> `report-2.md` -> `report-3.md`.
 * Publishing an artifact must never overwrite an earlier one (docs/TESTS.md MCP-07).
 */
export function uniqueArtifactName(taken: Iterable<string>, name: string): string {
  const existing = new Set(taken);
  if (!existing.has(name)) return assertArtifactName(name);

  const ext = path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  for (let n = 2; n < 10_000; n += 1) {
    const candidate = `${base}-${n}${ext}`;
    if (!existing.has(candidate)) return assertArtifactName(candidate);
  }
  throw new UnsafeNameError(name, 'too many artifacts share this name');
}
