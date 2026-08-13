/**
 * Child process used by the concurrency test.
 *
 * Runs the real appender in a separate process, which is the only way to exercise
 * the cross-process lock: an in-process test would be served by the promise queue
 * alone and prove nothing about the lock file (TESTS.md PROTO-30).
 */
import { JsonlAppender } from '../../src/jsonl.js';

const [filePath, countText, tag] = process.argv.slice(2);
if (!filePath || !countText || !tag) {
  throw new Error('usage: append-worker <file> <count> <tag>');
}

const count = Number.parseInt(countText, 10);
const appender = new JsonlAppender(filePath, { lockTimeoutMs: 30_000 });

for (let index = 0; index < count; index += 1) {
  await appender.append((seq) => ({
    seq,
    ts: new Date().toISOString(),
    type: 'progress',
    title: `${tag}-${index}`,
    tag,
  }));
}
