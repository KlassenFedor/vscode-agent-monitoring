import { build } from 'esbuild';

/**
 * Three bundles ship in the VSIX:
 *
 * - `extension.cjs` — loaded by VS Code, which requires CommonJS and provides `vscode`
 *   at runtime, so that module stays external;
 * - `mcp-server.cjs` and `hook.cjs` — spawned by the agents. Bundling them is what lets
 *   the setup command point the agents at absolute paths inside the installed
 *   extension, with no npm install and no `npx` in the loop.
 */
const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info',
};

await build({
  ...shared,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.cjs',
  external: ['vscode'],
});

await build({
  ...shared,
  entryPoints: ['../mcp-server/src/cli.ts'],
  outfile: 'dist/mcp-server.cjs',
});

await build({
  ...shared,
  entryPoints: ['../hook/src/cli.ts'],
  outfile: 'dist/hook.cjs',
});
