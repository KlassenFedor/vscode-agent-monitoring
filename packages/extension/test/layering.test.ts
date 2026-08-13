import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const coreDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'core');

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(full)));
    else if (entry.name.endsWith('.ts')) files.push(full);
  }
  return files;
}

describe('layering', () => {
  it('keeps the core free of the vscode API', async () => {
    // Everything interesting — the model, the watcher, rendering, the setup writer —
    // lives in core precisely so it can be tested without a VS Code host. An import
    // of `vscode` here would quietly move that logic out of reach of this suite.
    for (const file of await sourceFiles(coreDir)) {
      const source = await fs.readFile(file, 'utf8');
      expect(source, path.relative(coreDir, file)).not.toMatch(/from ['"]vscode['"]/);
    }
  });
});
