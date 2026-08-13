import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const src = (pkg: string): string =>
  fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  // Tests run against the TypeScript sources, not the build output, so a red test
  // always points at the code that was just edited rather than a stale dist/.
  resolve: {
    alias: {
      '@agent-monitor/protocol': src('protocol'),
      '@agent-monitor/testkit': src('testkit'),
      '@agent-monitor/mcp-server': src('mcp-server'),
      '@agent-monitor/hook': src('hook'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    // Каждый тест владеет своим tmpdir (TESTS.md §1.3), поэтому файлы можно
    // гонять параллельно. Внутри файла — последовательно, так проще читать падения.
    fileParallelism: true,
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: 'v8',
      // Only the protocol package carries a coverage threshold: it is pure logic and
      // the cost of a bug there is highest (docs/TESTS.md §7).
      include: ['packages/protocol/src/**'],
      // Re-export barrel, nothing to cover.
      exclude: ['packages/protocol/src/index.ts'],
      thresholds: { lines: 90, functions: 90, branches: 85 },
    },
  },
});
