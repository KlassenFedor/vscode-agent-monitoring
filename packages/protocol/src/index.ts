/**
 * On-disk protocol for Agent Monitor sessions.
 *
 * Everything that reads or writes `.agent-monitor/` goes through this package, so
 * the layout described in DESIGN.md §2 has exactly one implementation.
 */
export {
  CorruptFileError,
  LockTimeoutError,
  ProtocolError,
  RecordTooLargeError,
  UnsafeNameError,
  ValidationError,
} from './errors.js';

export { createManualClock, systemClock } from './clock.js';
export type { Clock, ManualClock } from './clock.js';

export { readJsonFile, writeFileAtomic, writeJsonAtomic } from './atomic.js';

export { withFileLock } from './lock.js';
export type { LockOptions } from './lock.js';

export { JsonlAppender, MAX_RECORD_BYTES, readJsonl } from './jsonl.js';
export type { JsonlAppenderOptions, JsonlChunk } from './jsonl.js';

export {
  ARTIFACTS_DIR,
  CURSOR_FILE,
  EVENTS_FILE,
  INBOX_FILE,
  META_FILE,
  MONITOR_DIR,
  PROTOCOL_VERSION,
  SESSIONS_DIR,
  artifactFileName,
  artifactRef,
  artifactsDir,
  assertArtifactName,
  assertArtifactRef,
  assertSessionId,
  assertWorkspaceLink,
  cursorPath,
  eventsPath,
  inboxPath,
  isSafeArtifactName,
  isSafeSessionId,
  lockPathFor,
  metaPath,
  monitorDir,
  resolveArtifactPath,
  resolveWorkspaceLink,
  sessionDir,
  sessionsDir,
  uniqueArtifactName,
} from './paths.js';

export {
  AGENT_KINDS,
  COMMENT_KINDS,
  EVENT_TYPES,
  SESSION_STATUSES,
  normalizeTimestamp,
  parseComment,
  parseCursor,
  parseEvent,
  parseMeta,
} from './schema.js';
export type {
  AgentEvent,
  AgentKind,
  Comment,
  CommentInput,
  CommentKind,
  Cursor,
  EventInput,
  EventType,
  OpenRecord,
  SessionMeta,
  SessionStatus,
} from './schema.js';

export { SessionStore, findLatestSession, listSessionIds, normalizeRecords } from './session.js';
export type { SessionInit, SessionStoreOptions, WrittenArtifact } from './session.js';

export {
  claimCurrentSession,
  currentSessionPath,
  parseCurrentSession,
  readCurrentSession,
} from './current.js';
export type { ClaimOptions, CurrentSession } from './current.js';

export { paragraphs, renderComments } from './render.js';
export type { RenderOptions } from './render.js';
