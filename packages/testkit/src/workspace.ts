import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface TempWorkspace {
  root: string;
  cleanup(): Promise<void>;
}

/**
 * A throwaway workspace directory.
 *
 * Every test owns one, which is what lets the suite run in parallel without tests
 * seeing each other's sessions (TESTS.md §1.3).
 */
export async function makeWorkspace(prefix = 'agent-monitor-'): Promise<TempWorkspace> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return {
    root,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}
