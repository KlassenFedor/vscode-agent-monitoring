import { renderComments, type Comment, type SessionStore } from '@agent-monitor/protocol';

import { resolveExistingSession, resolveOrCreateSession, type HookContext, type HookIo } from './context.js';
import { additionalContext, block, note, SILENT, type HookResult } from './output.js';
import { parsePayload, type HookPayload } from './payload.js';

/**
 * Minimum gap between two injections of context.
 *
 * The hook runs after every single tool call, and every injection costs the agent
 * context window. Comments are not dropped by the debounce, only delayed to the next
 * tool call after the window (TESTS.md HOOK-05).
 */
export const DEFAULT_DEBOUNCE_MS = 5_000;

/** Called once when the agent session starts: create the session and claim its id. */
export async function sessionStart(io: HookIo): Promise<HookResult> {
  const payload = parsePayload(io.stdin);
  const context = await resolveOrCreateSession(io, payload);
  return { ...SILENT, stderr: `agent-monitor: session ${context.sessionId} ready\n` };
}

/**
 * Called after every tool use: hand the agent whatever the human has said.
 *
 * This is the channel that does not depend on the agent choosing to look. A [stop]
 * comment blocks instead of being injected, because "stop" is not something to
 * mention in passing.
 */
export async function postTool(io: HookIo): Promise<HookResult> {
  const payload = parsePayload(io.stdin);
  const context = await resolveExistingSession(io, payload);
  if (!context.store) return SILENT;

  if (await isDebounced(context, io)) return SILENT;

  const unread = await context.store.unreadComments();
  if (unread.length === 0) return SILENT;

  const stopIndex = unread.findIndex((comment) => comment.kind === 'stop');
  const delivered = stopIndex >= 0 ? unread.slice(0, stopIndex + 1) : unread;
  const eventName = payload.hook_event_name ?? 'PostToolUse';

  const outcome =
    stopIndex >= 0
      ? block(
          renderComments(delivered, {
            heading: 'The human asked you to stop and wait. Do not continue until they say otherwise.',
          }),
        )
      : additionalContext(
          eventName,
          renderComments(delivered, {
            heading: `The human left ${delivered.length === 1 ? 'a comment' : 'comments'} while you were working:`,
          }),
        );

  return { ...outcome, commit: () => commitDelivered(context, delivered) };
}

/**
 * Called when the agent is about to finish its turn.
 *
 * Undelivered comments block the stop: a comment written while the agent was wrapping
 * up would otherwise be read only after the human had already lost the turn.
 */
export async function stop(io: HookIo): Promise<HookResult> {
  const payload = parsePayload(io.stdin);
  const context = await resolveExistingSession(io, payload);
  if (!context.store) return SILENT;

  const unread = await context.store.unreadComments();
  if (unread.length > 0) {
    return {
      ...block(
        renderComments(unread, {
          heading: 'Before you finish, the human left this:',
        }),
      ),
      commit: () => commitDelivered(context, unread),
    };
  }

  const meta = await context.store.readMeta();
  if (meta?.status === 'working') {
    await context.store.patchMeta({ status: 'waiting_review' });
  }
  return SILENT;
}

/**
 * Codex's `notify` program, which is passed a JSON argument rather than stdin.
 *
 * Codex has no equivalent of PostToolUse, so this only keeps the session status
 * honest; feedback there travels over the MCP tools instead (DESIGN.md §4.2).
 */
export async function notify(io: HookIo): Promise<HookResult> {
  // Flags are ownership markers written by the setup command, never payload.
  const raw = io.argv.find((argument) => !argument.startsWith('--')) ?? io.stdin;
  const payload = parsePayload(raw ?? '');
  const context = await resolveExistingSession(io, payload);
  if (!context.store) return SILENT;

  const type = typeof payload.type === 'string' ? payload.type : '';
  if (type === 'agent-turn-complete') {
    const meta = await context.store.readMeta();
    if (meta?.status === 'working') await context.store.patchMeta({ status: 'waiting_review' });
  }
  return SILENT;
}

async function isDebounced(context: HookContext, io: HookIo): Promise<boolean> {
  const store = context.store as SessionStore;
  const debounceMs = readDebounceMs(io);
  if (debounceMs <= 0) return false;

  const cursor = await store.readCursor();
  if (!cursor.last_drain_at) return false;

  const elapsed = context.clock.now() - Date.parse(cursor.last_drain_at);
  return Number.isFinite(elapsed) && elapsed >= 0 && elapsed < debounceMs;
}

function readDebounceMs(io: HookIo): number {
  const raw = io.env.AGENT_MONITOR_DEBOUNCE_MS?.trim();
  if (raw === undefined || raw === '') return DEFAULT_DEBOUNCE_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_DEBOUNCE_MS;
}

async function commitDelivered(context: HookContext, delivered: readonly Comment[]): Promise<void> {
  const store = context.store as SessionStore;
  const highest = delivered.reduce((max, comment) => Math.max(max, comment.seq), 0);
  await store.commitCursor(highest, { last_drain_at: context.clock.iso() });
}

export type { HookPayload };
export { note };
