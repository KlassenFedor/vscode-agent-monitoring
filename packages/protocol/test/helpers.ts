import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach } from 'vitest';

const created: string[] = [];

/**
 * Fresh temporary workspace root, removed after the test file finishes.
 *
 * Every test owns its own directory so the whole suite can run in parallel
 * (docs/TESTS.md §1.3).
 */
export async function makeRoot(prefix = 'agent-monitor-'): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  created.push(root);
  return root;
}

afterEach(async () => {
  while (created.length > 0) {
    const root = created.pop();
    if (root) await fs.rm(root, { recursive: true, force: true });
  }
});

export async function readText(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf8');
}

export async function writeText(filePath: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, 'utf8');
}

export async function appendText(filePath: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, text, 'utf8');
}

export async function fileSize(filePath: string): Promise<number> {
  return (await fs.stat(filePath)).size;
}

/** Count the lines that parse as JSON, i.e. the records a reader would accept. */
export async function countValidLines(filePath: string): Promise<number> {
  const text = await readText(filePath);
  let valid = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      JSON.parse(line);
      valid += 1;
    } catch {
      // counted by the caller through the total line count
    }
  }
  return valid;
}

/** Minimal event payload; individual tests override what they care about. */
export function eventInput(overrides: Record<string, unknown> = {}): {
  type: 'progress';
  title: string;
} & Record<string, unknown> {
  return { type: 'progress', title: 'milestone', ...overrides };
}

export function commentInput(overrides: Record<string, unknown> = {}): {
  kind: 'steer';
  text: string;
} & Record<string, unknown> {
  return { kind: 'steer', text: 'do not touch legacy/', ...overrides };
}
