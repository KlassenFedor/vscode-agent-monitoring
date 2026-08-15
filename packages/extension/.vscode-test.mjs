import { defineConfig } from '@vscode/test-cli';

/**
 * The one test run that starts a real VS Code.
 *
 * Everything testable without it lives in `src/core/**` and is covered by vitest in
 * seconds (`EXT-15` keeps it that way). What is left here is the wiring: commands that
 * are declared but never registered, settings nobody reads, a webview that never opens.
 * That class of bug is invisible to every other test in this repository.
 */
export default defineConfig({
  files: 'out/host/**/*.test.js',
  workspaceFolder: '.vscode-test/workspace',
  mocha: {
    ui: 'bdd',
    // Downloading and starting VS Code dominates; the assertions themselves are quick.
    timeout: 60_000,
  },
});
