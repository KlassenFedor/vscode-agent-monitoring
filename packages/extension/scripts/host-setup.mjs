import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Prepare what the VS Code host run needs before it starts.
 *
 * Two things, both of which have to exist on disk before Electron launches:
 *
 * 1. A workspace folder. The extension returns immediately when there is none, so a
 *    run without one would pass every test by doing nothing at all.
 * 2. `out/host/package.json`. This repository is ESM everywhere, and the extension host
 *    injects `vscode` through a patched `require` — an ESM `import` of it cannot
 *    resolve. The nearest `package.json` decides the module system for a directory, so
 *    this one marks the compiled host tests, and only them, as CommonJS.
 */
await fs.mkdir(path.join(root, '.vscode-test', 'workspace'), { recursive: true });
await fs.mkdir(path.join(root, 'out', 'host'), { recursive: true });
await fs.writeFile(
  path.join(root, 'out', 'host', 'package.json'),
  `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`,
  'utf8',
);
