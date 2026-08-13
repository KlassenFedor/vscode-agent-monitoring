/**
 * An agent that keeps publishing until it is killed.
 *
 * Used by the crash scenario: the parent sends SIGKILL at an arbitrary moment, which
 * is the only way to get a process killed *during* a write rather than between two
 * of them.
 */
import { SessionStore } from '@agent-monitor/protocol';

const [root, sessionId, countText] = process.argv.slice(2);
if (!root || !sessionId) throw new Error('usage: busy-agent <root> <session-id> [count]');

const store = SessionStore.open(root, sessionId);
await store.init({ agent: 'claude', cwd: root });

const count = Number.parseInt(countText ?? '2000', 10);
for (let index = 0; index < count; index += 1) {
  await store.appendEvent({
    type: 'progress',
    title: `milestone ${index}`,
    summary: 'x'.repeat(500),
  });
  process.stdout.write(`${index}\n`);
}
